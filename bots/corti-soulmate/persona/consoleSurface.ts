/**
 * Persona自报的控制面(`Persona.console?()`)——**认知绑定**的那三个面板。
 *
 * 归属判据:
 *
 * - **工作区**:读目录框架本来就能做,但**写**的语义(写完提不提交、提交给谁、
 *   冲突怎么算)是这份人格实现自己的选择——它选了 git、选了 `operator` 署名、
 *   选了 sha256 内容指纹当 baseRevision。一个只能读不能写的工作区没有价值,
 *   所以整块(含目录树)归Persona。
 * - **Memory 分层**:MEMORY 0–4 与写权限矩阵是这份人格实现的设计知识。
 *   第三方人格可能根本不分层,所以这张表由Persona自己声明,而不是硬编码在中央前端里。
 * - **版本历史**:git、快照或无历史由人格实现选择。
 *
 * **部署绑定**的(模型档位 / 存档点 / 统一重置 / 入梦触发)不在这里,它们要写
 * `config.json`、要跨 owner 编排,归装配层的 `ConsoleContribution.consolePages`
 * (见 `bots/corti-soulmate/console-page.ts`)。
 *
 * 这个文件是 **Node 侧**的:它读文件、跑 git。浏览器那一半在 `bots/corti-soulmate/console/`
 * (那个目录名是构建脚本与 tsconfig.web.json 的约定,只放浏览器代码)。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMORY_VAR_DECLS } from './memory.ts';

/** 前缀模板与记忆模板住在软件包里(跟着代码走),不在人格工作区。 */
const CORE_DIR = dirname(fileURLToPath(import.meta.url));

import type { WorldPanelDecl, PersonaConsoleDecl, PromptDocDecl } from 'cortico/core/types.ts';
import type { GitWorkspaceMemory } from '../../cormini/persona/memory.ts';
import { AUTHOR_OPERATOR } from '../../cormini/persona/workspaceGit.ts';
import { MemoTiers } from './memoTiers.ts';
import {
  PERSONA_ROLES, checkAccess,
  type FileOp, type PersonaRole, type Zone,
} from './permissions.ts';

// ---------------------------------------------------------------------------
// 面板声明
// ---------------------------------------------------------------------------

/** 新式对象声明:局部 id + 真标题。id 不带 bot 名前缀,page id 才是命名空间。 */
export const PERSONA_PANELS: WorldPanelDecl[] = [
  {
    id: 'workspace',
    title: '工作区',
    description: 'persona/ 的目录树与编辑器:改一份档案立即提交(署名 operator),保存带冲突检测。',
  },
  {
    id: 'memory',
    title: 'Memory 分层',
    description: 'MEMORY 0–4 各层此刻装着什么,以及两条认知路径(主意识 / 梦)的写权限矩阵(机械硬拦,不是文档)。',
  },
  {
    id: 'history',
    title: '版本历史',
    description: 'persona/ 这个 git 仓的提交流水与逐次 diff;某个版本的全文也在这里取。',
  },
];

// ---------------------------------------------------------------------------
// 与旧 `/api/file` `/api/persona/*` 一字不差的几个常量
// ---------------------------------------------------------------------------

/** 预览和保存的文件大小上限。 */
const FILE_MAX_BYTES = 1024 * 1024;

/**
 * 文件的内容指纹 = 保存时的 `baseRevision`。
 *
 * **算法与口径一个字都不能改**:编辑器载入时拿到的 revision 与保存时服务端重算的
 * 那个必须是同一个函数算出来的,否则每一次保存都会撞上"文件已在别处被修改"。
 */
function revisionOf(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// 返回形状(浏览器那一半 import 不到本文件,两边靠这些注释对齐)
// ---------------------------------------------------------------------------

export interface WorkspaceNode {
  name: string;
  /** 相对 persona/ 的路径,正斜杠 */
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

/** 写/删/改名的回执。`conflict` 那一支是"没做,因为底本变了"。 */
export type WorkspaceWriteResult =
  | { ok: true; result: string; revision: string }
  | { ok: false; conflict: true; error: string; currentRevision?: string };

export interface WorkspaceCommit {
  hash: string;
  fullHash: string;
  author: string;
  email: string;
  date: string;
  message: string;
}

/** 一格权限:允许哪些操作,拒绝的各给一句理由(理由就是 agent 会看到的那句)。 */
export interface PermissionCell {
  allowed: FileOp[];
  denied: Array<{ op: FileOp; reason: string }>;
}

export interface PermissionRow {
  zone: Zone;
  label: string;
  /** 与 `roles` 同序 */
  cells: PermissionCell[];
}

export interface MemoryTier {
  id: string;
  title: string;
  /** 这一层装的是什么(结构说明,不随数据变) */
  detail: string;
  /** 此刻的读数 */
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
    roles: PersonaRole[];
    rows: PermissionRow[];
  };
}

// ---------------------------------------------------------------------------
// 目录树
// ---------------------------------------------------------------------------

/** 隐藏文件与原子写的临时文件不进树(与工作区工具、git 忽略的口径一致)。 */
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
      // readdir 与 stat 之间文件可能消失;少一组读数不影响这一格能不能点开
    }
    nodes.push(node);
  }
  nodes.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
  return nodes;
}

