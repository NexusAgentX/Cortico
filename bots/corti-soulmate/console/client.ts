/**
 * corti-soulmate 的浏览器扩展 —— 七个面板，组成同一个人格页。
 *
 * ```
 * persona:corti-soulmate  (Persona.console())  workspace / memory / history
 *                 (consolePages())        checkpoints / reset / dream
 * ```
 *
 * 两组住在同一个 bundle 里:构建脚本按**目录名**推 asset key,`bots/corti-soulmate/console/`
 * 只出得来一份产物。两条声明接缝在装配时合成同一个 `persona:corti-soulmate`，面板键都在
 * 下面这张 `panels` 表里。
 *
 * 这个文件只做两件事:**装配**与**共享 helper**(取数—渲染骨架、错误措辞、
 * 服务端各方法的返回形状)。面板本体各在自己的文件里。
 *
 * 与外界的依赖只有一条:`client-panel.ts` 里的**类型**。没有 `fetch`、没有
 * `document.body`、没有 `window.__*`、没有裸定时器——数据面一律走 `ctx.invoke`,
 * DOM 一律用 `ctx.ui` 的原语,轮询走 `ctx.interval`,防抖走 `ctx.timeout`,
 * 未保存改动走 `ctx.guardLeave`。
 */

import type {
  ConsoleClientBundle,
  ConsolePanelContext,
} from 'cortico/web/shared/client-panel.ts';
import './style.css';
import { workspacePanel } from './workspace.ts';
import { memoryPanel } from './memory.ts';
import { historyPanel } from './history.ts';
import { checkpointsPanel } from './checkpoints.ts';
import { resetPanel } from './reset.ts';
import { dreamPanel } from './dream.ts';

// ---------------------------------------------------------------------------
// 共享类型:`bots/corti-soulmate/persona/consoleSurface.ts` 与 `bots/corti-soulmate/console-page.ts`
// 各方法的返回形状
// ---------------------------------------------------------------------------

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

/** 写/删/改名的回执。`conflict` 那支 = 没做,因为底本变了。 */
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

export interface CheckpointEntry {
  name: string;
  message: string;
  hash: string;
  date: string;
}

export type FileOp = 'read' | 'write' | 'append' | 'rename' | 'delete';

export interface PermissionCell {
  allowed: FileOp[];
  denied: Array<{ op: FileOp; reason: string }>;
}

export interface PermissionRow {
  zone: string;
  label: string;
  cells: PermissionCell[];
}

export interface MemoryTier {
  id: string;
  title: string;
  detail: string;
  live: string;
}

export interface MemoryState {
  tiers: MemoryTier[];
  memo: {
    residentCap: number;
    activeCap: number;
    resident: string[];
    active: string[];
    archived: number;
  };
  matrix: {
    roles: string[];
    rows: PermissionRow[];
    constitutionProposalPending: boolean;
  };
}

export interface Applied<S> {
  ok: true;
  result: string;
  state: S;
}

export interface CheckpointsState {
  status: MediumStatus;
  checkpoints: CheckpointEntry[];
}

export interface StoragePartInfo {
  key: string;
  label: string;
  kind: 'disk' | 'memory';
  location?: string;
  danger?: boolean;
  note?: string;
}

export interface ResetState {
  status: MediumStatus;
  checkpoints: CheckpointEntry[];
  parts: StoragePartInfo[];
  ready: boolean;
  reason: string | null;
}

export interface ResetResult {
  ok: boolean;
  persona: string;
  results: Array<{ key: string; ok: boolean; result: string }>;
}

export interface DreamState {
  dreaming: boolean;
}

/** `dream.trigger` 的回执:一句原样显示的话 + 触发之后的状态(省一次往返)。 */
export interface DreamTriggered {
  ok: boolean;
  message: string;
  state: DreamState;
}

// ---------------------------------------------------------------------------
// 共享 helper
// ---------------------------------------------------------------------------

/** 错误 → 一句人话。`ConsoleInvokeError` 带的就是服务端的措辞。 */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 改写一条 `msgline` 的正文与配色(那一行是活的,每次操作都改)。 */
export function setMsg(el: HTMLElement, text: string, bad = false): void {
  el.textContent = text;
  el.classList.toggle('bad', bad);
}

export interface AutoloadOptions<T> {
  loading: string;
  failed: string;
  load(): Promise<T>;
  /** `reload` 重跑一遍取数与渲染——改完自己的状态之后调它,而不是重挂面板。 */
  render(data: T, reload: () => void): Node[];
}

/**
 * 取数—渲染骨架：空态 → 取数 → 渲染或错误空态。
 * 请求代号防止晚到的旧响应覆盖新响应；unmount 后到达的异步拒绝不再写 DOM。
 */
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

/** 一行灰色小注。 */
export function dimLine(ctx: ConsolePanelContext, text = ''): HTMLElement {
  return ctx.ui.h('div', 'ct-dim', text);
}

/** ISO 时间戳 → `2026-08-12 18:56`,取不到就原样。 */
export function stamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(0, 19).replace('T', ' ');
}

/**
 * git 状态 → 一行人话。存档点、版本历史、工作区三处都要印同一句,
 * 措辞散在三处迟早各说各的。
 */
export function gitLine(st: MediumStatus): string {
  if (!st.available) return 'git 不可用';
  if (!st.repo) return 'persona/ 尚未纳入 git(bot 启动后自动建仓并打 checkpoint0)';
  return `git ${st.head ?? '—'} · ${st.dirty ? '有未提交改动' : '干净'} · ${st.tags.length} 个存档点`;
}

/**
 * 一段 diff → 着色后的 HTML。**只在 `.diffbox` 里用**,那三个 class
 * (`di-add` / `di-del` / `di-hunk`)是控制台既有样式表里的,不是本页自创的。
 */
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

// ---------------------------------------------------------------------------

const bundle: ConsoleClientBundle = {
  /**
   * 键是**局部** panel id。前三个对应 `PERSONA_PANELS`(Persona自报),
   * 后四个对应 `CORTI_OPS_PANELS`(装配层的部署面)。
   * 声明与扩展同进同退:`tests/web/persona-corti-console.test.ts` 拿两份清单对咬。
   */
  panels: {
    workspace: workspacePanel,
    memory: memoryPanel,
    history: historyPanel,
    checkpoints: checkpointsPanel,
    reset: resetPanel,
    dream: dreamPanel,
  },
};

export default bundle;
