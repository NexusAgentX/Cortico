/**
 * `GitWorkspaceMemory` —— Persona持有的那份记忆:**这份记忆在磁盘上是什么**。
 *
 * 一句话分界:这里只管**能不能安全地做**,
 * 不管**该不该做**。于是留在Persona的有——
 *  - 权限:`Cormini.writeGuard` / `readOverride` 两个钩子、corti-soulmate 的 `permissions.ts`;
 *  - 内容特判:corti-soulmate 的 `CORE.md`(读这个名字返回软件包里的那份)走 `readOverride`;
 *  - 前缀渲染:`prefixWorkspaceListing` / MEMORY 0~4 / `memoTiers`;
 *  - 工具定义:`workspaceTools.ts` 的七个 ToolDef(schema、usage 文案、回执措辞);
 *  - 清库策略:哪些文件算可清除。
 * 它们一个字也不在这里。反过来,这一层也不持有工具表——那是反向绑定。
 *
 * 本文件由三份平行实现合并而来:cormini 的工具底层(`workspaceTools.ts` 的自由函数)、
 * corti-soulmate 的 `Workspace`、CortiV 的精简 `Workspace`。分歧处取更严格或更完整的那一份,
 * 逐处在注释里写明为什么。版本历史那一半是它的成员 `git`(见 `workspaceGit.ts`)。
 */
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize as pathNormalize, relative, resolve, sep } from 'node:path';
import { MEM_SCHEME, mimeOfHandle } from 'cortico/core/blobs.ts';
import type { BlobStore } from 'cortico/core/types.ts';
import { WorkspaceGit } from './workspaceGit.ts';

/** 工作区层的可预期错误(路径逃逸、文件不存在等),消息可直接作为 tool result */
export class WorkspaceError extends Error {}

/** 二进制工件落在工作区的哪个子目录(不带目录的名字提示进这里) */
export const BLOBS_DIR = 'blobs/';

/** `list_files` 对非指定目录的每个子目录最多列这么多项;余下折叠成一行计数。 */
export const LIST_DIR_CAP = 10;

/** 工作区相对路径 → `mem:` 句柄;路径统一用 `/`。 */
export function memHandle(rel: string): string {
  return `${MEM_SCHEME}${rel.split(sep).join('/')}`;
}

/** 返回使用正斜杠且无冗余分隔的相对路径。 */
export function normalizeWorkspacePath(relPath: string): string {
  let raw = String(relPath ?? '').trim().replace(/\\/g, '/');
  const rooted = raw.startsWith('/');
  raw = raw.replace(/\/{2,}/g, '/');
  const normalized = raw
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
  return rooted ? `/${normalized}` : normalized;
}

/**
 * 工具层的路径护栏:按 `path.normalize` 的结果算,只要落在工作区内就放行
 * (`a/../b` 这种解析后仍在区内的算过关)。写类工具历来走这条,措辞也是它的。
 * 更严的那条是 `resolveSafe`(连 `..` 段本身都拒),两条各有各的调用点,不合并。
 */
function insideWorkspace(root: string, rel: string): string {
  const abs = resolve(root, pathNormalize(rel));
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`path escapes workspace: ${rel}`);
  return abs;
}

/**
 * glob → 正则。支持 `**`(跨目录)、`*`、`?`、`{a,b}`;路径用 `/` 分隔,匹配整条工作区相对路径。
 * 花括号里的备选项按字面处理,不再展开通配符。
 */
export function globToRegExp(glob: string): RegExp {
  const escape = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const close = glob.indexOf('}', i);
      if (close < 0) {
        re += '\\{';
        continue;
      }
      re += `(?:${glob.slice(i + 1, close).split(',').map(escape).join('|')})`;
      i = close;
    } else re += escape(c);
  }
  return new RegExp(`^${re}$`);
}

