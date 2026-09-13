/**
 * 一份真 Minecraft 客户端进程:拉起来、连同一个服务器、盯着它的窗口。
 * 两种用法共用这一份——**观察者摄像机**(附身 bot,窗口即"主视角"画面)与
 * **人类玩家**(自己进服跟她一起玩)。
 *
 * 与 mc-server 同一套 phase 机器(state/start/stop + 健康探测)。
 * 健康判据是"窗口出现了没":客户端没有可探的端口,而画面只在有窗口时存在。
 *
 * 进服之后做什么(附身、传送到 bot 旁边)不在这里下命令:那要么走服务器控制台、
 * 要么走 bot 的聊天权限,两者都是 World 层的东西,由 world.ts 编排。
 *
 * 窗口起来后把标题改成这份客户端的账号名,OBS 按标题就能和另一份分开。
 * 直连进服时游戏会自己 updateTitle 一次,隔一段再写回;之后不再保活。
 */
import { logLines } from '../../core/ipc-logger.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../../core/types.ts';
import { buildClientLaunch, soleVersionId } from './client-launch.ts';
import { applyChatVisible, applyLaunchOptions, applySpectatorPlusConfig } from './client-options.ts';
import { applySkins } from './client-skins.ts';
import { findWindow, setWindowTitle } from './window.ts';

type ClientPhase = 'stopped' | 'starting' | 'running' | 'error';

export interface ClientState {
  phase: ClientPhase;
  /** 配置里开着(World 启动时会自动拉起);关着也仍可在面板里手动启停 */
  enabled: boolean;
  detail: string | null;
  pid: number | null;
  /** 窗口已出现(画面可抓) */
  windowReady: boolean;
  /** 当前进程所用目录；停机时为下一次启动的配置目录。 */
  gameDir: string;
  versionId: string;
  username: string;
  /** 游戏目录与版本齐备 */
  configured: boolean;
  /** 供控制台预览的命令行;解析失败时为 null。 */
  command: string | null;
}

export interface GameClientOptions {
  /** 日志与状态里怎么称呼这一份客户端(「观察者客户端」/「玩家客户端」) */
  label: string;
  enabled: () => boolean;
  gameDir: () => string;
  versionId: () => string;
  javaPath: () => string;
  /** 额外 JVM 参数,空格分隔 */
  jvmArgs: () => string;
  username: () => string;
  width: () => number;
  height: () => number;
  /** 进游戏直连服务器 */
  autoJoin: () => boolean;
  server: () => { host: string; port: number };
  /**
   * 启动前调整该游戏目录的设置:关 pauseOnLostFocus(切走时不弹暂停菜单),
   * 并按 syncGui 写 SpectatorPlus 的同步屏幕开关。
   */
  noPauseOnLostFocus: () => boolean;
  /**
   * GUI 演出:开着则 bot 开箱子/合成/熔炉时,SpectatorPlus 把那张界面同步到
   * 摄像机画面上(配合 show 节拍才像人)。只在启动时写入,客户端重启生效。
   * 不给按关处理(玩家客户端用不上)。
   */
  syncGui?: () => boolean;
  /**
   * 启动前把 chatVisibility 掰回 FULL:与摄像机共用一个游戏目录的那份客户端才要,
   * 否则摄像机为画面干净关掉的聊天会让人连命令行都打不开。
   */
  chatUsable: () => boolean;
  /**
   * 启动前按账号名把选中的皮肤铺进这份游戏目录。离线服的玩家档案里没有材质,
   * 皮肤全靠客户端侧的 CustomSkinLoader 读本地文件,而两份客户端各渲染各的:
   * 她和玩家两个账号的皮肤在每一份游戏目录里都要有。
   */
  skins?: () => Array<{ username: string; bytes: Buffer }>;
  /** 异常退出后的自动重启上限；0 或省略时不重启。人为 stop() 永不重启。 */
  restartMax?: () => number;
  /** 第一次重启前等多久,之后逐次加倍 */
  restartBackoffMs?: number;
  /**
   * 崩溃计数的滚动窗口。上一次崩溃过了这么久还没再崩,计数从头起——
   * 「重启成功后归零」只能这么兑现:窗口起来 5 秒又崩仍是风暴,不算活过来。
   */
  restartWindowMs?: number;
  /** 非人为退出时报一次。attempt=第几次重启,0=不再重启(没开或已到上限) */
  onCrash?: (info: { detail: string; attempt: number; max: number; delayMs: number }) => void;
  /** World 是否正在关闭。关闭期的 Ctrl+C 按正常退出处理，不报故障或安排重启；省略时视为未关闭。 */
  shuttingDown?: () => boolean;
  log: Logger;
  /** 窗口出现(自动重启后再次就绪也会来) */
  onReady?: () => void;
  /** 测试注入:替换 spawn 目标,跳过版本 JSON 解析 */
  commandOverride?: { command: string; args: string[] };
  windowPollMs?: number;
  windowTimeoutMs?: number;
  /**
   * 直连进服后游戏会自己 updateTitle 一次,隔这么久再写回账号名。
   * 之后默认不再换世界,不再保活。
   */
  titleSettleMs?: number;
  /** 测试注入:窗口是否已出现 */
  findWindow?: (opts: { ownerPid: number }) => Promise<boolean>;
  /** 测试注入:改标题 */
  setWindowTitle?: (opts: { ownerPid: number; title: string; log?: Logger }) => Promise<boolean>;
}

