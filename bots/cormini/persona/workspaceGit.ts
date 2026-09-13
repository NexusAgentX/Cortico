/**
 * 用 git 维护工作区的版本历史 —— `GitWorkspaceMemory` 的成员。
 *
 * 工作区是一个独立的 git 仓(与项目根无关):
 *  - 她自己的落笔提交一次,author=self;控制台的编辑/删除立即提交,author=operator
 *  - 首次打开控制台时幂等 init,当前干净态打 checkpoint0
 *  - 历史/diff = git log/show;checkpoint = git tag,回滚 = reset --hard 到某 tag
 *
 * 全部经 execFileSync 调 git(`-C` workspace)。父进程里的 GIT_DIR / GIT_WORK_TREE
 * 不带进子进程——启动器跑在项目仓里时,那些变量会把命令指到项目根,
 * `git config` 就会报 not in a git directory 并把整个 bot 拖死。
 *
 * git 不可用或建仓失败时 available/isRepo 为假:写路径跳过提交(文件本身照写),
 * 读路径抛可读错误。
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 仓自带的两份附件,新建仓与老仓都幂等补齐。
 * `* -text` 关掉行尾改写:她的笔记与台本里有靠原样文本对齐的地方,git 不该替她改。
 */
const REPO_FILES: ReadonlyArray<readonly [string, string]> = [
  ['.gitignore', '# workspace 版本管理:忽略原子写临时文件\n*.tmp-*\n'],
  ['.gitattributes', '# 行尾一律原样:笔记里有靠原文对齐的地方,git 不替她改写\n* -text\n'],
];

/** 超过这个时长没动过的索引锁按死锁处理。自己串行提交,单实例锁挡住了第二个进程。 */
const STALE_INDEX_LOCK_MS = 60_000;

export interface GitAuthor {
  name: string;
  email: string;
}

export const AUTHOR_OPERATOR: GitAuthor = { name: 'operator', email: 'operator@persona.local' };
/**
 * 她自己的笔记写入(记忆工具与后台整理都算);与操作员的编辑分开署名,
 * 历史页一眼看得出是谁改的。合并前 corti-soulmate 叫它 AUTHOR_BOT,是同一个概念的两个名字。
 */
export const AUTHOR_SELF: GitAuthor = { name: 'corti', email: 'corti@persona.local' };

export interface CommitInfo {
  hash: string;
  fullHash: string;
  author: string;
  email: string;
  date: string;
  message: string;
}

/** 一次提交里某个文件的增删行数(`--numstat`);二进制文件 git 报 `-`,这里是 null。 */
export interface CommitFileStat {
  path: string;
  added: number | null;
  removed: number | null;
}

export interface CommitStat extends CommitInfo {
  files: CommitFileStat[];
}

export interface CheckpointInfo {
  name: string;
  message: string;
  hash: string;
  date: string;
}

export interface GitStatus {
  available: boolean;
  repo: boolean;
  dirty: boolean;
  head: string | null;
  lastCommit: CommitInfo | null;
  tags: string[];
  /** 建仓失败原因(null = 正常);仓半建/属主问题在这里现形,不再静默。 */
  initError: string | null;
  /**
   * 最近一次提交失败的原因(null = 正常)。仓是好的、但某次写入没记上历史
   * (索引锁残留、盘满、属主变更)——这条路以前整段被吞掉,文件照写而历史停更。
   */
  commitError: string | null;
}

const FS = '\x1f';
const RS = '\x1e';
const LOG_FMT = `%H${FS}%an${FS}%ae${FS}%aI${FS}%s${RS}`;

/**
 * revision(commit hash / tag / `HEAD~1`)来自控制台的 query,先卡形状。
 *
 * 关键不是"怕注入 shell"(execFileSync 没有 shell),而是**怕它被 git 当选项读**:
 * `git show --output=<file>` 会把 diff 写到任意文件——一个读接口就成了写原语。
 * 所以两道:字形不许以 `-` 开头,命令里再加 `--end-of-options`(git ≥2.24)。
 *
 * 不许出现 `:`——`fileAt` 把 revision 和路径拼成 `rev:path`,冒号能挪走分界。
 */
