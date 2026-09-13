/**
 * 本地 Minecraft 服务器托管(java -jar server.jar nogui)。
 *
 * 与 client.ts 同一套 phase 机器(state/start/stop + 健康探测),差别在:
 *  - 路径来自配置项(worlds.minecraft.local.serverDir/javaPath),服务器世界放哪
 *    属于部署选择;没配路径时按钮回执提示去配置。
 *  - 健康探测是 TCP 连接(MC 协议无 HTTP)。
 *  - 停止走 stdin "stop"(存档落盘),超时才杀进程。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { connect } from 'node:net';
import type { Logger } from '../../core/types.ts';
import {
  loadProperties, readProperty, saveProperties, settingsFrom, writeProperty,
} from './server-config.ts';
import { readLevelDat } from './level-dat.ts';

export type MinecraftServerPhase = 'stopped' | 'starting' | 'running' | 'error';

export interface MinecraftServerState {
  /** 受管本地服务器的目标开关；未配置本地服务时为 true。 */
  enabled: boolean;
  phase: MinecraftServerPhase;
  address: string;
  detail: string | null;
  pid: number | null;
  /** 端口当下是否可连(外部自行起的服务器也算) */
  reachable: boolean;
  /** 当前托管进程所用目录；停机时为下一次启动的配置目录。 */
  serverDir: string;
  /** 路径配置是否齐备(不齐时前端提示去配置) */
  configured: boolean;
}

interface MinecraftServerOptions {
  /** 受管服务器是否允许启动；未提供时沿用旧行为。 */
  enabled?: () => boolean;
  /** 含 server.jar 的目录(启动前读取配置;'' = 未配置) */
  serverDir: () => string;
  /** java 路径;'' = 自动(serverDir 邻近 jdk → PATH 上的 java) */
  javaPath: () => string;
  /** JVM 参数(内存等),空格分隔 */
  jvmArgs: () => string;
  /** bot 要连的地址(托管只对本机地址有意义,探测也用它) */
  host: () => string;
  port: () => number;
  log: Logger;
  /** 测试注入:替换 spawn 目标 */
  commandOverride?: { command: string; args: string[] };
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
  /** 测试注入:低频存档周期 */
  autoSaveMs?: number;
  /** 相位跃迁回调(starting/running/error/stopped)。世界的生死她必须听得见,不能只进日志。 */
  onPhase?: (phase: MinecraftServerPhase, detail: string | null) => void;
  /**
   * 就绪之后回读一次实际难度的结果(每次 running 一次)。见 `queryDifficulty`。
   * `difficulty: null` = 问了但没问出来(服务端没在期限内回话、或回的话认不出来)。
   */
  onDifficulty?: (fact: MinecraftDifficultyFact) => void;
  /** 测试注入:难度回读的等待上限 */
  difficultyTimeoutMs?: number;
}

/** 回读到的难度事实。全是读数,怎么措辞由消费方决定。 */
export interface MinecraftDifficultyFact {
  /** 规范化后的难度名(peaceful/easy/normal/hard);认不出来 = null */
  difficulty: 'peaceful' | 'easy' | 'normal' | 'hard' | null;
  /** 服务端回的那一行原文(截断);没回话 = null */
  raw: string | null;
  /** 同一刻 server.properties 里的 difficulty=;读不到 = null */
  properties: string | null;
}

/** 世界生成进度行:命中就把就绪期限往后推,原版每加载一段起始区都会打一行 */
const PROGRESS_RE = /Preparing (start region|spawn area)/;
/** 原版启动完成行:「Done (12.345s)! For help, type "help"」 */
const READY_RE = /\bDone \([\d.]+s\)!/;
/** 每见一次进度行给的宽限 */
const PROGRESS_GRACE_MS = 60_000;
/**
 * `difficulty` 查询的回应行。
 *
 * 原版专用服务端控制台打的是 en_us(`commands.difficulty.query` = "The difficulty is %s"),
 * 但服务端换语言包、或第三方核心自带中文的情况都有过,拿不准就两套都认:
 *
 *   en  「The difficulty is Easy」 / 设置后「The difficulty has been set to Easy」
 *   zh  「难度为简单」/「游戏难度为简单」 / 设置后「难度已设置为简单」
 *
 * 行首还有日志前缀(`[12:34:56] [Server thread/INFO]: `),所以不锚定行首。
 */