/** 一个目录的清单行。`full` 为假时只取前 `LIST_DIR_CAP` 项,末尾补一行"共几项、怎么看全"。 */
function listDirLines(abs: string, prefix: string, full: boolean): string[] {
  const names = readdirSync(abs).sort().filter((name) => !name.startsWith('.'));
  const shown = full ? names : names.slice(0, LIST_DIR_CAP);
  const out: string[] = [];
  for (const name of shown) {
    const child = join(abs, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(child).isDirectory()) out.push(...listDirLines(child, rel, false));
    else out.push(rel);
  }
  if (names.length > shown.length) {
    out.push(`${prefix}/ … 共 ${names.length} 项,以上只列了前 ${shown.length} 项;list_files 指定 dir 为 ${prefix} 可列出全部`);
  }
  return out;
}

function walkFilesAbs(dir: string, prefix: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...walkFilesAbs(abs, rel));
    else out.push(rel);
  }
  return out;
}

/** 目录项排序:目录在前,同类按名。树与 listDir 共用这一条。 */
function dirsFirst(a: { name: string; isDirectory(): boolean }, b: { name: string; isDirectory(): boolean }): number {
  return Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name);
}

/** 隐藏文件与原子写的临时文件不进目录视图(与 git 忽略的口径一致)。 */
function visibleEntry(name: string): boolean {
  return !name.startsWith('.') && !name.includes('.tmp-');
}

/**
 * 记忆里的二进制工件后端。
 *
 * `mem:` 句柄 = `mem:` + 工作区相对路径,与 list_files 里看到的路径一致。字节和她的
 * 笔记一样住在工作区,随人格包走。put 的名字提示不带目录时落进 `dir`(缺省 `blobs/`);
 * get 认工作区里任何一个文件,路径逃逸经 insideWorkspace 拒绝。
 */
export class WorkspaceBlobStore implements BlobStore {
  constructor(private readonly root: string, private readonly dir: string = BLOBS_DIR) {}

  put(nameHint: string, bytes: Uint8Array, mime: string): string {
    let rel = pathNormalize(nameHint).split(sep).join('/').replace(/^\.\//, '');
    if (!rel.includes('/')) rel = `${this.dir}${rel}`;
    const abs = insideWorkspace(this.root, rel);
    if (existsSync(abs) && statSync(abs).isDirectory()) throw new Error(`${rel} 是目录`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
    void mime;
    return memHandle(relative(this.root, abs));
  }

  get(handle: string): { bytes: Uint8Array; mime: string } | null {
    const rel = handle.startsWith(MEM_SCHEME) ? handle.slice(MEM_SCHEME.length) : handle;
    if (!rel) return null;
    let abs: string;
    try {
      abs = insideWorkspace(this.root, rel);
    } catch {
      return null;
    }
    if (!existsSync(abs) || statSync(abs).isDirectory()) return null;
    return { bytes: readFileSync(abs), mime: mimeOfHandle(rel) };
  }

  list(prefix: string = this.dir): Array<{ handle: string; mime: string; size: number }> {
    let root: string;
    try {
      root = insideWorkspace(this.root, prefix || '.');
    } catch {
      return [];
    }
    if (!existsSync(root) || !statSync(root).isDirectory()) return [];
    const out: Array<{ handle: string; mime: string; size: number }> = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        if (name.startsWith('.')) continue;
        const abs = join(dir, name);
        const st = statSync(abs);
        if (st.isDirectory()) walk(abs);
        else {
          const rel = relative(this.root, abs);
          out.push({ handle: memHandle(rel), mime: mimeOfHandle(rel), size: st.size });
        }
      }
    };
    walk(root);
    return out;
  }
}

export interface GitWorkspaceMemoryOptions {
  /** 工作区目录 = 记忆。不存在则创建。 */
  memoryDir: string;
  /** 不带目录的名字提示落进哪个工作区子目录。不给 = `blobs/`。 */
  blobsDir?: string;
  /** 版本历史出声的去处(建仓/提交失败);不给 = console.warn。 */
  warn?: (msg: string, data?: unknown) => void;
}