function assertRevision(rev: string): string {
  if (!rev || rev.length > 200 || rev.startsWith('-') || !/^[\w./\-~^{}@一-鿿]+$/.test(rev)) {
    throw new Error(`revision 形状不合法:${rev}`);
  }
  return rev;
}

/** checkpoint 名(tag)同样先卡形状:不以 `-` 开头,只留安全字形 */
function assertTagName(name: string): string {
  if (!name || name.startsWith('-') || !/^[\w.\-一-鿿]+$/.test(name)) {
    throw new Error(`checkpoint 名只能含字母数字、下划线、点、连字符或中文:${name}`);
  }
  return name;
}

export class WorkspaceGit {
  readonly dir: string;
  private availCache: boolean | null = null;
  private repoCache: boolean | null = null;
  /** 最近一次建仓失败的原因;null = 没失败过。进 status() 供控制台展示。 */
  private initError: string | null = null;
  private warnedInitFail = false;
  /** 最近一次提交失败的原因;成功一次就清空。进 status() 供控制台展示。 */
  private commitError: string | null = null;
  /** 已经说过的提交失败原因:同一条不刷屏(她每写一个文件就提交一次)。 */
  private warnedCommitError: string | null = null;
  private readonly warn: (msg: string, data?: unknown) => void;

  constructor(workspaceDir: string, warn?: (msg: string, data?: unknown) => void) {
    this.dir = workspaceDir;
    this.warn = warn ?? ((msg, data) => console.warn(`[workspaceGit] ${msg}`, data ?? ''));
  }