const DIFFICULTY_REPLY_RE =
  /(?:The difficulty (?:is|has been set to)|(?:游戏)?难度(?:为|已设(?:置|定)为|已设为))\s*([A-Za-z_]+|和平|简单|普通|困难)/;
/** 回读的等待上限:过了还没回话就按「问了没问出来」报,不静默 */
const DIFFICULTY_TIMEOUT_MS = 10_000;

/**
 * 难度名归一。英文与中文译名各一套;认不出来返回 null(不猜)。
 */
function normalizeDifficulty(raw: string): MinecraftDifficultyFact['difficulty'] {
  const zh: Record<string, MinecraftDifficultyFact['difficulty']> = {
    和平: 'peaceful', 简单: 'easy', 普通: 'normal', 困难: 'hard',
  };
  if (zh[raw]) return zh[raw];
  const en = raw.toLowerCase();
  return en === 'peaceful' || en === 'easy' || en === 'normal' || en === 'hard' ? en : null;
}

/** 从服务端一段 stdout 里认出难度回应;认不出返回 null。 */
export function parseDifficultyReply(text: string): { difficulty: MinecraftDifficultyFact['difficulty']; raw: string } | null {
  const m = DIFFICULTY_REPLY_RE.exec(text);
  if (!m) return null;
  return { difficulty: normalizeDifficulty(m[1]), raw: m[0] };
}
/**
 * 按主世界对齐各维度的 keepInventory；Paper/Bukkit 为每个维度独立存储规则。
 * 其余 gamerule 保留各维度设置。
 */
const WORLD_WIDE_GAME_RULES = ['keepInventory'] as const;

/** 待对齐的一个副维度:`id` 给 `execute in` 用,`dir` 是报给人看的目录名 */
interface DimensionRules {
  id: 'minecraft:the_nether' | 'minecraft:the_end';
  dir: string;
  /** 该维度 level.dat 里的 GameRules;null = 读不到(维度没开、或存档还没落盘) */
  rules: Record<string, string> | null;
}

/**
 * 按主世界对齐副维度的 gamerule:出什么指令、哪几条对不上。纯函数,不碰进程。
 *
 * - 主世界那条没写 = 没有"要传播的意图",什么都不做(不拿原版默认值去覆盖别人)。
 * - 副维度读不到 = 说不清,只记一句,不猜也不发指令。
 */
export function planGameRuleAlignment(
  overworld: Record<string, string> | null,
  others: readonly DimensionRules[],
): { commands: string[]; drift: string[] } {
  const commands: string[] = [];
  const drift: string[] = [];
  for (const rule of WORLD_WIDE_GAME_RULES) {
    const want = overworld?.[rule];
    if (want === undefined) continue;
    for (const other of others) {
      if (other.rules === null) {
        drift.push(`${other.dir} 的 ${rule} 读不到(那份 level.dat 还没落盘或维度没开)`);
        continue;
      }
      const has = other.rules[rule];
      if (has === want) continue;
      drift.push(`${other.dir} 的 ${rule}=${has ?? '(没写)'},主世界是 ${want}`);
      commands.push(`execute in ${other.id} run gamerule ${rule} ${want}`);
    }
  }
  return { commands, drift };
}

/** 定期发送 save-all，缩短异常退出时未保存的世界状态窗口。 */
const AUTO_SAVE_MS = 90_000;
/** stop 指令后等它自己存完的上限,超时才 SIGKILL */
const GRACEFUL_EXIT_MS = 15_000;
/**
 * 硬信号兜底要监听的那几个。**这不是正门** —— 正门是控制台的关机键(走 stop()
 * 那条完整路径)。这里管的是"操作员还是手滑关了窗"那一下:
 *
 *   Windows 关命令行窗口 = CTRL_CLOSE_EVENT,Node 映射成 SIGHUP,而系统只给
 *   大约 5 秒就强杀整个控制台进程组。Ctrl+Break 映射成 SIGBREAK(仅 Windows)。
 *
 * 5 秒里能做的只有一件事:立刻把 save-all + stop 写进 java 的 stdin,让它在被杀
 * 之前尽量把区块落盘。所以这里既不清定时器也不改相位 —— 正常收尾路径若还跑得动,
 * 它照常跑完。
 */