/** 检索命中的一份文件:整份行表 + 命中行号(上下文/计数/只列文件都在这之上拼)。 */
export interface GrepFileHit {
  path: string;
  lines: string[];
  hits: number[];
}

export class GitWorkspaceMemory {
  /** 工作区根目录 = 记忆 */
  readonly memoryDir: string;
  /** 记忆里的二进制工件:工作区 blobs/ 下的文件,`mem:` 句柄即相对路径 */
  readonly blobs: WorkspaceBlobStore;
  /** 这份记忆的版本历史 */
  readonly git: WorkspaceGit;

  constructor(opts: GitWorkspaceMemoryOptions) {
    this.memoryDir = resolve(opts.memoryDir);
    if (!existsSync(this.memoryDir)) mkdirSync(this.memoryDir, { recursive: true });
    this.blobs = new WorkspaceBlobStore(this.memoryDir, opts.blobsDir);
    this.git = new WorkspaceGit(this.memoryDir, opts.warn);
  }

  // -------------------------------------------------------------------------
  // 首次初始化
  // -------------------------------------------------------------------------

  /**
   * 种子文件:不在才写,已有的一个字不动。**内容由调用方给**——哪份文件叫什么、
   * 出厂写什么是人格约定(宪法),不是"记忆在磁盘上是什么"。
   */
  seed(files: ReadonlyArray<readonly [string, string]>): void {
    for (const [rel, body] of files) {
      const abs = this.resolveSafe(rel);
      if (existsSync(abs)) continue;
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body, 'utf8');
    }
  }

  /** 建目录骨架。哪几个目录同样是人格约定,由调用方给。 */
  ensureDirs(dirs: readonly string[]): void {
    for (const d of dirs) {
      mkdirSync(join(this.memoryDir, ...d.split('/').filter(Boolean)), { recursive: true });
    }
  }

  // -------------------------------------------------------------------------
  // 路径安全
  // -------------------------------------------------------------------------

  normalize(relPath: string): string {
    return normalizeWorkspacePath(relPath);
  }

  /**
   * 相对路径 → 绝对路径,拒绝绝对路径(含盘符)与任何 `..` 段。
   * 三份实现里 corti-soulmate 那份最严(连 `a/../b` 这种解析后仍在区内的也拒),合并取它。
   */
  resolveSafe(relPath: string): string {
    const s = this.normalize(relPath);
    if (/^[a-zA-Z]:/.test(s) || s.startsWith('/') || isAbsolute(s)) {
      throw new WorkspaceError(`只接受工作区内的相对路径,不接受绝对路径:${s}`);
    }
    if (s.split('/').some((seg) => seg === '..')) {
      throw new WorkspaceError(`路径不能包含"..",不允许离开工作区:${s}`);
    }
    const abs = resolve(this.memoryDir, s);
    const rel = relative(this.memoryDir, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new WorkspaceError(`路径解析后越出了工作区:${s}`);
    }
    return abs;
  }

  /** 工具层那条较松的护栏(见 `insideWorkspace` 的注释);逃逸抛普通 Error。 */
  insideWorkspace(relPath: string): string {
    return insideWorkspace(this.memoryDir, relPath);
  }

  exists(relPath: string): boolean {
    try {
      return existsSync(this.resolveSafe(relPath));
    } catch {
      return false;
    }
  }

  isDir(relPath: string): boolean {
    try {
      const abs = this.resolveSafe(relPath);
      return existsSync(abs) && statSync(abs).isDirectory();
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // 读写
  // -------------------------------------------------------------------------

  readFile(relPath: string): string {
    const abs = this.resolveSafe(relPath);
    if (!existsSync(abs)) throw new WorkspaceError(`文件不存在:${this.normalize(relPath)}`);
    if (statSync(abs).isDirectory()) {
      throw new WorkspaceError(`${this.normalize(relPath)} 是目录,用 list_dir 查看它`);
    }
    return readFileSync(abs, 'utf8');
  }

  /** 原子写:同目录临时文件再 rename,避免半份正文落盘;失败清掉临时文件(取更完整的那份)。 */
  writeFileAtomic(relPath: string, content: string): void {
    const abs = this.resolveSafe(relPath);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      throw new WorkspaceError(`${this.normalize(relPath)} 是目录,不能作为文件写入`);
    }
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${Math.random().toString(36).slice(2, 8)}`;
    try {
      writeFileSync(tmp, content, 'utf8');
      renameSync(tmp, abs);
    } catch (error) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // 保留原始写入错误。
      }
      throw error;
    }
  }

  /** 追加内容前保证现有文件以换行结尾。 */
  appendFile(relPath: string, content: string): void {
    const abs = this.resolveSafe(relPath);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      throw new WorkspaceError(`${this.normalize(relPath)} 是目录,不能追加`);
    }
    mkdirSync(dirname(abs), { recursive: true });
    let payload = content;
    if (existsSync(abs)) {
      const prev = readFileSync(abs, 'utf8');
      if (prev.length > 0 && !prev.endsWith('\n')) payload = '\n' + payload;
    }
    appendFileSync(abs, payload, 'utf8');
  }

  renameFile(fromRel: string, toRel: string): void {
    const from = this.resolveSafe(fromRel);
    const to = this.resolveSafe(toRel);
    if (!existsSync(from)) throw new WorkspaceError(`文件不存在:${this.normalize(fromRel)}`);
    if (statSync(from).isDirectory()) {
      throw new WorkspaceError(`${this.normalize(fromRel)} 是目录,只能移动文件`);
    }
    if (existsSync(to)) {
      throw new WorkspaceError(`目标已存在:${this.normalize(toRel)},换个名字或先删除它`);
    }
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  }

  deleteFile(relPath: string): void {
    const abs = this.resolveSafe(relPath);
    if (!existsSync(abs)) throw new WorkspaceError(`文件不存在:${this.normalize(relPath)}`);
    if (statSync(abs).isDirectory()) {
      throw new WorkspaceError(`${this.normalize(relPath)} 是目录,只能删除文件`);
    }
    unlinkSync(abs);
  }

  // -------------------------------------------------------------------------
  // 遍历
  // -------------------------------------------------------------------------

  /** 返回一层目录内容;目录带尾部 "/" 并排在文件前。不存在/不是目录都抛(取更严的那份)。 */
  listDir(relPath = ''): string[] {
    const abs = this.resolveSafe(relPath);
    if (!existsSync(abs)) throw new WorkspaceError(`目录不存在:${this.normalize(relPath) || '工作区根'}`);
    if (!statSync(abs).isDirectory()) {
      throw new WorkspaceError(`${this.normalize(relPath)} 是文件,用 read_file 读它`);
    }
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => visibleEntry(e.name))
      .sort(dirsFirst)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  }

  /** `rel` 之下每一个文件的工作区相对路径(含 `rel` 前缀);点开头的整条跳过。 */
  walkFiles(rel = ''): string[] {
    const abs = this.insideWorkspace(rel || '.');
    const prefix = relative(this.memoryDir, abs).split(sep).filter(Boolean).join('/');
    return walkFilesAbs(abs, prefix);
  }

  /**
   * `list_files` 的回执正文。`dir`(相对工作区,空 = 根)本身全量列出;它之下的每个
   * 子目录只列前 `LIST_DIR_CAP` 项,余下折叠成一行计数——几十份交接笔记、几百份人物
   * 档案不该一次撑满回执。要看全部,把那个目录单独指定为 `dir`。
   * 前缀里那份走模板(见 prefixWorkspaceListing),不受此上限约束。
   */
  listing(dir = ''): string {
    const abs = this.insideWorkspace(dir || '.');
    if (!existsSync(abs)) return `[not found] ${dir}`;
    if (!statSync(abs).isDirectory()) return `[not a directory] ${dir}`;
    const rel = relative(this.memoryDir, abs).split(sep).filter((s) => s !== '').join('/');
    const lines = listDirLines(abs, rel, true);
    if (lines.length === 0) return rel ? `${rel}/ is empty.` : 'Your workspace is empty.';
    return `Files in ${rel ? `${rel}/` : 'your workspace'}:\n${lines.map((f) => `- ${f}`).join('\n')}`;
  }

  /** 整棵树的树枝图。 */
  tree(): string {
    const lines: string[] = ['persona/'];
    const walk = (abs: string, prefix: string): void => {
      const entries = readdirSync(abs, { withFileTypes: true })
        .filter((e) => visibleEntry(e.name))
        .sort(dirsFirst);
      entries.forEach((e, i) => {
        const last = i === entries.length - 1;
        lines.push(prefix + (last ? '└── ' : '├── ') + e.name + (e.isDirectory() ? '/' : ''));
        if (e.isDirectory()) walk(join(abs, e.name), prefix + (last ? '    ' : '│   '));
      });
    };
    walk(this.memoryDir, '');
    return lines.join('\n');
  }

  /** MEMORY 0 仅渲染最外层直接子项,防止大型子目录占用常驻前缀。 */
  treeShallow(): string {
    const lines: string[] = ['persona/'];
    for (const e of readdirSync(this.memoryDir, { withFileTypes: true })
      .filter((entry) => visibleEntry(entry.name))
      .sort(dirsFirst)) {
      lines.push(e.isDirectory() ? `${e.name}/` : e.name);
    }
    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // 检索
  // -------------------------------------------------------------------------

  /**
   * 按名找文件的底层:模式匹配整条工作区相对路径,最近改过的在前。
   * 不以 `**` + `/` 开头的模式补上它,所以 `*.md` 找的是整棵树。
   */
  globFiles(pattern: string, dir = ''): string[] {
    const re = globToRegExp(pattern.startsWith('**/') ? pattern : `**/${pattern}`);
    return this.walkFiles(dir)
      .filter((f) => re.test(f))
      .map((f) => ({ f, mtime: statSync(join(this.memoryDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((x) => x.f);
  }

  /**
   * 按内容搜的底层:从 `path`(文件或目录,空 = 整个工作区)起逐文件逐行判定,
   * 交回每个命中文件的整份行表与命中行号——只列文件、按文件计数、带上下文行
   * 都在这之上拼(见 grep_files 工具)。
   *
   * 二进制(字节里含 NUL)整份跳过;原子写的临时文件不进检索(corti-soulmate grepFiles 的
   * 口径,取更严的那份)。换行按 `\r?\n` 切(取更完整的那份:CRLF 的笔记里
   * 行尾的 `\r` 不该跟着进回执)。
   */
  grep(opts: { match: (line: string) => boolean; path?: string; filter?: RegExp | null }): GrepFileHit[] {
    const where = opts.path ?? '';
    const abs = this.insideWorkspace(where || '.');
    const files = statSync(abs).isDirectory()
      ? this.walkFiles(where)
      : [relative(this.memoryDir, abs).split(sep).join('/')];
    const out: GrepFileHit[] = [];
    for (const f of files) {
      if (opts.filter && !opts.filter.test(f)) continue;
      if (f.split('/').some((seg) => seg.includes('.tmp-'))) continue;
      let buf: Buffer;
      try {
        buf = readFileSync(join(this.memoryDir, f));
      } catch {
        continue;
      }
      if (buf.includes(0)) continue;
      const lines = buf.toString('utf8').split(/\r?\n/);
      const hits: number[] = [];
      lines.forEach((l, i) => { if (opts.match(l)) hits.push(i); });
      if (hits.length === 0) continue;
      out.push({ path: f, lines, hits });
    }
    return out;
  }
}