// ---------------------------------------------------------------------------
// 权限矩阵:**算出来的,不是抄下来的**
// ---------------------------------------------------------------------------

/**
 * 每个区域取一个代表路径，逐角色和操作调用 checkAccess 生成权限矩阵。
 */
const ZONE_SAMPLES: Array<{ zone: Zone; label: string; path: string }> = [
  { zone: 'note', label: 'note/(笔记与手册)', path: 'note/sample.md' },
  { zone: 'memo', label: 'memo/(时间性备忘)', path: 'memo/sample.md' },
  { zone: 'people', label: 'people/(人)', path: 'people/sample.md' },
  { zone: 'worldview', label: 'WORLDVIEW.md(综合认知)', path: 'WORLDVIEW.md' },
  { zone: 'constitution', label: 'CONSTITUTION.md(宪法)', path: 'CONSTITUTION.md' },
  { zone: 'external', label: 'external/(World 自己的抽屉)', path: 'external/qq/sample.md' },
  { zone: 'other', label: '其它(自建目录)', path: 'sample.md' },
];

const FILE_OPS: FileOp[] = ['read', 'write', 'append', 'rename', 'delete'];

function permissionMatrix(): MemoryState['matrix'] {
  const rows: PermissionRow[] = ZONE_SAMPLES.map((z) => ({
    zone: z.zone,
    label: z.label,
    cells: PERSONA_ROLES.map((role) => {
      const cell: PermissionCell = { allowed: [], denied: [] };
      for (const op of FILE_OPS) {
        const r = checkAccess(role, op, z.path);
        if (r.ok) cell.allowed.push(op);
        else cell.denied.push({ op, reason: r.reason });
      }
      return cell;
    }),
  }));
  return { roles: [...PERSONA_ROLES], rows };
}

// ---------------------------------------------------------------------------
// 面板实现
// ---------------------------------------------------------------------------

export interface PersonaConsoleDeps {
  /** Persona持有的那份记忆(版本历史在 `memory.git`) */
  memory: GitWorkspaceMemory;
  memo: MemoTiers;
  /** MEMORY 3 此刻的浮现(Persona持有) */
  emergences(): string[];
  /** 首轮对话三份源的声明,由基类按部署目录给出;不给或为空 = 没有首轮对话。 */
  firstTurnDocs?: PromptDocDecl[];
  /**
   * 人格文本(PREFIX / ENV_SECTION / MEMORY)此刻该读的路径与保存路径,由Persona按
   * "部署 prompts/ 覆盖 > 包内默认"解析。不给 = 读写都是包内那份。
   */
  texts?: { path(name: string): string; writePath(name: string): string };
}

/** git 提交与否都要说清楚:没提交时不能让人以为改动进了历史。 */
function commitNote(hash: string | null, ok: string): string {
  return hash ? `${ok}并提交(${hash})` : `${ok}(git 未提交:无改动或不可用)`;
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`缺少 ${what}`);
  return v.trim();
}