/** OBS 用来区分两份客户端的窗口标题:账号名。空名字不改。 */
export function clientWindowTitle(username: string): string | null {
  const title = username.trim();
  return title || null;
}

/**
 * 非正常退出时给一句人话。Windows 的原生崩溃码是 32 位 NTSTATUS,十进制看不出所以然,
 * 而 0xC0000005(真崩)与 0xC000013A(Ctrl+C 关窗)十进制长得几乎一样,曾被当成同一回事。
 */
const NATIVE_EXIT_REASONS: Record<number, string> = {
  0xc0000005: '原生访问违例:多数是显卡驱动(看 stdout 尾部有没有 NVIDIA/DxPresent 字样);'
    + '若尾部没有驱动信息,再查 java 版本与游戏自带的 LWJGL 对不对得上',
  0xc0000017: '内存不足',
  0xc000013a: '控制台 Ctrl+C 或关窗',
  0xc0000409: '栈缓冲区溢出',
};

/** 控制台 Ctrl+C / 关窗的原生退出码。关机流程里收到它不算崩 */
const CTRL_C_EXIT = 0xc000013a;

/**
 * 非 Windows 上判定"窗口出来了"的日志锚点。原版在 GLFW 建好窗口之后立刻打这一行
 * (`RenderSystem.getBackendDescription()`),一次启动只出现一次,Fabric 与模组不改它。
 *
 * Windows 那条路仍按 ownerPid 找真窗口:同一台机器上还有操作员自己玩的那份客户端时,
 * 除了进程没有第二个凭据分得开两扇窗,日志办不到这件事。
 */
const WINDOW_READY_LINE = /Backend library: LWJGL/;

/** 拼回被切断的锚点行需要的接缝长度,取锚点本身的两倍有余。 */
const WINDOW_SCAN_CARRY = 64;

/**
 * 逐片扫 stdout 找 {@link WINDOW_READY_LINE}。
 *
 * 到达即判,不等轮询时再回头看那 2000 字的日志尾巴:客户端启动期刷屏很快,四秒的
 * 输出装不下,锚点会在两次轮询之间被冲走。`carry` 是上一片的尾巴,负责接住被切成
 * 两段送来的锚点行。
 */
export function scanWindowReady(carry: string, chunk: string): { seen: boolean; carry: string } {
  const scanned = carry + chunk;
  if (WINDOW_READY_LINE.test(scanned)) return { seen: true, carry: '' };
  return { seen: false, carry: scanned.slice(-WINDOW_SCAN_CARRY) };
}

export function explainExit(code: number | null): string {
  if (code === null) return '进程被杀掉(没有退出码)';
  if (code <= 0xffff) return `code=${code}`;
  const reason = NATIVE_EXIT_REASONS[code];
  return `code=${code}(0x${code.toString(16).toUpperCase()})${reason ? `,${reason}` : ''}`;
}