  available(): boolean {
    if (this.availCache !== null) return this.availCache;
    try {
      execFileSync('git', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
      this.availCache = true;
    } catch {
      this.availCache = false;
    }
    return this.availCache;
  }

  /**
   * `.git` 存在不等于仓可用:2026-08-16 那次 init 在第一条 `git config` 就死了
   * (目录属主是 BUILTIN\Administrators,git 判 dubious ownership),留下一个
   * 半建仓卡了五天——所以这里必须真问一次 git,不能只看目录。
   */
  isRepo(): boolean {
    if (!existsSync(join(this.dir, '.git'))) return false;
    if (this.repoCache !== null) return this.repoCache;
    try {
      this.run(['rev-parse', '--git-dir']);
      this.repoCache = true;
    } catch {
      this.repoCache = false;
    }
    return this.repoCache;
  }

  /**
   * 只留下找 git 二进制需要的 PATH,把会改「当前仓」的 GIT_* 剥掉。
   * 启动器从项目仓拉起时,Cursor / 外壳常带着 GIT_DIR=.git(相对项目根)。
   */
  private gitEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      const upper = key.toUpperCase();
      if (
        upper === 'GIT_DIR' ||
        upper === 'GIT_WORK_TREE' ||
        upper === 'GIT_INDEX_FILE' ||
        upper === 'GIT_OBJECT_DIRECTORY' ||
        upper === 'GIT_ALTERNATE_OBJECT_DIRECTORIES' ||
        upper === 'GIT_COMMON_DIR' ||
        upper === 'GIT_PREFIX'
      ) {
        delete env[key];
      }
    }
    return env;
  }

  private run(args: string[]): string {
    // safe.directory 走命令行(protected config 之一):workspace 可能属主是
    // BUILTIN\Administrators(dubious ownership),没有这条 init 之后所有命令全灭。
    // 每次调用都钉死 -C,env 已剥净,放开 * 不会波及别的仓。
    // quotepath=false:她的笔记文件名大量是中文,默认会被转义成 \344\275 那种八进制,
    // 历史页与 --numstat 的路径就对不上了。走命令行,新旧仓一视同仁。
    return execFileSync('git', ['-C', this.dir, '-c', 'safe.directory=*', '-c', 'core.quotepath=false', ...args], {
      cwd: this.dir,
      env: this.gitEnv(),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  }

  /**
   * 同 `run`,但不阻塞事件循环。她每写一个文件就提交一次,而在这台机器上一次
   * `add -A` + `commit` 走满 744 个文件要三百多毫秒——同步做会在直播中一次次
   * 卡住主循环。调用方负责串行(git 索引不容并发)。
   */
  private runAsync(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-C', this.dir, '-c', 'safe.directory=*', '-c', 'core.quotepath=false', ...args],
        { cwd: this.dir, env: this.gitEnv(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
  }

  private authorArgs(a: GitAuthor): string[] {
    return ['-c', `user.name=${a.name}`, '-c', `user.email=${a.email}`];
  }

  /** 幂等初始化:无 .git 则 git init + .gitignore + 首个 commit + tag checkpoint0。 */
  /** 幂等补齐仓的附件;已存在的不动。老仓也走这里,所以 `.gitattributes` 是补发的。 */
  private ensureRepoFiles(): void {
    for (const [name, body] of REPO_FILES) {
      const file = join(this.dir, name);
      if (!existsSync(file)) writeFileSync(file, body, 'utf8');
    }
  }

  /**
   * 残留的索引锁。Ctrl+C 打在 commit 中间就会留下它,之后每次提交都失败——
   * 而提交失败以前是静默的,一整场的历史会停在那一刻没人知道。
   */
  private clearStaleIndexLock(): void {
    const lock = join(this.dir, '.git', 'index.lock');
    try {
      const age = Date.now() - statSync(lock).mtimeMs;
      if (age < STALE_INDEX_LOCK_MS) return;
      rmSync(lock, { force: true });
      this.warn('清掉残留的 git 索引锁(上一次提交被打断)', { dir: this.dir, ageMs: Math.round(age) });
    } catch { /* 没有锁,或读不到:照常往下走 */ }
  }

  init(): { created: boolean } {
    if (!this.available() || this.isRepo()) return { created: false };
    this.ensureRepoFiles();
    this.run(['init']); // 对半建仓幂等:重跑 init 不动已有对象,后面把没走完的步骤补齐
    this.repoCache = null;
    if (!this.isRepo()) throw new Error(`git init 之后 ${this.dir} 里仓不可用`);
    this.run(['config', 'core.autocrlf', 'false']);
    this.run(['config', 'core.safecrlf', 'false']);
    this.run(['add', '-A']);
    this.run([
      ...this.authorArgs(AUTHOR_OPERATOR),
      'commit', '--allow-empty', '-m', 'checkpoint0:出厂/重置后的干净状态',
    ]);
    // annotated tag 的 tagger 同样取 user.name/user.email:机器上没配全局身份时
    // (干净的 CI runner 就是)不带这两条,git tag -a 会以「Committer identity unknown」直接失败。
    this.run([
      ...this.authorArgs(AUTHOR_OPERATOR),
      'tag', '-a', 'checkpoint0', '-m', '出厂/重置后的干净状态(init 自动)',
    ]);
    return { created: true };
  }

  /** 需要提交或读历史时再建仓;失败不抛——文件照写,历史页显示未建仓。 */
  ensureRepo(): void {
    if (!this.available()) return;
    this.clearStaleIndexLock();
    try {
      this.init();
      this.initError = null;
      if (this.isRepo()) this.ensureRepoFiles(); // 老仓补发 .gitattributes
    } catch (e) {
      // 建仓失败不挡读写,但必须出声:上一次它一声不吭,半建仓卡了五天没人发现
      this.initError = e instanceof Error ? e.message : String(e);
      if (!this.warnedInitFail) {
        this.warnedInitFail = true;
        this.warn('workspace 建仓失败(文件照写,版本历史不可用)', { dir: this.dir, err: this.initError });
      }
    }
  }

  dirty(): boolean {
    if (!this.available() || !this.isRepo()) return false;
    try {
      return this.run(['status', '--porcelain']).trim() !== '';
    } catch {
      return false;
    }
  }

  /**
   * 提交失败必须出声。仓是好的、这一次没记上历史——索引锁残留、盘满、属主变更
   * 都走这条路。以前它整段被吞:文件照写、历史停更,一场直播下来才发现。
   * 同一条原因只说第一次(她每写一个文件就提交一次),成功一次就清账。
   */
  private noteCommitFailure(e: unknown): null {
    this.commitError = e instanceof Error ? e.message : String(e);
    if (this.warnedCommitError !== this.commitError) {
      this.warnedCommitError = this.commitError;
      this.warn('workspace 提交失败(文件已落盘,这一次没进版本历史)', { dir: this.dir, err: this.commitError });
    }
    return null;
  }

  private noteCommitOk(): void {
    this.commitError = null;
    this.warnedCommitError = null;
  }

  commitAll(message: string, author: GitAuthor): string | null {
    this.ensureRepo();
    if (!this.available() || !this.isRepo()) return null;
    try {
      this.run(['add', '-A']);
      if (this.run(['status', '--porcelain']).trim() === '') {
        this.noteCommitOk();
        return null;
      }
      this.run([...this.authorArgs(author), 'commit', '-m', message]);
      const hash = this.run(['rev-parse', '--short', 'HEAD']).trim();
      this.noteCommitOk();
      return hash;
    } catch (e) {
      return this.noteCommitFailure(e);
    }
  }

  /** `commitAll` 的不阻塞版本。同一个仓上必须串行调用。 */
  async commitAllAsync(message: string, author: GitAuthor): Promise<string | null> {
    this.ensureRepo();
    if (!this.available() || !this.isRepo()) return null;
    try {
      await this.runAsync(['add', '-A']);
      if ((await this.runAsync(['status', '--porcelain'])).trim() === '') {
        this.noteCommitOk();
        return null;
      }
      await this.runAsync([...this.authorArgs(author), 'commit', '-m', message]);
      const hash = (await this.runAsync(['rev-parse', '--short', 'HEAD'])).trim();
      this.noteCommitOk();
      return hash;
    } catch (e) {
      return this.noteCommitFailure(e);
    }
  }

  log(opts?: { path?: string; limit?: number }): CommitInfo[] {
    this.ensureRepo();
    if (!this.available() || !this.isRepo()) return [];
    const args = ['log', `--pretty=format:${LOG_FMT}`, `-n${opts?.limit ?? 50}`];
    if (opts?.path) args.push('--', opts.path);
    let out = '';
    try { out = this.run(args); } catch { return []; }
    return this.parseLog(out);
  }

  /**
   * 带增删行数的提交流水。她自己查笔记历史时,「这一版比上一版少了 350 行」才是
   * 她要的信号——光有 hash 和时刻,看不出笔记是哪一次缩水的。
   *
   * 记录分隔符放在**每条记录前面**:`--numstat` 的行紧跟在该条的 pretty 头之后,
   * 分隔符前置才能让 split 之后「首行=头,其余行=numstat」对齐到同一条提交。
   */
  logStat(opts?: { path?: string; limit?: number }): CommitStat[] {
    this.ensureRepo();
    if (!this.available() || !this.isRepo()) return [];
    const args = [
      // quotepath 默认开着,`地图.md` 在 numstat 行里会印成 "\345\234\260…",
      // 按路径挑本文件那一档就永远挑不中。全部 -c 都排在子命令之前才生效。
      '-c', 'core.quotepath=false',
      'log', `--pretty=format:${RS}%H${FS}%an${FS}%ae${FS}%aI${FS}%s`,
      '--numstat', `-n${opts?.limit ?? 20}`,
    ];
    if (opts?.path) args.push('--', opts.path);
    let out = '';
    try { out = this.run(args); } catch { return []; }
    const commits: CommitStat[] = [];
    for (const rec of out.split(RS)) {
      if (!rec.trim()) continue;
      const lines = rec.split(/\r?\n/);
      const [full, an, ae, date, ...rest] = (lines[0] ?? '').split(FS);
      if (!full) continue;
      const files: CommitFileStat[] = [];
      for (const line of lines.slice(1)) {
        const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
        if (!m) continue;
        files.push({
          path: m[3],
          added: m[1] === '-' ? null : Number(m[1]),
          removed: m[2] === '-' ? null : Number(m[2]),
        });
      }
      commits.push({
        hash: full.slice(0, 8),
        fullHash: full,
        author: an ?? '',
        email: ae ?? '',
        date: date ?? '',
        message: rest.join(FS) ?? '',
        files,
      });
    }
    return commits;
  }

  private parseLog(out: string): CommitInfo[] {
    const commits: CommitInfo[] = [];
    for (const rec of out.split(RS)) {
      const r = rec.replace(/^\s+/, '');
      if (!r) continue;
      const [full, an, ae, date, ...rest] = r.split(FS);
      if (!full) continue;
      commits.push({
        hash: full.slice(0, 8),
        fullHash: full,
        author: an ?? '',
        email: ae ?? '',
        date: date ?? '',
        message: rest.join(FS) ?? '',
      });
    }
    return commits;
  }

  diff(hash: string, opts?: { path?: string }): string {
    this.ensureRepo();
    if (!this.available() || !this.isRepo()) throw new Error('git 不可用');
    const args = [
      'show', '--no-color', '--pretty=format:%H %an %aI%n%s%n',
      '--end-of-options', assertRevision(hash),
    ];
    if (opts?.path) args.push('--', opts.path);
    return this.run(args);
  }

  fileAt(hash: string, path: string): string {
    this.ensureRepo();
    if (!this.available() || !this.isRepo()) throw new Error('git 不可用');
    return this.run(['show', '--end-of-options', `${assertRevision(hash)}:${path}`]);
  }

  listTags(): CheckpointInfo[] {
    if (!this.available() || !this.isRepo()) return [];
    let out = '';
    try {
      out = this.run([
        'for-each-ref', '--sort=-creatordate', 'refs/tags',
        `--format=%(refname:short)${FS}%(contents:subject)${FS}%(objectname:short)${FS}%(creatordate:iso-strict)`,
      ]);
    } catch { return []; }
    const tags: CheckpointInfo[] = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [name, message, hash, date] = line.split(FS);
      let commitHash = hash ?? '';
      try { commitHash = this.run(['rev-parse', '--short', `${name}^{commit}`]).trim(); } catch { /* keep */ }
      tags.push({ name, message: message ?? '', hash: commitHash, date: date ?? '' });
    }
    return tags;
  }

  /**
   * 新建 checkpoint:先提交当前改动(有则提交),再打 annotated tag。
   * 与 `listTags` 一样不 ensureRepo:存档点是对已有历史的操作,不该顺手建仓。
   */
  tag(name: string, message: string, author: GitAuthor = AUTHOR_OPERATOR): void {
    if (!this.available() || !this.isRepo()) throw new Error('git 不可用');
    assertTagName(name);
    if (this.listTags().some((t) => t.name === name)) {
      throw new Error(`checkpoint 已存在:${name}`);
    }
    this.commitAll(`checkpoint「${name}」`, author);
    this.run([...this.authorArgs(author), 'tag', '-a', name, '-m', message || name]);
  }

  deleteTag(name: string): void {
    if (!this.available() || !this.isRepo()) throw new Error('git 不可用');
    if (name === 'checkpoint0') throw new Error('checkpoint0 是出厂基线,不能删除');
    this.run(['tag', '-d', assertTagName(name)]);
  }

  /**
   * 回滚工作区到某 checkpoint(reset --hard tag)。
   * 之后的提交仍可经 reflog 找回;这是一次显式的人工重置。
   */
  checkoutTag(name: string): void {
    if (!this.available() || !this.isRepo()) throw new Error('git 不可用');
    if (!this.listTags().some((t) => t.name === name)) {
      throw new Error(`没有这个 checkpoint:${name}`);
    }
    this.run(['reset', '--hard', name]);
    this.run(['clean', '-fd']); // 清掉 tag 里没有的未跟踪文件,保证与 checkpoint 完全一致
  }

  status(): GitStatus {
    this.ensureRepo();
    const available = this.available();
    const repo = available && this.isRepo();
    if (!repo) {
      return { available, repo: false, dirty: false, head: null, lastCommit: null, tags: [], initError: this.initError, commitError: this.commitError };
    }
    let head: string | null = null;
    try { head = this.run(['rev-parse', '--short', 'HEAD']).trim(); } catch { /* 无提交 */ }
    const last = this.log({ limit: 1 })[0] ?? null;
    const tags = this.listTags().map((t) => t.name);
    return { available, repo: true, dirty: this.dirty(), head, lastCommit: last, tags, initError: this.initError, commitError: this.commitError };
  }
}
