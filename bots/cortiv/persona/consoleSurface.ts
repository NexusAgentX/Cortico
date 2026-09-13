/**
 * Persona自报的控制面——工作区编辑器、记忆概览、版本历史。
 *
 * 写的语义(提交给谁、冲突怎么算)是这份人格自己的选择:git、operator 署名、
 * sha256 内容指纹当 baseRevision。Memory 页按 CortiV 的真实记忆画
 * (workspace 文件、viewers/ 人物档案、宪法),不假装有 MEMORY 0–4。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { WorldPanelDecl, PersonaConsoleDecl } from 'cortico/core/types.ts';
import type { GitWorkspaceMemory } from '../../cormini/persona/memory.ts';
import { AUTHOR_OPERATOR } from '../../cormini/persona/workspaceGit.ts';
import { VIEWERS_DIR, viewerMemoryNote } from './viewers.ts';

export const PERSONA_PANELS: WorldPanelDecl[] = [
  {
    id: 'workspace',
    title: '工作区',
    description: '保存时以 operator 署名提交到工作区的 Git 仓库。',
  },
  {
    id: 'memory',
    title: 'Memory',
    description: '工作区文件、人物档案 viewers/、宪法此刻装着什么。',
  },
  {
    id: 'history',
    title: '版本历史',
    description: 'workspace/ 这个 git 仓的提交流水与逐次 diff;某个版本的全文也在这里取。',
  },
];

const FILE_MAX_BYTES = 1024 * 1024;
const VIEWER_LIST_CAP = 80;

function revisionOf(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export interface WorkspaceNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size?: number;
  mtime?: string;
  children?: WorkspaceNode[];
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

export interface PersonaConsoleDeps {
  /** Persona持有的那份记忆(版本历史在 `memory.git`) */
  memory: GitWorkspaceMemory;
}

function visible(name: string): boolean {
  return !name.startsWith('.') && !name.includes('.tmp-');
}

function buildTree(absDir: string, rel: string): WorkspaceNode[] {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: WorkspaceNode[] = [];
  for (const e of entries) {
    if (!visible(e.name)) continue;
    const path = rel ? `${rel}/${e.name}` : e.name;
    const abs = join(absDir, e.name);
    if (e.isDirectory()) {
      nodes.push({ name: e.name, path, type: 'dir', children: buildTree(abs, path) });
      continue;
    }
    if (!e.isFile()) continue;
    const node: WorkspaceNode = { name: e.name, path, type: 'file' };
    try {
      const st = statSync(abs);
      node.size = st.size;
      node.mtime = st.mtime.toISOString();
    } catch {
      // readdir 与 stat 之间文件可能消失
    }
    nodes.push(node);
  }
  nodes.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
  return nodes;
}

function commitNote(hash: string | null, ok: string): string {
  return hash ? `${ok}并提交(${hash})` : `${ok}(git 未提交:无改动或不可用)`;
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`缺少 ${what}`);
  return v.trim();
}

function optRevision(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

const conflict = (error: string, currentRevision?: string): WorkspaceWriteResult =>
  currentRevision === undefined
    ? { ok: false, conflict: true, error }
    : { ok: false, conflict: true, error, currentRevision };

function checkBase(
  ws: GitWorkspaceMemory,
  path: string,
  baseRevision: string | null,
  verb: '保存' | '删除' | '改名',
): WorkspaceWriteResult | null {
  if (baseRevision === null) return null;
  const abs = ws.resolveSafe(path);
  if (!existsSync(abs) || statSync(abs).isDirectory()) {
    return conflict('文件已被移动或删除');
  }
  const current = revisionOf(readFileSync(abs));
  if (current !== baseRevision) {
    return verb === '保存'
      ? conflict(`文件已在别处被修改，请重新载入后再${verb}`, current)
      : conflict(`文件已在别处被修改，请重新载入后再${verb}`);
  }
  return null;
}

function readFilePanel(ws: GitWorkspaceMemory, rel: string): WorkspaceFile {
  const path = ws.normalize(rel);
  const abs = ws.resolveSafe(path);
  if (!existsSync(abs)) throw new Error(`文件不存在:${path}`);
  const st = statSync(abs);
  if (st.isDirectory()) throw new Error(`${path} 是目录,不是文件`);
  if (st.size > FILE_MAX_BYTES) throw new Error('文件超过1MB,拒绝预览');
  const buf = readFileSync(abs);
  if (buf.includes(0)) throw new Error('二进制文件,拒绝预览');
  return {
    path,
    content: buf.toString('utf8'),
    revision: revisionOf(buf),
    size: st.size,
    mtime: st.mtime.toISOString(),
  };
}

function writeFilePanel(deps: PersonaConsoleDeps, args: unknown[]): WorkspaceWriteResult {
  const [rawPath, content, base, createOnly] = args;
  const path = str(rawPath, 'path');
  if (typeof content !== 'string') throw new Error('content 必须是字符串');
  if (content.includes('\0')) throw new Error('文本不能包含 NUL 字符');
  if (Buffer.byteLength(content, 'utf8') > FILE_MAX_BYTES) {
    throw new Error('文件超过1MB，拒绝保存');
  }
  const ws = deps.memory;
  const git = ws.git;
  if (createOnly === true && ws.exists(path)) {
    return conflict('同名文件已经存在');
  }
  const blocked = checkBase(ws, path, optRevision(base), '保存');
  if (blocked) return blocked;
  ws.writeFileAtomic(path, content);
  const hash = git.commitAll(`控制台编辑 ${ws.normalize(path)}`, AUTHOR_OPERATOR);
  return { ok: true, result: commitNote(hash, '已保存'), revision: revisionOf(content) };
}

function removeFilePanel(deps: PersonaConsoleDeps, args: unknown[]): WorkspaceWriteResult {
  const path = str(args[0], 'path');
  const ws = deps.memory;
  const git = ws.git;
  const blocked = checkBase(ws, path, optRevision(args[1]), '删除');
  if (blocked) return blocked;
  ws.deleteFile(path);
  const hash = git.commitAll(`控制台删除 ${ws.normalize(path)}`, AUTHOR_OPERATOR);
  return { ok: true, result: commitNote(hash, '已删除'), revision: '' };
}

function renameFilePanel(deps: PersonaConsoleDeps, args: unknown[]): WorkspaceWriteResult {
  const from = str(args[0], 'from');
  const to = str(args[1], 'to');
  const ws = deps.memory;
  const git = ws.git;
  const blocked = checkBase(ws, from, optRevision(args[2]), '改名');
  if (blocked) return blocked;
  ws.renameFile(from, to);
  const hash = git.commitAll(
    `控制台改名 ${ws.normalize(from)} → ${ws.normalize(to)}`,
    AUTHOR_OPERATOR,
  );
  return { ok: true, result: commitNote(hash, '已改名'), revision: '' };
}

function countFiles(absDir: string): number {
  let n = 0;
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!visible(e.name)) continue;
    const abs = join(absDir, e.name);
    if (e.isDirectory()) n += countFiles(abs);
    else if (e.isFile()) n += 1;
  }
  return n;
}