/** 将 natives jar 中的 DLL 解压到 natives 根目录,满足 LWJGL2 加载约定。 */
function prepareNatives(nativeJars: string[], nativesDir: string, log: Logger): void {
  if (nativeJars.length === 0) return;
  mkdirSync(nativesDir, { recursive: true });
  for (const jar of nativeJars) {
    try {
      // Windows 自带的 bsdtar 认 zip;jar 就是 zip
      const proc = spawn('tar', ['-xf', jar, '-C', nativesDir, '*.dll'], { windowsHide: true });
      proc.on('error', () => undefined);
    } catch {
      /* 解不出来就交给 LWJGL 自己从 classpath 解,不致命 */
    }
  }
  // 解出来的 dll 可能带着 windows/x64/... 的路径,摊平到根下
  const flatten = (dir: string, depth: number): void => {
    if (depth > 6 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      try {
        if (statSync(abs).isDirectory()) flatten(abs, depth + 1);
        else if (entry.toLowerCase().endsWith('.dll') && dir !== nativesDir) {
          renameSync(abs, join(nativesDir, entry));
        }
      } catch (err) {
        log.debug?.(`natives 摊平跳过 ${abs}: ${(err as Error).message}`);
      }
    }
  };
  setTimeout(() => flatten(nativesDir, 0), 1_500);
}

export class GameClient {
  private phase: ClientPhase = 'stopped';
  private detail: string | null = null;
  private proc: ChildProcess | null = null;
  private windowReady = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private titleTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** 滚动窗口内的崩溃次数与上一次崩溃时刻(防重启风暴) */
  private crashCount = 0;
  private lastCrashAt = 0;
  private logTail = '';
  /** 非 Windows 的就绪判定:{@link WINDOW_READY_LINE} 在 stdout 上出现过没有。 */
  private windowLineSeen = false;
  /** 跨 chunk 的接缝:锚点那行可能被切成两段送来。只留够拼回一行的长度。 */
  private windowScanCarry = '';
  /** 当前进程启动时使用的目录；配置改动在停止后生效。 */
  private activeGameDir: string | null = null;

  constructor(private readonly opts: GameClientOptions) {}

  /**
   * 给帧源的窗口线索:这一份客户端的进程号,没就绪(或进程已走)时 null。
   * 帧源只认它——同名同标题的第二份客户端(人自己玩的那份)不该被当成她的画面。
   */
  windowHint(): { pid: number } | null {
    const pid = this.proc?.pid;
    return this.windowReady && pid !== undefined ? { pid } : null;
  }

  get running(): boolean {
    return this.proc !== null;
  }

  directory(): string {
    return this.activeGameDir ?? this.opts.gameDir();
  }

  async state(): Promise<ClientState> {
    const gameDir = this.directory();
    const versionId = this.opts.versionId() || (gameDir ? soleVersionId(gameDir) ?? '' : '');
    const launch = this.resolveLaunch(gameDir);
    const broken = 'error' in launch ? launch.error : null;
    return {
      phase: this.phase,
      enabled: this.opts.enabled(),
      detail: this.detail ?? broken,
      pid: this.proc?.pid ?? null,
      windowReady: this.windowReady,
      gameDir,
      versionId,
      username: this.opts.username(),
      configured: broken === null,
      command: 'error' in launch ? null : [launch.command, ...launch.args].join(' '),
    };
  }

