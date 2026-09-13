/**
 * 可缇Corti 的浏览器扩展 —— 工作区 / Memory / 版本历史。
 *
 * 三个面板都由 `CortiV.console()` 自报,bundle 目录约定铸成 `persona:cortiv`。
 * 数据面一律走 `ctx.invoke`,DOM 一律用 `ctx.ui`,未保存改动走 `ctx.guardLeave`。
 */

import type {
  ConsoleClientBundle,
  ConsolePanelContext,
} from 'cortico/web/shared/client-panel.ts';
import './style.css';
import { historyPanel } from './history.ts';
import { memoryPanel } from './memory.ts';
import { workspacePanel } from './workspace.ts';

export interface WorkspaceNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size?: number;
  mtime?: string;
  children?: WorkspaceNode[];
}

export interface WorkspaceTree {
  nodes: WorkspaceNode[];
  root: string;
}

export interface WorkspaceFile {
  path: string;
  content: string;
  revision: string;
  size: number;
  mtime: string | null;
}

export type WorkspaceWriteResult =
  | { ok: true; result: string; revision: string }
  | { ok: false; conflict: true; error: string; currentRevision?: string };

export interface Commit {
  hash: string;
  fullHash: string;
  author: string;
  email: string;
  date: string;
  message: string;
}

export interface MediumStatus {
  available: boolean;
  repo: boolean;
  dirty: boolean;
  head: string | null;
  lastCommit: Commit | null;
  tags: string[];
}

export interface ViewerArchive {
  source: string;
  path: string;
  summary: string;
}

export interface MemoryState {
  workspaceFiles: number;
  topLevel: string[];
  constitutionChars: number;
  viewers: {
    total: number;
    bySource: Array<{ source: string; count: number }>;
    archives: ViewerArchive[];
    truncated: boolean;
  };
  note: string;
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function setMsg(el: HTMLElement, text: string, bad = false): void {
  el.textContent = text;
  el.classList.toggle('bad', bad);
}

export interface AutoloadOptions<T> {
  loading: string;
  failed: string;
  load(): Promise<T>;
  render(data: T, reload: () => void): Node[];
}

export function autoload<T>(ctx: ConsolePanelContext, opts: AutoloadOptions<T>): void {
  const { ui, root } = ctx;
  let generation = 0;
  const run = (): void => {
    const gen = ++generation;
    root.replaceChildren(ui.placeholder(opts.loading));
    void opts.load().then(
      (data) => {
        if (gen !== generation || ctx.signal.aborted) return;
        root.replaceChildren(...opts.render(data, run));
      },
      (err: unknown) => {
        if (gen !== generation || ctx.signal.aborted) return;
        root.replaceChildren(ui.placeholder(`${opts.failed}: ${errText(err)}`));
      },
    );
  };
  run();
}

export function dimLine(ctx: ConsolePanelContext, text = ''): HTMLElement {
  return ctx.ui.h('div', 'ct-dim', text);
}

export function stamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(0, 19).replace('T', ' ');
}

export function gitLine(st: MediumStatus): string {
  if (!st.available) return 'git 不可用';
  if (!st.repo) return 'workspace/ 尚未纳入 git(打开控制台后自动建仓并打 checkpoint0)';
  return `git ${st.head ?? '—'} · ${st.dirty ? '有未提交改动' : '干净'} · ${st.tags.length} 个存档点`;
}

export function colorDiff(ctx: ConsolePanelContext, text: string): HTMLElement {
  const box = ctx.ui.h('div', 'diffbox');
  box.innerHTML = String(text || '')
    .split('\n')
    .map((line) => {
      const safe = ctx.ui.esc(line);
      if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="di-add">${safe}</span>`;
      if (line.startsWith('-') && !line.startsWith('---')) return `<span class="di-del">${safe}</span>`;
      if (line.startsWith('@@')) return `<span class="di-hunk">${safe}</span>`;
      return safe;
    })
    .join('\n');
  return box;
}

const bundle: ConsoleClientBundle = {
  panels: {
    workspace: workspacePanel,
    memory: memoryPanel,
    history: historyPanel,
  },
};

export default bundle;