/** `baseRevision` 可以不给(新建时就没有底本);给了就必须是字符串。 */
function optRevision(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

const conflict = (error: string, currentRevision?: string): WorkspaceWriteResult =>
  currentRevision === undefined
    ? { ok: false, conflict: true, error }
    : { ok: false, conflict: true, error, currentRevision };

/**
 * 底本核对。**语义与旧的 409 一字不改**,只是承载方式变了:这一页的
 * `invoke` 通道把抛出的错一律压成 500 + 一句话,状态码到不了浏览器,所以"冲突"
 * 改成回执里的一支(`ok:false, conflict:true`)。措辞照抄旧的,连全角逗号都没动
 * ——编辑器上那句提示是用户唯一的线索。
 */
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

function writeFilePanel(
  deps: PersonaConsoleDeps,
  args: unknown[],
): WorkspaceWriteResult {
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

function memoryState(deps: PersonaConsoleDeps): MemoryState {
  const { memory: ws, memo } = deps;
  const resident = memo.residentFiles();
  const active = memo.activeFiles();
  const archived = memo.archivedCount();
  let topLevel = 0;
  try {
    topLevel = ws.listDir('').length;
  } catch {
    topLevel = 0;
  }
  let worldview = '';
  try {
    worldview = ws.readFile('WORLDVIEW.md');
  } catch {
    worldview = '';
  }
  const emergences = deps.emergences();
  return {
    tiers: [
      {
        id: 'MEMORY 0',
        title: '地图',
        detail: 'persona/ 最外层目录 + note/playbook/ 一级条目 + external/qq/images 最近 5 个。地图不是答案,往里翻要用工具。',
        live: `${topLevel} 个顶层条目`,
      },
      {
        id: 'MEMORY 1',
        title: '认知',
        detail: 'WORLDVIEW.md 全文(由梦维护)+ people/ 花名册。',
        live: worldview.trim() ? `WORLDVIEW.md ${worldview.length} 字` : '(还没有 WORLDVIEW.md)',
      },
      {
        id: 'MEMORY 2',
        title: '备忘',
        detail: '常驻 memo/ 全文进前缀;active/ 只列文件名;archived/ 只报数量,正文自己翻。容量由下面两个上限硬拦。',
        live: `常驻 ${resident.length}/${memo.caps.residentCap} · active ${active.length}/${memo.caps.activeCap} · archived ${archived}`,
      },
      {
        id: 'MEMORY 3',
        title: '反射',
        detail: '最近几场梦的浮现。存在人格状态袋里,最多留三缕。',
        live: emergences.length ? `${emergences.length} 缕` : '(此刻没有)',
      },
      {
        id: 'MEMORY 4',
        title: '当下',
        detail: '当前时间与时区。纯机械,每次拼前缀现算。',
        live: '每次组装现算',
      },
    ],
    memo: {
      residentCap: memo.caps.residentCap,
      activeCap: memo.caps.activeCap,
      resident,
      active,
      archived,
    },
    matrix: permissionMatrix(),
  };
}

/**
 * 组装Persona的 `PersonaConsoleDecl`。
 *
 * `invoke` 按 (面板, 方法) 分派,不认识的一律抛——控制台把抛出的错原样显示,
 * 所以措辞要写给人看。
 */
export function personaConsoleDecl(deps: PersonaConsoleDeps): PersonaConsoleDecl {
  const ws = deps.memory;
  const git = ws.git;
  const text = (name: string): { path: string; deploymentPath?: string } => deps.texts
    ? { path: deps.texts.path(name), deploymentPath: deps.texts.writePath(name) }
    : { path: join(CORE_DIR, name) };
  return {
    panels: PERSONA_PANELS,
    promptDocs: [{
      key: 'constitution',
      title: '宪法',
      description: 'Persona的长期原则；重载系统前缀后对当前 session 生效。',
      path: ws.resolveSafe('CONSTITUTION.md'),
    }, {
      key: 'persona.prefix',
      title: '前缀装配',
      description: '整份 system 前缀由哪几段、按什么顺序、用什么分隔线拼成。删掉一个占位符，那一段就不进前缀。',
      ...text('PREFIX.md'),
      role: 'prefix',
      vars: [
        { name: 'persona.orientation', description: 'ORIENTATION.md 全文。', multiline: true },
        { name: 'persona.constitution', description: 'CONSTITUTION.md 全文。', multiline: true },
        { name: 'worlds.envPrompts', description: '各 World 的环境提示词,按 World id 序,每段套「World 段」那份模板。', multiline: true },
        { name: 'persona.toolUsage', description: '工具用法段。**来自代码**(Persona原语的用法),改不了。 World 工具的说明不在这一段——见各 World 自己的环境提示词。', multiline: true },
        { name: 'memory.all', description: 'MEMORY 0~4 整块,内容见「记忆」那份模板。', multiline: true },
      ],
    }, {
      key: 'persona.envSection',
      title: 'World 段',
      description: '每个 World 那一节的外壳（标题与分隔线）。样式归Persona，所以同一个 World 能装在排版不同的人格上。',
      ...text('ENV_SECTION.md'),
      vars: [
        { name: 'world.id', description: 'World id。' },
        { name: 'world.envPrompt', description: '该 World 渲染好的环境提示词。', multiline: true },
      ],
    }, {
      key: 'persona.memory',
      title: '记忆',
      description: 'MEMORY 0~4 的骨架:五层的引导语、小标题与空态措辞。',
      ...text('MEMORY.md'),
      vars: [...MEMORY_VAR_DECLS],
    }, ...(deps.firstTurnDocs ?? [])],
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
          // 某个文件自己的提交流水(编辑器右上角那颗「历史」)
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
        if (method === 'state') return memoryState(deps);
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