function memoryState(ws: GitWorkspaceMemory): MemoryState {
  const constitutionAbs = join(ws.memoryDir, 'CONSTITUTION.md');
  let constitutionChars = 0;
  try {
    constitutionChars = readFileSync(constitutionAbs, 'utf8').trim().length;
  } catch {
    constitutionChars = 0;
  }

  const bySource = new Map<string, number>();
  const archives: ViewerArchive[] = [];
  let total = 0;
  let truncated = false;
  const viewersAbs = join(ws.memoryDir, VIEWERS_DIR);
  if (existsSync(viewersAbs) && statSync(viewersAbs).isDirectory()) {
    for (const sourceEnt of readdirSync(viewersAbs, { withFileTypes: true })) {
      if (!sourceEnt.isDirectory() || !visible(sourceEnt.name)) continue;
      const sourceDir = join(viewersAbs, sourceEnt.name);
      for (const fileEnt of readdirSync(sourceDir, { withFileTypes: true })) {
        if (!fileEnt.isFile() || !visible(fileEnt.name) || !fileEnt.name.endsWith('.md')) continue;
        total += 1;
        bySource.set(sourceEnt.name, (bySource.get(sourceEnt.name) ?? 0) + 1);
        if (archives.length >= VIEWER_LIST_CAP) {
          truncated = true;
          continue;
        }
        const path = `${VIEWERS_DIR}/${sourceEnt.name}/${fileEnt.name}`;
        let summary = '';
        try {
          summary = readFileSync(join(sourceDir, fileEnt.name), 'utf8')
            .split('\n').map((l) => l.trim()).find(Boolean) ?? '';
        } catch {
          summary = '';
        }
        archives.push({ source: sourceEnt.name, path, summary });
      }
    }
  }
  archives.sort((a, b) => a.path.localeCompare(b.path));

  return {
    workspaceFiles: countFiles(ws.memoryDir),
    topLevel: ws.listDir(''),
    constitutionChars,
    viewers: {
      total,
      bySource: [...bySource.entries()]
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => a.source.localeCompare(b.source)),
      archives,
      truncated,
    },
    note: viewerMemoryNote(),
  };
}

export function personaConsoleDecl(deps: PersonaConsoleDeps): PersonaConsoleDecl {
  const ws = deps.memory;
  const git = ws.git;
  return {
    panels: PERSONA_PANELS,
    invoke: async (panel: string, method: string, args: unknown[]): Promise<unknown> => {
      if (panel === 'workspace') {
        switch (method) {
          case 'tree':
            return { nodes: buildTree(ws.memoryDir, ''), root: ws.memoryDir };
          case 'read':
            return readFilePanel(ws, str(args[0], 'path'));
          case 'write':
            return writeFilePanel(deps, args);
          case 'remove':
            return removeFilePanel(deps, args);
          case 'rename':
            return renameFilePanel(deps, args);
          case 'history':
            return { commits: git.log({ path: str(args[0], 'path'), limit: 100 }) };
          case 'diff':
            return { diff: git.diff(str(args[0], 'hash'), { path: str(args[1], 'path') }) };
          case 'at':
            return { content: git.fileAt(str(args[0], 'hash'), str(args[1], 'path')) };
          default:
            throw new Error(`未知面板方法: ${panel}.${method}`);
        }
      }
      if (panel === 'memory') {
        if (method === 'state') return memoryState(ws);
        throw new Error(`未知面板方法: ${panel}.${method}`);
      }
      if (panel === 'history') {
        switch (method) {
          case 'state': {
            const path = typeof args[0] === 'string' && args[0].trim() ? args[0].trim() : undefined;
            return {
              status: git.status(),
              commits: git.log(path ? { path, limit: 100 } : { limit: 100 }),
              path: path ?? '',
            };
          }
          case 'diff': {
            const path = typeof args[1] === 'string' && args[1].trim() ? args[1].trim() : undefined;
            return { diff: git.diff(str(args[0], 'hash'), path ? { path } : undefined) };
          }
          case 'at':
            return { content: git.fileAt(str(args[0], 'hash'), str(args[1], 'path')) };
          default:
            throw new Error(`未知面板方法: ${panel}.${method}`);
        }
      }
      throw new Error(`未知面板: ${panel}`);
    },
  };
}