const HARD_SIGNALS: NodeJS.Signals[] = process.platform === 'win32'
  ? ['SIGHUP', 'SIGBREAK']
  : ['SIGHUP'];

/** java 可执行文件的文件名。Windows 上带 `.exe`,别处不带。 */
export const JAVA_BINARY = process.platform === 'win32' ? 'java.exe' : 'java';

/** serverDir 邻近的便携 JDK:<serverDir>/../jdk/<任意版本>/bin/<java 可执行文件> */
function findAdjacentJava(serverDir: string): string | null {
  const jdkRoot = join(serverDir, '..', 'jdk');
  if (!existsSync(jdkRoot)) return null;
  for (const entry of readdirSync(jdkRoot)) {
    const candidate = join(jdkRoot, entry, 'bin', JAVA_BINARY);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 世界身份(realm):存档目录里的 cortico-realm.json
// ---------------------------------------------------------------------------

/**
 * 身份标记的文件名。它落在**存档目录**里,不在服务器目录里 —— 于是身份随目录走:
 *
 *  - 目录改名:marker 跟着搬,uuid 不变(同一个世界换了个名字);
 *  - 目录复制:两份同 uuid,即"同一个世界的两个副本"。**不做防重** —— 复制出来的
 *    存档确实继承了原世界的地形、锚点、进度,当作同一个 realm 是对的;
 *  - 同名新建:新目录里没有 marker,于是新发一个 uuid,与旧世界干净地分开。
 *
 * 这三条正是"换世界自动失效"要的语义:缓存按 {realm, key} 键控,旧世界的数据漏不进
 * 新世界(地标泄露那一类 bug 从机制上封死)。
 */
export const REALM_MARKER_FILE = 'cortico-realm.json';

/** 落在存档目录里的那份 JSON。 */
interface RealmMarker {
  /** 机器层的稳定键:首次纳管时随机发一次,之后只读不改 */
  uuid: string;
  /** **首次纳管那一刻**的存档目录名。目录后来改了名,这里就是旧名 —— 只作留痕,
   *  当下的存档名一律以 server.properties 的 level-name 为准(见 `MinecraftRealm.levelName`) */
  levelName: string;
  /** 首次纳管时刻(ISO) */
  createdAt: string;
}

/**
 * 受管世界的身份。
 *
 * **uuid 是机器层的键,任何面向她的文本都不出现 uuid** —— 缓存命名空间、
 * {realm,key} 键控、笔记分目录的机械匹配用它;公告、回执、事件里只出现
 * `levelName`(存档名,人话)。消费方照这条办。
 *
 * `uuid` 为 null = 拿不到强身份(marker 写不进去,例如只读盘)。此时消费方按弱身份
 * 兜底即可,别把 null 当成"同一个 realm"。
 *
 * 远程服务器(mc-server 根本不受管、bridge 直连外部)拿不到这个对象——`realm()`
 * 返回 null,弱身份 `host:port + 存档名` 由消费方自己拼。
 */
interface MinecraftRealm {
  /** 受管世界的稳定 uuid;marker 读写不成时为 null */
  uuid: string | null;
  /** 当下的存档目录名(server.properties 的 level-name);对她只说这个 */
  levelName: string;
}

function realmMarkerPath(worldDir: string): string {
  return join(worldDir, REALM_MARKER_FILE);
}

/** 读存档目录里的身份标记;没有、或人手改坏了都返回 null(调用方当作没纳管过)。 */
export function readRealmMarker(worldDir: string): RealmMarker | null {
  const file = realmMarkerPath(worldDir);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const { uuid, levelName, createdAt } = parsed as Record<string, unknown>;
    if (typeof uuid !== 'string' || !uuid.trim()) return null;
    return {
      uuid,
      levelName: typeof levelName === 'string' ? levelName : '',
      createdAt: typeof createdAt === 'string' ? createdAt : '',
    };
  } catch {
    return null;
  }
}

/**
 * 纳管一份存档:有 marker 就原样沿用(**不重写**,改名后那份旧名照留,它记的是
 * "第一次见到这个世界"那一刻),没有就发一个新 uuid 写进去。
 *
 * 存档目录还不存在时会先建出来 —— 第一次启动的世界要到服务端跑起来才有 level.dat,
 * 而身份得在那之前就定下。空目录对原版无害(listWorlds 也只认有 level.dat 的)。
 *
 * 写不进去(只读盘等)会**抛**;调用方自己决定降级成什么。
 */
function ensureRealmMarker(worldDir: string, levelName: string): RealmMarker {
  const existing = readRealmMarker(worldDir);
  if (existing) return existing;
  const marker: RealmMarker = { uuid: randomUUID(), levelName, createdAt: new Date().toISOString() };
  mkdirSync(worldDir, { recursive: true });
  writeFileSync(realmMarkerPath(worldDir), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  return marker;
}

export class MinecraftServerManager {
  private phase: MinecraftServerPhase = 'stopped';
  private detail: string | null = null;
  private proc: ChildProcess | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private logTail = '';

  private saveTimer: ReturnType<typeof setInterval> | null = null;
  /** 就绪期限:世界生成有进度就往后推,不让固定闸门杀掉正在干活的服务端 */
  private healthDeadline = 0;
  /** 已装上的硬信号兜底监听;没有托管进程时为 null(不占监听位) */
  private hardSignalHook: (() => void) | null = null;
  /** 世界身份缓存,按存档目录键控:换存档自然重算 */
  private realmCache: { worldDir: string; realm: MinecraftRealm } | null = null;
  /** 托管进程使用的目录；运行期间配置改动留到下次启动。 */
  private activeServerDir: string | null = null;
  /** marker 写不进去只报一次,别让每次查身份都刷一行 */
  private realmWarned = false;
  /** 正在穿过启动探针的生命周期代次；stop 会使该代次立即失效。 */
  private startingGeneration: number | null = null;
  private lifecycleGeneration = 0;
  /** 难度回读在途:等着 stdout 里那一行(见 queryDifficulty);null = 没在等 */
  private difficultyWait: { proc: ChildProcess; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly opts: MinecraftServerOptions) {}

  get address(): string {
    return `${this.opts.host()}:${this.opts.port()}`;
  }

  directory(): string {
    return this.activeServerDir ?? this.opts.serverDir();
  }

  async state(): Promise<MinecraftServerState> {
    const serverDir = this.directory();
    const enabled = this.opts.enabled?.() ?? true;
    return {
      enabled,
      phase: this.phase,
      address: this.address,
      detail: enabled ? this.detail : '受管服务器开关已关闭',
      pid: this.proc?.pid ?? null,
      reachable: enabled ? await this.probe() : false,
      serverDir,
      configured: serverDir !== '' && existsSync(join(serverDir, 'server.jar')),
    };
  }

  /**
   * 当前受管世界的身份 `{uuid, levelName}`;没配服务器目录(或目录不在)= 不受管,
   * 返回 null,消费方拿 `host:port + 存档名` 拼弱身份。
   *
   * 查身份即纳管:存档目录里没有 `cortico-realm.json` 就在这里补上(幂等),所以
   * 换存档之后第一次调用就把新世界认下来了。**uuid 只进机器层**,对她的文本只用
   * `levelName`(见 `MinecraftRealm` 的说明)。
   */
  realm(): MinecraftRealm | null {
    const serverDir = this.directory();
    if (!serverDir || !existsSync(serverDir)) return null;
    let levelName: string;
    try {
      levelName = settingsFrom(loadProperties(serverDir)).levelName;
    } catch (err) {
      this.warnRealmOnce(`读 server.properties 认不出存档名: ${String(err)}`);
      return null;
    }
    const worldDir = join(serverDir, levelName);
    const hit = this.realmCache;
    // marker 还在才认缓存:存档被删掉重开(同名新世界)时,这里要重新发 uuid
    if (hit && hit.worldDir === worldDir && existsSync(realmMarkerPath(worldDir))) return hit.realm;
    let uuid: string | null = null;
    try {
      uuid = ensureRealmMarker(worldDir, levelName).uuid;
    } catch (err) {
      this.warnRealmOnce(`写不进 ${join(levelName, REALM_MARKER_FILE)}(${String(err)});这个世界只能按弱身份算`);
    }
    const realm: MinecraftRealm = { uuid, levelName };
    // 只缓存拿到 uuid 的那次:写失败多半是盘只读一类外部状况,人修好了下次要能捡起来
    this.realmCache = uuid ? { worldDir, realm } : null;
    return realm;
  }

  private warnRealmOnce(detail: string): void {
    if (this.realmWarned) return;
    this.realmWarned = true;
    this.opts.log.warn(`MC 世界身份不可用: ${detail}`);
  }

  async start(): Promise<MinecraftServerState> {
    if (!(this.opts.enabled?.() ?? true)) return this.state();
    if (this.startingGeneration !== null || this.phase === 'starting' || this.phase === 'running') {
      return this.state();
    }
    const generation = ++this.lifecycleGeneration;
    this.startingGeneration = generation;
    try {
      return await this.spawnServer(generation);
    } finally {
      if (this.startingGeneration === generation) this.startingGeneration = null;
    }
  }

  private async spawnServer(generation: number): Promise<MinecraftServerState> {
    if (await this.probe()) {
      if (generation !== this.lifecycleGeneration || !(this.opts.enabled?.() ?? true)) return this.state();
      this.detail = '端口已有服务器在跑(外部启动),无需托管';
      return this.state();
    }
    if (generation !== this.lifecycleGeneration || !(this.opts.enabled?.() ?? true)) return this.state();
    const launch = this.resolveLaunch();
    if ('error' in launch) {
      this.setPhase('error', launch.error);
      return this.state();
    }
    this.activeServerDir = launch.cwd ?? this.opts.serverDir();
    const portFix = this.opts.commandOverride ? null : this.alignServerPort();
    if (portFix) this.opts.log.warn(`MC 服务器端口纠偏: ${portFix}`);
    // 纳管这份存档:身份 marker 首次写、之后沿用。写不进去不挡启动(降级弱身份)
    const realm = this.realm();
    if (realm) {
      this.opts.log.info(`MC 世界纳管: 存档「${realm.levelName}」${realm.uuid ? '' : '(无身份标记,按弱身份算)'}`);
    }
    this.logTail = '';
    const proc = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;
    this.setPhase('starting', portFix ? `世界加载中(${portFix})` : '世界加载中');
    const tail = (chunk: Buffer) => {
      const text = chunk.toString();
      this.logTail = (this.logTail + text).slice(-2000);
      // 难度回读在就绪**之后**才发问,所以这一段要排在 starting 闸门前面
      this.consumeDifficultyReply(proc, text);
      if (this.proc !== proc || this.phase !== 'starting') return;
      // 生成维度期间持续输出进度可延长启动期限。
      if (PROGRESS_RE.test(text)) this.healthDeadline = Date.now() + PROGRESS_GRACE_MS;
      // 原版打完这行才算真就绪(监听端口已绑),比裸 TCP 探测准
      if (READY_RE.test(text)) {
        this.setPhase('running', null);
        this.clearHealthTimer();
        this.beginAutoSave();
        this.queryDifficulty();
        this.alignGameRules();
        this.opts.log.info(`MC 服务器就绪 ${this.address}(服务端自报 Done)`);
      }
    };
    proc.stdout?.on('data', tail);
    proc.stderr?.on('data', tail);
    proc.on('error', (err) => {
      if (this.proc !== proc) return;
      this.fail(`进程启动失败: ${err.message}`);
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.clearDifficultyWait();
      this.removeHardSignalHook();
      if (this.phase === 'stopped') return; // 人为停止或 code=0 的正常退出不报告故障。
      const detail = `进程退出 code=${code};日志尾部: ${this.logTail.slice(-400)}`;
      this.finish(code === 0 ? 'stopped' : 'error', detail);
    });
    this.installHardSignalHook();
    this.opts.log.info(`MC 服务器启动中 pid=${proc.pid} ${this.address}`);
    this.beginHealthPolling();
    return this.state();
  }

  async stop(): Promise<MinecraftServerState> {
    ++this.lifecycleGeneration;
    this.startingGeneration = null;
    this.clearHealthTimer();
    this.clearSaveTimer();
    this.clearDifficultyWait();
    this.removeHardSignalHook();
    this.setPhase('stopped', null);
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null) {
      await this.gracefulKill(proc);
      this.opts.log.info('MC 服务器已停止(已存档)');
    }
    this.activeServerDir = null;
    return this.state();
  }

  /**
   * 硬信号兜底:窗口被直接关掉时,抢在系统强杀之前把 save-all + stop 写进 stdin。
   * 装在**有托管进程的时候**,进程一没就摘掉 —— 常驻监听会在反复起停后攒成
   * 一堆指向已退出进程的死回调(测试里还会撞 MaxListeners 警告)。
   */
  private installHardSignalHook(): void {
    if (this.hardSignalHook) return;
    const hook = (): void => this.saveOnHardSignal();
    for (const sig of HARD_SIGNALS) process.on(sig, hook);
    this.hardSignalHook = hook;
  }

  private removeHardSignalHook(): void {
    const hook = this.hardSignalHook;
    if (!hook) return;
    this.hardSignalHook = null;
    for (const sig of HARD_SIGNALS) process.removeListener(sig, hook);
  }

  /**
   * 只做一件事:把两条指令塞进 java 的 stdin。不等它退出(等不到 —— 系统给的
   * 是 5 秒量级的窗口),也不动相位与定时器,让正常收尾路径若还活着就照常跑完。
   */
  private saveOnHardSignal(): void {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return;
    this.opts.log.warn('收到硬关信号:先给 MC 服务器补一次 save-all + stop(兜底,正门是控制台关机键)');
    this.command('save-all flush');
    this.command('stop');
  }

  /**
   * 先发送 save-all flush 和 stop，等待服务端存档退出；超时后才 SIGKILL。
   * 提前 flush 为无法正常收尾的路径提供一次存盘机会。
   */
  private async gracefulKill(proc: ChildProcess): Promise<void> {
    try {
      proc.stdin?.write('save-all flush\n');
      proc.stdin?.write('stop\n');
    } catch {
      /* stdin 已关 */
    }
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* 已退出 */ }
        resolve();
      }, GRACEFUL_EXIT_MS);
      proc.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
    });
  }


  private beginAutoSave(): void {
    this.clearSaveTimer();
    this.saveTimer = setInterval(() => {
      if (this.phase !== 'running') { this.clearSaveTimer(); return; }
      this.command('save-all');
    }, this.opts.autoSaveMs ?? AUTO_SAVE_MS);
    this.saveTimer.unref?.();
  }

  private clearSaveTimer(): void {
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.saveTimer = null;
  }

  /**
   * 服务端就绪后用无参 difficulty 查询启动时实际难度。
   * 仅自管服务器有 stdin 可查询；已发送而未收到答复时报告，运行期变更不在此监听。
   */
  private queryDifficulty(): void {
    this.clearDifficultyWait();
    const proc = this.proc;
    if (!proc || !this.command('difficulty')) return;
    const timer = setTimeout(() => {
      if (this.difficultyWait?.proc !== proc) return;
      this.difficultyWait = null;
      this.opts.log.warn('MC 难度回读:服务端没有在期限内回话');
      this.reportDifficulty({ difficulty: null, raw: null, properties: this.propertiesDifficulty() });
    }, this.opts.difficultyTimeoutMs ?? DIFFICULTY_TIMEOUT_MS);
    timer.unref?.();
    this.difficultyWait = { proc, timer };
  }

  /** stdout 里有没有那一行难度回话;有就结掉这一次回读 */
  private consumeDifficultyReply(proc: ChildProcess, text: string): void {
    if (this.difficultyWait?.proc !== proc) return;
    const hit = parseDifficultyReply(text);
    if (!hit) return;
    this.clearDifficultyWait();
    this.reportDifficulty({
      difficulty: hit.difficulty,
      raw: hit.raw,
      properties: this.propertiesDifficulty(),
    });
  }

  private reportDifficulty(fact: MinecraftDifficultyFact): void {
    this.opts.log.info(
      `MC 难度回读: ${fact.difficulty ?? '没认出来'}` +
      `${fact.raw ? `(服务端原话「${fact.raw}」)` : ''}` +
      `${fact.properties ? `;server.properties 写的是 ${fact.properties}` : ''}`,
    );
    this.opts.onDifficulty?.(fact);
  }

  private clearDifficultyWait(): void {
    if (this.difficultyWait) clearTimeout(this.difficultyWait.timer);
    this.difficultyWait = null;
  }

  /** 同一刻 server.properties 里的 difficulty=;读不到返回 null(不猜) */
  private propertiesDifficulty(): string | null {
    const dir = this.directory();
    if (!dir) return null;
    try {
      const value = readProperty(loadProperties(dir), 'difficulty');
      return value?.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * 就绪之后把跨维度该一致的 gamerule 按主世界对齐一次(见 `WORLD_WIDE_GAME_RULES`)。
   *
   * 读的是三份 level.dat(主世界/下界/末地),那是各维度 gamerule 的落盘处 —— 比去
   * stdout 里认 `gamerule` 查询的回话稳:不吃语言包、不用等回话、三个维度一次读完。
   * 代价是读到的是**上次存档那一刻**的值,而这里只在启动时问一次"这次起来是什么",
   * 与难度回读同一口径。
   *
   * 对不上就发 `execute in <维度> run gamerule <规则> <主世界的值>`。指令写不进去
   * (外部启动的服务器没有 stdin)就只报事实,让人自己敲 —— 不假装对齐过。
   */
  private alignGameRules(): void {
    const serverDir = this.directory();
    if (!serverDir || !existsSync(serverDir)) return;
    let levelName: string;
    try {
      levelName = settingsFrom(loadProperties(serverDir)).levelName;
    } catch {
      return; // 存档名都读不出来,别猜目录
    }
    const rulesOf = (dir: string): Record<string, string> | null =>
      readLevelDat(join(serverDir, dir, 'level.dat'))?.gameRules ?? null;
    const plan = planGameRuleAlignment(rulesOf(levelName), [
      { id: 'minecraft:the_nether', dir: `${levelName}_nether`, rules: rulesOf(`${levelName}_nether`) },
      { id: 'minecraft:the_end', dir: `${levelName}_the_end`, rules: rulesOf(`${levelName}_the_end`) },
    ]);
    if (plan.drift.length === 0) return;
    const sent = plan.commands.length > 0 && plan.commands.every((line) => this.command(line));
    this.opts.log.warn(
      `MC gamerule 各维度对不上:${plan.drift.join(';')}`
      + (plan.commands.length === 0
        ? ''
        : sent
          ? ` —— 已按主世界对齐(${plan.commands.length} 条 execute in … run gamerule)`
          : ` —— 指令写不进去(外部启动的服务器没有 stdin),要人工敲:${plan.commands.join(' / ')}`),
    );
  }

  /** 仅向受托管服务器的 stdin 写入指令；外部服务器返回 false。 */
  command(line: string): boolean {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || !proc.stdin?.writable) return false;
    try {
      proc.stdin.write(`${line}\n`);
      return true;
    } catch {
      return false;
    }
  }

  probe(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = connect({ host: this.opts.host(), port: this.opts.port(), timeout: 1500 });
      const done = (ok: boolean) => {
        sock.destroy();
        resolve(ok);
      };
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false));
      sock.once('error', () => done(false));
    });
  }

  private resolveLaunch():
    | { command: string; args: string[]; cwd: string | undefined }
    | { error: string } {
    if (this.opts.commandOverride) {
      return { command: this.opts.commandOverride.command, args: this.opts.commandOverride.args, cwd: undefined };
    }
    const serverDir = this.opts.serverDir();
    if (!serverDir) {
      return { error: '未配置服务器目录:在本 World 配置里填 worlds.minecraft.local.serverDir(含 server.jar 的目录)' };
    }
    const jar = join(serverDir, 'server.jar');
    if (!existsSync(jar)) return { error: `找不到 ${jar};确认 worlds.minecraft.local.serverDir 配置` };
    let java = this.opts.javaPath();
    if (!java) {
      java = findAdjacentJava(serverDir) ?? 'java';
    } else if (!existsSync(java)) {
      return { error: `找不到 java: ${java};确认 worlds.minecraft.local.javaPath 配置` };
    }
    return {
      command: java,
      args: [...this.opts.jvmArgs().split(/\s+/).filter(Boolean), '-jar', 'server.jar', 'nogui'],
      cwd: serverDir,
    };
  }

  /**
   * server.properties 的 server-port 只在**启动时**读一次,而它是整个目录共享的:
   * 台架(scratch/mc-bench)或另一个会话拿 --port/--world 起过一次,服务端会把覆盖值
   * 写回文件。于是托管服务器听在别的端口上,健康探测怎么都探不到,前端只看得见
   * 「启动中」一直挂到超时。启动前对齐一次,改动只报事实。
   */
  private alignServerPort(): string | null {
    const serverDir = this.directory();
    if (!serverDir) return null;
    try {
      const lines = loadProperties(serverDir);
      if (lines.length === 0) return null;
      const want = String(this.opts.port());
      const got = (readProperty(lines, 'server-port') ?? '').trim();
      if (got === want) return null;
      saveProperties(serverDir, writeProperty(lines, 'server-port', want));
      return `server.properties 里的 server-port 是 ${got || '(空)'},已改回 ${want}`;
    } catch (err) {
      this.opts.log.warn(`读写 server.properties 失败: ${String(err)}`);
      return null;
    }
  }

  private beginHealthPolling(): void {
    this.clearHealthTimer();
    const interval = this.opts.healthIntervalMs ?? 2_000;
    const proc = this.proc;
    this.healthDeadline = Date.now() + (this.opts.healthTimeoutMs ?? 120_000);
    this.healthTimer = setInterval(async () => {
      if (this.phase !== 'starting') {
        this.clearHealthTimer();
        return;
      }
      const reachable = await this.probe();
      // stop 或下一次启动可能在探针在途时接管生命周期；旧结果不得复活旧进程。
      if (this.phase !== 'starting' || this.proc !== proc) return;
      if (reachable) {
        this.setPhase('running', null);
        this.clearHealthTimer();
        this.beginAutoSave();
        this.queryDifficulty();
        this.alignGameRules();
        this.opts.log.info(`MC 服务器就绪 ${this.address}`);
        return;
      }
      if (Date.now() > this.healthDeadline) {
        const orphan = this.proc;
        this.proc = null;
        this.fail('启动超时(世界生成过久或端口不对)');
        // 先请求服务端存档退出，超时后才强制终止。
        if (orphan) void this.gracefulKill(orphan);
      }
    }, interval);
  }

  private clearHealthTimer(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  private fail(detail: string): void {
    this.finish('error', detail);
  }

  /**
   * 托管进程的终局收尾:定时器、兜底监听、活动目录一并落定,再翻相位。
   * `error` 与 `stopped` 两条出口的清理必须同一份 —— 干净退出(exit code 0)走 stopped。
   */
  private finish(phase: 'error' | 'stopped', detail: string): void {
    this.clearHealthTimer();
    this.clearSaveTimer();
    // 走到这里托管进程要么已经死了、要么已被摘成孤儿:兜底监听没有对象了,摘掉。
    this.removeHardSignalHook();
    if (this.proc === null) this.activeServerDir = null;
    this.setPhase(phase, detail);
    // 游戏服务器中断影响整个会话，按 error 记录。
    if (phase === 'error') this.opts.log.error(`MC 服务器异常: ${detail}`);
    else this.opts.log.info(`MC 服务器已退出: ${detail}`);
  }

  /** 相位的唯一写入口:变了才回调,原地重置(stopped→stopped)不吵。 */
  private setPhase(next: MinecraftServerPhase, detail: string | null): void {
    const changed = this.phase !== next;
    this.phase = next;
    this.detail = detail;
    if (changed) this.opts.onPhase?.(next, detail);
  }
}