  async start(): Promise<ClientState> {
    if (this.phase === 'starting' || this.phase === 'running') return this.state();
    const gameDir = this.opts.gameDir();
    const launch = this.resolveLaunch(gameDir);
    if ('error' in launch) {
      this.phase = 'error';
      this.detail = launch.error;
      return this.state();
    }
    this.activeGameDir = gameDir;
    if ('nativeJars' in launch) prepareNatives(launch.nativeJars, launch.nativesDir, this.opts.log);
    // 要在进程起来之前写好:两份配置都只在启动时读一次,退出时还会整份重写
    if (!this.opts.commandOverride) {
      if (this.opts.noPauseOnLostFocus()) {
        applyLaunchOptions(gameDir, this.opts.log);
        applySpectatorPlusConfig(gameDir, this.opts.log, this.opts.syncGui?.() ?? false);
      }
      if (this.opts.chatUsable()) applyChatVisible(gameDir, this.opts.log);
      const skins = this.opts.skins?.();
      if (skins) applySkins(gameDir, skins, this.opts.log);
    }
    this.logTail = '';
    const proc = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });
    this.proc = proc;
    this.phase = 'starting';
    this.windowReady = false;
    this.windowLineSeen = false;
    this.windowScanCarry = '';
    this.detail = '客户端启动中(要加载资源与着色器)';
    const tail = (chunk: Buffer) => {
      const text = chunk.toString();
      this.logTail = (this.logTail + text).slice(-2000);
      if (this.windowLineSeen) return;
      const scan = scanWindowReady(this.windowScanCarry, text);
      this.windowLineSeen = scan.seen;
      this.windowScanCarry = scan.carry;
    };
    proc.stdout?.on('data', tail);
    proc.stderr?.on('data', tail);
    logLines(proc.stdout, this.opts.log.child('client'), 'debug', 'stdout');
    logLines(proc.stderr, this.opts.log.child('client'), 'debug', 'stderr');
    proc.on('error', (err) => {
      if (this.proc !== proc) return;
      this.fail(`进程启动失败: ${err.message}`);
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.windowReady = false;
      if (this.phase === 'stopped') return; // 人为停止、正常退出及关闭期的 Ctrl+C 均不触发故障重启。
      if (code === 0 || (code === CTRL_C_EXIT && this.opts.shuttingDown?.())) {
        this.clearTimer();
        this.phase = 'stopped';
        this.detail = null;
        this.activeGameDir = null;
        this.opts.log.info(`${this.opts.label}正常退出(${explainExit(code)}),不重启`);
        return;
      }
      const detail = `客户端退出 ${explainExit(code)};完整日志 ${this.gameLogPath()};stdout 末尾: ${this.logTail.slice(-400)}`;
      this.opts.log.emit('error', `${this.opts.label}进程退出`, { event: 'exit', data: { exitCode: code, gameLog: this.gameLogPath() } });
      this.fail(detail);
      // 只有「进程自己死了」这一条走自动重启:spawn 失败与等窗口超时都不是崩溃,
      // 前者是配置坏了、后者进程还活着,重启它们只会撞同一堵墙。
      this.scheduleRestart(detail);
    });
    this.opts.log.info(`${this.opts.label}启动中 pid=${proc.pid}`);
    this.beginWindowPolling();
    return this.state();
  }

  async stop(): Promise<ClientState> {
    this.clearTimer();
    this.phase = 'stopped';
    this.detail = null;
    this.windowReady = false;
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null) {
      try { proc.kill(); } catch { /* 已退出 */ }
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* 已退出 */ }
          resolve();
        }, 5_000);
        proc.once('exit', () => {
          clearTimeout(force);
          resolve();
        });
      });
      this.opts.log.info(`${this.opts.label}已关闭`);
    }
    this.activeGameDir = null;
    return this.state();
  }

  private resolveLaunch(gameDir = this.directory()): ReturnType<typeof buildClientLaunch> | { command: string; args: string[]; cwd: string | undefined } {
    if (this.opts.commandOverride) {
      return { command: this.opts.commandOverride.command, args: this.opts.commandOverride.args, cwd: undefined };
    }
    const server = this.opts.server();
    return buildClientLaunch({
      gameDir,
      versionId: this.opts.versionId(),
      javaPath: this.opts.javaPath(),
      username: this.opts.username(),
      jvmArgs: this.opts.jvmArgs().split(/\s+/).filter(Boolean),
      width: this.opts.width(),
      height: this.opts.height(),
      joinServer: this.opts.autoJoin() ? server : null,
    });
  }

  private beginWindowPolling(): void {
    this.clearTimer();
    const interval = this.opts.windowPollMs ?? 4_000;
    const deadline = Date.now() + (this.opts.windowTimeoutMs ?? 180_000);
    this.pollTimer = setInterval(async () => {
      const pid = this.proc?.pid;
      if (this.phase !== 'starting' || pid === undefined) {
        this.clearTimer();
        return;
      }
      const seen = await this.windowSeen(pid);
      if (seen) {
        if (this.phase !== 'starting') return;
        this.phase = 'running';
        this.detail = null;
        this.windowReady = true;
        this.clearTimer();
        this.opts.log.info(`${this.opts.label}窗口已就绪`);
        if (process.platform !== 'win32') {
          this.opts.log.warn(`${this.opts.label}窗口标题改不了(只有 Windows 那条路能改),`
            + 'OBS 里要靠人自己选窗口,不能按账号名认。');
        }
        void this.applyWindowTitle();
        if (this.opts.autoJoin()) {
          const settle = this.opts.titleSettleMs ?? 8_000;
          this.titleTimer = setTimeout(() => { void this.applyWindowTitle(); }, settle);
        }
        this.opts.onReady?.();
        return;
      }
      if (Date.now() > deadline) {
        const waited = process.platform === 'win32'
          ? '等窗口超时'
          : `等窗口超时(本平台按 stdout 上的「${WINDOW_READY_LINE.source}」判定)`;
        this.fail(`${waited};完整日志 ${this.gameLogPath()};stdout 末尾: ${this.logTail.slice(-400)}`);
      }
    }, interval);
  }

  /**
   * 窗口出来了没有。Windows 问 user32 要 ownerPid 名下的可见窗口;别的平台没有这条路,
   * 退到"进程还活着 + stdout 打过建窗那行"。后者认不出是谁的窗口,所以只在 user32
   * 够不着的平台上用。
   */
  private async windowSeen(pid: number): Promise<boolean> {
    if (this.opts.findWindow) return this.opts.findWindow({ ownerPid: pid });
    if (process.platform === 'win32') return findWindow({ ownerPid: pid, log: this.opts.log });
    return this.proc?.exitCode === null && this.windowLineSeen;
  }

  /** 游戏自己那份日志。原生崩溃一个字都不往 stdout 打,崩因只在这个文件里。 */
  private gameLogPath(): string {
    return join(this.directory(), 'logs', 'latest.log');
  }

  private async applyWindowTitle(): Promise<void> {
    const title = clientWindowTitle(this.opts.username());
    const pid = this.proc?.pid;
    if (!title || pid === undefined) return;
    const set = this.opts.setWindowTitle ?? setWindowTitle;
    const ok = await set({ ownerPid: pid, title, log: this.opts.log });
    if (ok) this.opts.log.info(`${this.opts.label}窗口标题已设为 ${title}`);
  }

  /** 异常退出按配置指数退避重启；相邻崩溃间隔超过 restartWindowMs 时重置计数，超过重启上限后停止重试并报告。 */
  private scheduleRestart(detail: string): void {
    const max = this.opts.restartMax?.() ?? 0;
    const windowMs = this.opts.restartWindowMs ?? 600_000;
    const now = Date.now();
    if (this.lastCrashAt > 0 && now - this.lastCrashAt > windowMs) this.crashCount = 0;
    this.lastCrashAt = now;
    this.crashCount += 1;
    if (max <= 0 || this.crashCount > max) {
      this.opts.onCrash?.({ detail, attempt: 0, max, delayMs: 0 });
      return;
    }
    const delayMs = (this.opts.restartBackoffMs ?? 30_000) * 2 ** (this.crashCount - 1);
    this.opts.onCrash?.({ detail, attempt: this.crashCount, max, delayMs });
    this.opts.log.info(`${this.opts.label}将在 ${Math.round(delayMs / 1000)} 秒后自动重启(第 ${this.crashCount}/${max} 次)`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.phase === 'stopped') return; // 等的这段里人自己来关了
      void this.start();
    }, delayMs);
    this.restartTimer.unref?.();
  }

  private clearTimer(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.titleTimer) clearTimeout(this.titleTimer);
    this.titleTimer = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private fail(detail: string): void {
    this.clearTimer();
    this.phase = 'error';
    this.detail = detail;
    this.windowReady = false;
    if (this.proc === null) this.activeGameDir = null;
    // 观察者窗口中断影响播出画面，按 error 记录。
    this.opts.log.error(`${this.opts.label}异常: ${detail}`);
  }
}
