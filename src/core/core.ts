/** Composition root for framework services and the `Persona`/`CoreApi` boundary. */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BlobInput,
  BlobRef,
  CognitionHost,
  CognitionRequest,
  CognitionResult,
  EventEnvelope,
  EventOrigin,
  CoreConfig,
  ForkOptions,
  CoreApi,
  World,
  WorldHost,
  LLMProviderEntry,
  LLMUsage,
  Logger,
  ModelFacts,
  ModelSpec,
  Persona,
  PushOptions,
  SessionDecl,
  SessionInfo,
} from './types.ts';
import type { LoadedConfig } from './config.ts';
import { Runlog, estimateMessagesTokens, nowIso, withDeadline } from './util.ts';
import { JsonlEventStore } from './event-store.ts';
import { WakeBus } from './bus.ts';
import { SessionLog } from './session.ts';
import { CoreState } from './state.ts';
import { ProviderRegistry } from '../providers/registry.ts';
import { runForkLoop } from './fork.ts';
import { providerModule } from '../providers/registry.ts';
import { LogBlobStore, blobScheme, mimeOfHandle, withBlobLines } from './blobs.ts';
import { TimerStore } from './timers.ts';
import { SessionTracker, type SessionHandle } from './sessions.ts';
import { UsageLog } from './usage-log.ts';
import { ToolCallLog } from './tool-log.ts';
import { Transcript } from './transcript.ts';
import { openRun, writeRunJson, type RunInfo } from './run.ts';
import { currentAnchors } from './log-context.ts';
import { MainLoop, type ContextFacts } from './loop.ts';
import type { ResponseClient } from './generation.ts';

/**
 * 单个 World 的收尾预算。盖得住最慢的那条:MC 服务端 stop 存档自带 15 秒上限,
 * 加上子进程 RPC 的往返。超过就记一笔往下走 —— 关机不能被一个 World 扣住。
 */
const MODULE_STOP_MS = 20_000;
/** 主循环收到 abort 后用于落完已外化片段的期限。 */
const LOOP_DRAIN_MS = 1_000;
/**
 * 隐藏 World 仍推送事件时，首条及每隔此周期报告一次。可见性开关跨重启保留。
 */
const HIDDEN_PUSH_NOTE_GAP_MS = 10 * 60_000;

export interface CoreDeps {
  persona: Persona;
  worlds: World[];
  llm?: ResponseClient;
}

export interface WorldStopFailure {
  worldId: string;
  detail: string;
}

export class Core<C extends CoreConfig = CoreConfig> {
  readonly loaded: LoadedConfig<C>;
  /** 本次进程运行:记录都落在 run.dir 下 */
  readonly run: RunInfo;
  readonly runlog: Runlog;
  readonly transcript: Transcript;
  readonly store: JsonlEventStore;
  readonly bus: WakeBus;
  readonly session: SessionLog;
  readonly state: CoreState;
  readonly timers: TimerStore;
  readonly loop: MainLoop;
  readonly llm: ResponseClient;
  /** 媒体库：字节保存在 data/media/，回执与事件只存引用。 */
  /** 日志附件库:随记录落库的字节 */
  readonly logBlobs: LogBlobStore;
  /** 各agent session的观察注册表(web面板数据源) */
  readonly sessions: SessionTracker;
  /** 每次LLM调用的持久化流水(跨重启;用量·成本页数据源) */
  readonly usageLog: UsageLog;
  /** 主循环每次模型工具调用的持久化流水(工具名/原始参数/耗时/回执) */
  readonly toolLog: ToolCallLog;
  /** Persona注册的 session 声明;core 只按 id 查表,不对值分支 */
  readonly sessionDecls = new Map<string, SessionDecl>();
  /** 挂载表。与装配层共用同一个数组:运行中挂载/卸载就地增删。 */
  private worlds: World[];
  private persona: Persona;
  private log: Logger;
  private runPromise: Promise<void> | null = null;
  /** start() 已跑过 World 启动循环;之后挂载的 World 立即 start,之前的等 start() 统一起。 */
  private started = false;
  /** 每个声明当前运行的 fork 实例数，用于并发记账。 */
  private readonly forkRunning = new Map<string, number>();
  /** 每个 World 当前在途的认知外包请求数(同款并发记账;单实例策略归Persona) */
  private readonly cognitionRunning = new Map<string, number>();
  /** 接收事件投递的那个 session 声明(模型事实按它实时读) */
  private readonly mainDecl: SessionDecl;
  /** World 自愿上报用量的常驻仪表条目(每 World 一条) */
  private readonly moduleUsageTracks = new Map<string, SessionHandle>();
  /** 隐藏 World 照常落库的事件计数与上次回报时刻(每 World 一条) */
  private readonly hiddenPushes = new Map<string, { count: number; notedAtMs: number }>();
  readonly providers: ProviderRegistry;
  private readonly moduleHostLeases = new Map<World, { active: boolean }>();

  constructor(loaded: LoadedConfig<C>, deps: CoreDeps) {
    this.loaded = loaded;
    const cfg = loaded.config;
    const dataDir = loaded.dataDir;
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

    this.run = openRun(dataDir, { timezone: cfg.timezone, bot: cfg.displayName, repoRoot: loaded.repoRoot });
    this.runlog = new Runlog(join(this.run.dir, 'log.jsonl'), {
      run: this.run.id,
      timezone: cfg.timezone,
      levels: () => cfg.logging,
      incidentsDir: join(this.run.dir, 'incidents'),
    });
    this.log = this.runlog.logger('core');
    this.store = new JsonlEventStore({ dataDir, run: this.run.id, log: this.log.child('store') });
    // WakeBus 持有只读配置引用，使 batching 热更新对后续 push 生效。
    this.bus = new WakeBus(cfg.batching, this.log.child('bus'));
    this.session = new SessionLog(dataDir, 'session-main.jsonl', () => nowIso(cfg.timezone));
    this.transcript = new Transcript(join(this.run.dir, 'transcript.jsonl'), { run: this.run.id, timezone: cfg.timezone });
    this.session.onAppend((record, index) => this.transcript.item(record, index));
    this.state = new CoreState(dataDir);
    // 先 load 再 attach：load 会整体替换状态对象，Persona首次调用 personaState() 时必须拿到已加载的状态。
    this.state.load();
    this.worlds = deps.worlds;
    this.persona = deps.persona;
    this.logBlobs = new LogBlobStore(dataDir);
    this.providers = new ProviderRegistry(() => cfg.providers, {
      // 端点的状态归全局端点表那一格,不是这份部署的 data/ —— 同一个账号因此只授权一次。
      stateRoot: loaded.providersDir ?? join(loaded.rootDir, 'providers'),
      repoRoot: loaded.repoRoot ?? process.cwd(),
      readBlob: (handle) => {
        const bytes = this.resolveBlob(handle)?.bytes;
        return bytes ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
      },
      keepThinking: () => cfg.context.keepPastThinking,
      log: this.log.child('llm'),
    });
    this.llm = deps.llm ?? this.makeProviderRouter();

    // TimerStore 仅提供通用持久定时器；Persona定义心跳与闹钟语义。
    this.timers = new TimerStore(dataDir, this.log.child('timer'));

    this.usageLog = new UsageLog(join(dataDir, 'usage.jsonl'), message => this.log.error(message));
    this.toolLog = new ToolCallLog(join(this.run.dir, 'toolcalls.jsonl'), { timezone: cfg.timezone, run: this.run.id });
    this.sessions = new SessionTracker(cfg.timezone, (rec) => {
      const { round } = currentAnchors();
      this.usageLog.append({ ...rec, run: this.run.id, ...(round !== undefined ? { round } : {}) });
    });

    // attach 必须先于 declareSessions，后者会将工具 handler 绑定到 CoreApi。
    this.persona.attach(this.makeApi());
    // 声明按原样收下:模型档不再由 core 往声明上盖,声明里也不再有它。
    const decls = this.persona.declareSessions();
    for (const decl of decls) this.sessionDecls.set(decl.id, decl);
    const main = decls.filter((d) => d.receivesEvents && d.persistent);
    if (main.length !== 1) {
      throw new Error(
        `Persona必须恰好声明一个接收事件投递的常驻session,当前${main.length}个`,
      );
    }

    this.mainDecl = main[0];
    this.loop = new MainLoop({
      cfg,

      llm: this.llm,
      persona: deps.persona,
      decl: main[0],
      spec: () => this.activeSpec(),
      context: this.contextFacts(),
      blobs: { intern: (inputs) => this.internBlobs(inputs) },
      worlds: {
        all: () => this.worlds,
        visible: () => this.worlds.filter((m) => this.isWorldVisible(m.id)),
      },
      dirs: { packageDir: loaded.packageDir ?? loaded.rootDir, deploymentDir: loaded.rootDir },
      bus: this.bus,
      session: this.session,
      store: this.store,
      state: this.state,
      log: this.log.child('loop'),
      tracker: this.sessions,
      toolLog: this.toolLog,
      transcript: this.transcript,
      toolOwner: (name) => this.worlds.find((m) => m.tools().some((t) => t.name === name))?.id,
    });
    this.bus.setPreemptHandler(() => {
      this.loop.abortCurrentRound();
    });
  }

  private makeApi(): CoreApi {
    return {
      injectInternal: (text, kind) => this.loop.injectInternal(text, kind),
      injectDeferred: (kind, render) => this.loop.injectDeferred(kind, render),
      injectExternal: (text, kind) => this.loop.injectExternal(text, kind),
      requestContextHandoff: () => this.loop.requestContextHandoff(),
      spawnFork: (opts) => this.spawnFork(opts),
      sessionInfo: (id) => this.sessionInfo(id),
      llm: this.llm,
      timers: this.timers,
      deliveryGate: {
        set: (gate) => this.bus.setDeliveryGate(gate),
        clear: (id, deliverQueued) => this.bus.clearDeliveryGate(id, deliverQueued),
        isBlocked: () => this.bus.isDeliveryBlocked(),
      },
      personaState: () => this.state.data.persona,
      savePersonaState: () => this.state.save(),
      toolsTagged: (tag) =>
        new Set(this.loop.getToolSchemas().filter((t) => t.tags.includes(tag)).map((t) => t.name)),
      blob: (handle) => this.resolveBlob(handle),
      log: this.log.child('persona'),
    };
  }

  /**
   * 按 scheme 解析句柄:`log:` 查日志附件库,`mem:` 问Persona的记忆。
   * 认不出或不在 → null。
   */
  resolveBlob(handle: string): { bytes: Uint8Array; mime: string } | null {
    const scheme = blobScheme(handle);
    if (scheme === 'log') return this.logBlobs.read(handle);
    if (scheme === 'mem') return this.persona.blobs.get(handle);
    return null;
  }

  /**
   * 记录落库刻的附件内部化:新字节进日志附件库换 `log:` 句柄;已有句柄只补 mime 与名字。
   * 返回落库形态;没有附件返回 undefined,记录上不长出空数组。
   */
  internBlobs(inputs: readonly (BlobInput | BlobRef)[] | undefined): BlobRef[] | undefined {
    if (!inputs || inputs.length === 0) return undefined;
    return inputs.map((input) => {
      if ('bytes' in input) {
        const handle = this.logBlobs.put(input.bytes, input.mime);
        return { handle, mime: input.mime, ...(input.name ? { name: input.name } : {}), fallbackText: input.fallbackText };
      }
      const known = 'mime' in input ? input : null;
      const resolved = known ? null : this.resolveBlob(input.handle);
      const mime = known?.mime ?? resolved?.mime ?? mimeOfHandle(input.handle);
      const name = known?.name ?? input.handle.slice(input.handle.lastIndexOf('/') + 1).replace(/^[a-z]+:/, '');
      return { handle: input.handle, mime, name, fallbackText: input.fallbackText };
    });
  }

  /** 丢弃已发生的事件与候选票据；历史保留，重启不再补投。 */
  discardPendingEvents(): number {
    const dropped = this.bus.drainPending((item) =>
      item.event !== undefined || item.candidate !== undefined);
    this.loop.acknowledgeDiscarded(
      dropped.flatMap((item) => item.event ? [item.event] : []),
    );
    return dropped.length;
  }

  private sessionInfo(id: string): SessionInfo {
    const decl = this.sessionDecls.get(id);
    const isMainLoop = decl?.persistent === true && decl.receivesEvents;
    const gauge = isMainLoop ? this.loop.contextGauge() : null;
    return {
      id,
      running: this.forkRunning.get(id) ?? 0,
      // 出线态快照(含合成首轮对话):继承它的 fork 与主 session 字节前缀一致
      snapshot: isMainLoop ? this.loop.outboundMessages() : null,
      estTokens: gauge?.estTokens ?? null,
      hardTokens: gauge?.hardTokens ?? null,
    };
  }

  /**
   * 生效上下文窗口:Provider 实例探到的上游自报值与档位手填值取小。两者都缺席时
   * undefined——core 不猜窗口。
   */
  private contextWindowOf(spec: ModelSpec): number | undefined {
    const { name } = this.activeProviderEntry();
    const detected = this.providers.resolve(name).contextWindow?.(spec.model);
    const manual = spec.contextWindow;
    if (detected === undefined) return manual;
    return manual === undefined ? detected : Math.min(detected, manual);
  }

  /** 上下文事实,按当前 provider 的模型档现读。全局一份:模型不再按 session 分岔。 */
  private contextFacts(): ContextFacts {
    const module = () => providerModule(this.activeProviderEntry().entry.kind);
    return {
      hardTokens: () => {
        const spec = this.activeSpec();
        const window = this.contextWindowOf(spec);
        return window === undefined ? null : Math.max(0, window - (spec.maxTokens ?? 0));
      },
      estimateTokens: (records) => module().estimateTokens?.(records, this.activeSpec()) ?? estimateMessagesTokens(records),
      contextOverflow: (error) => module().contextOverflow?.(error) ?? false,
    };
  }

  /**
   * 创建一个临时 session 并跑完它的工具循环。core 在这里只做机械的事——
   * 按声明取模型档位/工具集/轮数上限、并发记账、用量归账、错误隔离。
   * 单实例之类的策略性限制由Persona自己判断(它能经 sessionInfo 读到计数)。
   */
  async spawnFork(opts: ForkOptions): Promise<string> {
    const decl = this.sessionDecls.get(opts.id);
    if (!decl) throw new Error(`未声明的session: ${opts.id}`);
    let observedMessages = opts.messages;
    const track = this.sessions.open(decl.id, decl.label, {
      messagesRef: () => observedMessages,
    });
    this.forkRunning.set(decl.id, (this.forkRunning.get(decl.id) ?? 0) + 1);
    try {
      return await runForkLoop({
        id: decl.id,
        llm: this.llm.bind?.() ?? this.llm,
        spec: this.activeSpec(),
        messages: opts.messages,
        tools: opts.tools ?? decl.tools(),
        maxRounds: decl.rounds().hard,
        softRounds: decl.rounds().soft,
        log: this.log.child(`fork.${decl.id}`),
        stopWhen: opts.stopWhen,
        wrapUpHint: opts.wrapUpHint,
        capNote: opts.capNote,
        nudge: opts.nudge,
        track,
        observeMessages: (messages) => {
          observedMessages = messages;
        },
      });
    } finally {
      this.forkRunning.set(decl.id, Math.max(0, (this.forkRunning.get(decl.id) ?? 1) - 1));
      track.close();
    }
  }

  /**
   * 认知外包(见 types.ts `CognitionRequest` 的主权划分)。core 在这条路上
   * **只做机械的三件事**,一件语义的事都不做:
   *
   *  1. **注入**:Persona提供了实现、且它的全局开关开着,World host 上才出现
   *     `cognition` 句柄;否则句柄根本不存在(World 据此走降级路径)。
   *  2. **白名单**:`req.tools` 必须全是**请求方 World 自己**声明的工具名。越权的
   *     直接以 `{error}` 驳回,**不惊动Persona**——不然 World 就能借她的手去点
   *     别人的工具,等于绕开工具可见性自己开了一个意识面。
   *  3. **并发记账**:同 forkRunning,数在途请求数交给Persona判断单实例/排队。
   *
   * 用量不在这里记:人格实现内部走 spawnFork,归账由 SessionDecl 那条路完成
   * (成本页按声明 id 分类),core 不重复记一遍。
   */
  private makeCognition(mod: World, active: () => boolean): CognitionHost | undefined {
    const impl = this.persona.cognition;
    if (!impl) return undefined;
    if (impl.enabled && !impl.enabled()) return undefined;
    const log = this.runlog.logger(`worlds.${mod.id}`);
    return {
      request: async (req: CognitionRequest): Promise<CognitionResult> => {
        if (!active()) return { error: '宿主生命周期已结束' };
        const brief = typeof req?.brief === 'string' ? req.brief.trim() : '';
        if (!brief) return { error: '认知请求没有 brief:要想的是什么,得由 World 自己说清楚' };
        const own = new Set(mod.tools().map((t) => t.name));
        const named = req.tools ?? [];
        const outsiders = named.filter((name) => !own.has(name));
        if (outsiders.length > 0) {
          // 这不是运行时波动,是 World 写错了:点名的工具压根不是它自己的。
          log.warn('认知请求越权点名工具,已驳回', { tools: outsiders });
          return {
            error:
              `认知请求只能点名本 World 自己的工具,这些不是: ${outsiders.join(' / ')}` +
              `(本 World 现有: ${[...own].join(' / ') || '(无)'})`,
          };
        }
        const tools = named.map((name) => mod.tools().find((t) => t.name === name)!);
        const running = (this.cognitionRunning.get(mod.id) ?? 0) + 1;
        this.cognitionRunning.set(mod.id, running);
        try {
          return await impl.request({ ...req, brief }, { worldId: mod.id, tools, running });
        } catch (e) {
          // 人格实现炸了不该炸穿 World:如实换成一句失败原因交回去。
          log.warn('认知请求受理失败', { err: e });
          return { error: e instanceof Error ? e.message : String(e) };
        } finally {
          this.cognitionRunning.set(mod.id, Math.max(0, (this.cognitionRunning.get(mod.id) ?? 1) - 1));
        }
      },
    };
  }

  /** 各 World 当下在途的认知外包请求数(控制台/诊断用;没有在途的 World 不出现) */
  cognitionInFlight(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, n] of this.cognitionRunning) if (n > 0) out[id] = n;
    return out;
  }

  get config() {
    return this.loaded.config;
  }


  /**
   * 隐藏一个 World = 撤下它对 agent 的三要素(前缀环境提示词 / 工具 / 事件投递),
   * **不动它的 runtime**:连接不断、自带 loop 不停、它持有的页面照常工作
   * (终端 World 的对话页就是这种情况——页面还能打字,只是不会唤醒 agent)。
   *
   * 生效时机分两半:
   *  - 事件投递:立即。不进请求,零缓存代价。事件照常落库,历史工具查得到,
   *    但不唤醒 agent;重新显示时不补投积压。
   *  - 前缀段与工具:等下一次前缀重建。两者同属缓存前缀,必须一起换;
   *    运维在控制台决定重载时机,每次重载丢一次前缀缓存。
   */
  setWorldVisible(id: string, visible: boolean): void {
    if (!this.worlds.some((m) => m.id === id)) throw new Error(`未挂载的 World: ${id}`);
    this.state.data.worldVisibility[id] = visible;
    this.state.save();
    this.log.warn(`World 对 agent ${visible ? '可见' : '隐藏'}: ${id}`);
  }

  isWorldVisible(id: string): boolean {
    return this.state.data.worldVisibility[id] !== false;
  }

  /**
   * 隐藏 World 推来的事件落了库但不唤醒 agent。这是开关按下的结果而不是故障,
   * 所以按 HIDDEN_PUSH_NOTE_GAP_MS 节流;但一条都不记的话,现场只剩「她听不见」
   * 这一个症状,而开关是上一场甚至上一周按下的。
   */
  private noteHiddenPush(id: string): void {
    const note = this.hiddenPushes.get(id) ?? { count: 0, notedAtMs: 0 };
    note.count += 1;
    this.hiddenPushes.set(id, note);
    const now = Date.now();
    if (note.notedAtMs > 0 && now - note.notedAtMs < HIDDEN_PUSH_NOTE_GAP_MS) return;
    note.notedAtMs = now;
    this.log.warn(
      `World 对 agent 隐藏,事件只归档不投递: ${id}(本轮第 ${note.count} 条;要她收得到,去控制台把这个 World 改回可见)`,
    );
  }

  /** 全部已挂载 World 的可见性 + 前缀是否已经跟上 */
  worldVisibility(): { visibility: Record<string, boolean>; driftedWorlds: string[] } {
    const visibility: Record<string, boolean> = {};
    for (const mod of this.worlds) visibility[mod.id] = this.isWorldVisible(mod.id);
    return { visibility, driftedWorlds: this.loop.modulePrefixDrift() };
  }

  /** 当前跑的模型档(控制台状态快照、启动横幅用);一个端点一份,不按 session 分。 */
  mainSessionSpec(): ModelSpec {
    return this.activeSpec();
  }

  /**
   * 当前活跃端点的模型档。`ModelSpec` 整组归 Provider——Persona既拿不到也不报,
   * core 每次用时按 `activeProvider` 现读。
   *
   * 端点没填模型就抛:框架不替部署猜一个模型名,也没有"Persona那份 baseline"
   * 可以退回去了。
   */
  activeSpec(): ModelSpec {
    const { name, entry } = this.activeProviderEntry();
    if (!entry.spec) {
      throw new Error(`LLM provider ${name} 还没选模型(去控制台该 Provider 的「实例与模型」面板填模型名并保存)`);
    }
    return entry.spec;
  }

  /** 当前活跃的 provider 条目;activeProvider 指向不存在的键时抛清晰错误 */
  activeProviderEntry(): { name: string; entry: LLMProviderEntry } {
    const cfg = this.loaded.config;
    const name = cfg.activeProvider;
    const entry = cfg.providers?.[name];
    if (!entry) {
      const known = Object.keys(cfg.providers ?? {}).join(' / ') || '(空)';
      throw new Error(`没有这个 LLM provider: ${name}(config.json providers 段现有: ${known})`);
    }
    return { name, entry };
  }

  /** The selected instance is resolved once at the start of each request. */
  private makeProviderRouter(): ResponseClient {
    const bind = (): ResponseClient => this.providers.bind(this.activeProviderEntry().name);
    return { bind, respond: async (request, options) => bind().respond(request, options) };
  }

  /** 模型事实(按当前活跃端点实时读,不做启动期快照) */
  private modelFacts(): ModelFacts {
    const spec = (): ModelSpec => this.activeSpec();
    return {
      model: () => spec().model,
      // 吃不吃图是端点后面那个底模的部署事实:读活跃 provider 条目的手动开关。
      accepts: (mime) => {
        const {entry} = this.activeProviderEntry();
        return providerModule(entry.kind).accepts?.(entry,spec(),mime) ?? (entry.multimodal === true && mime.startsWith('image/'));
      },
      contextWindow: () => this.contextWindowOf(spec()),
    };
  }

  /** World 宿主接口;每个 World 使用以自身 id 命名的子 logger。 */
  private makeHost(mod: World): WorldHost {
    const previous = this.moduleHostLeases.get(mod);
    if (previous) previous.active = false;
    const lease = { active: true };
    this.moduleHostLeases.set(mod, lease);
    // getter 里的 this 是宿主对象自己,拿不到 core——留一个显式引用。
    const self = this;
    return {
      // 唯一事件通道:origin 由 World 自填(不填=external),投递侧按标签路由分区。
      pushEvent: async (
        e: Omit<EventEnvelope, 'cursor' | 'origin' | 'contextDelivery'> & { origin?: EventOrigin },
        opts?: PushOptions,
      ): Promise<EventEnvelope> => {
        if (!lease.active) throw new Error(`World ${mod.id} 的宿主生命周期已结束`);
        const deliver = opts?.deliver !== false && this.isWorldVisible(mod.id);
        const blobs = this.internBlobs(e.blobs);
        const envelope = this.store.append({
          ...e,
          text: withBlobLines(e.text, blobs),
          ...(blobs ? { blobs } : {}),
          origin: e.origin ?? 'external',
          contextDelivery: deliver ? 'deliver' : 'archive-only',
        });
        // 隐藏的 World 照常落库(经历不丢,历史工具查得到),但不唤醒 agent。
        if (deliver) {
          this.bus.push({ event: envelope }, { trigger: opts?.trigger });
        } else {
          // 不投递的落库事件也须销账。这类 archive-only 不经过候选投影，不能等待 settledArchives 的候选发车路径结清水位。
          this.loop.acknowledgeDiscarded([envelope]);
          if (opts?.deliver !== false) this.noteHiddenPush(mod.id);
        }
        return envelope;
      },
      pushDeferred: (e, opts) => {
        if (!lease.active) return;
        // 隐藏 World 的项直接丢弃:没有正文可落库,也不该唤醒。
        if (!this.isWorldVisible(mod.id)) return;
        this.bus.push(
          { deferred: { ...e, source: mod.id, origin: e.origin ?? 'external' } },
          { trigger: opts?.trigger },
        );
      },
      pushCandidate: async (spec, opts) => {
        if (!lease.active) throw new Error(`World ${mod.id} 的宿主生命周期已结束`);
        if (spec.sourceEvents.length === 0) throw new Error('候选票据至少需要一条原始事件');
        const origin = spec.origin ?? 'external';
        const sourceEvents = spec.sourceEvents.map((event) => this.store.append({
          ...event,
          source: mod.id,
          origin,
          contextDelivery: 'archive-only',
        }));
        if (this.isWorldVisible(mod.id)) {
          this.bus.push({
            candidate: {
              source: mod.id,
              origin,
              sourceEvents,
              gateText: spec.gateText,
              value: spec.value,
              project: spec.project,
            },
          }, { trigger: opts?.trigger });
        } else {
          // 隐藏 World 的候选不会发车,原文永远等不到投影引用——同样要当场销账,
          // 否则这批 archive-only 就是水位上的永久楔子。
          this.loop.acknowledgeDiscarded(sourceEvents);
        }
        return sourceEvents;
      },
      store: this.store,
      drainPendingEvents: async (filter) => {
        if (!lease.active) return [];
        const taken = this.bus
          .drainPending((it) => it.event?.origin === 'external' && filter(it.event))
          .map((it) => it.event as EventEnvelope);
        // 抽走的事件也要销账。不销就是一道永久缺口:它们既不会进 session,
        // 水位又越不过去,下次启动整段重新补投(与 discardPendingEvents 同理)。
        if (taken.length > 0) this.loop.acknowledgeDiscarded(taken);
        return taken;
      },
      modelFacts: this.modelFacts(),
      blob: (handle) => this.resolveBlob(handle),
      reportUsage: (usage, opts) => {
        if (lease.active) this.reportWorldUsage(mod.id, usage, opts);
      },
      llmStalls: async (withinMs) => this.loop.llmStalls(withinMs),
      // getter 而非固定值:Persona的全局开关每次取用现读,热改立即生效
      // (关掉 = 下一次 `if (host.cognition)` 就已经是 undefined,不必重启 World)。
      get cognition(): CognitionHost | undefined {
        return lease.active ? self.makeCognition(mod, () => lease.active) : undefined;
      },
      log: this.runlog.logger(`worlds.${mod.id}`),
    };
  }

  /**
   * World 上报的用量按 `worlds.<World>` 仪表项计入 session 统计和 usage.jsonl。
   * 用量标签不携带模型用途语义。
   */
  private reportWorldUsage(
    worldId: string,
    usage: LLMUsage,
    opts?: { model?: string; label?: string; charges?: import('./generation.ts').Charge[] },
  ): void {
    const id = `worlds.${worldId}`;
    let track = this.moduleUsageTracks.get(id);
    if (!track) {
      track = this.sessions.open(id, opts?.label ?? `${worldId}World 自带模型`, { id });
      this.moduleUsageTracks.set(id, track);
    }
    track.record(usage, undefined, opts?.model, { charges: opts?.charges });
  }

  async start(): Promise<void> {
    const dataDir = this.loaded.dataDir;
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    // state 已在构造期读盘(见那里的注释)。这里不再 load 一次:load() 整体重赋
    // this.data,再读一遍就会把装配到启动之间发生的改动(onStart 钩子、控制台在
    // core 起来之前做的重置)从内存里抹掉。那些路径本来就各自 save() 过。
    this.session.load();
    for (const mod of this.worlds) {
      try {
        await mod.start(this.makeHost(mod));
      } catch (error) {
        const lease = this.moduleHostLeases.get(mod);
        if (lease) lease.active = false;
        throw error;
      }
      this.log.info(`World 已启动: ${mod.id}`);
    }
    this.started = true;
    if (this.worlds.length === 0) this.log.warn('没有挂载任何 World:agent 收不到外部事件');
    this.timers.start();
    this.runPromise = this.loop.run().catch((e) => {
      this.timers.stop();
      this.log.error('主循环异常退出', { err: e });
    });
    writeRunJson(this.run, {
      bot: this.loaded.config.displayName,
      worlds: this.worlds.map((m) => m.id),
      activeProvider: this.loaded.config.activeProvider,
    });
    this.log.emit('info', 'core已启动', { event: 'started', data: { run: this.run.id } });
  }

  /**
   * 收尾先终止主循环，再并发停止 World。每个边界都有独立期限，失败进入返回账。
   */
  /**
   * 运行中挂载一个 World:入表,core 已启动则立即 start,并重建 system 前缀
   * (环境提示词段与工具表同属缓存前缀,挂载必须连带换掉)。start 抛错时不入表。
   */
  async mountWorld(mod: World): Promise<void> {
    if (this.worlds.some((m) => m.id === mod.id)) throw new Error(`World 已挂载: ${mod.id}`);
    if (this.started) {
      try {
        await mod.start(this.makeHost(mod));
      } catch (error) {
        const lease = this.moduleHostLeases.get(mod);
        if (lease) lease.active = false;
        throw error;
      }
      this.log.info(`World 已启动: ${mod.id}`);
    }
    this.worlds.push(mod);
    if (this.started) await this.loop.reloadSystemPrefix();
  }

  /**
   * 运行中卸载一个 World:按关机同款期限 stop,租约失效,出表,重建 system 前缀。
   * stop 失败或超时只记账不阻止卸载——World 已经不可达,留在表里只会继续占工具名。
   */
  async unmountWorld(id: string): Promise<WorldStopFailure | null> {
    const index = this.worlds.findIndex((m) => m.id === id);
    if (index < 0) throw new Error(`未挂载的 World: ${id}`);
    const mod = this.worlds[index];
    let failure: WorldStopFailure | null = null;
    if (this.started) {
      try {
        await withDeadline(mod.stop(), MODULE_STOP_MS);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        this.log.warn(`World 停止失败: ${mod.id}`, { err: detail });
        failure = { worldId: mod.id, detail };
      }
    }
    const lease = this.moduleHostLeases.get(mod);
    if (lease) lease.active = false;
    this.worlds.splice(this.worlds.indexOf(mod), 1);
    this.log.info(`World 已卸载: ${mod.id}`);
    if (this.started) await this.loop.reloadSystemPrefix();
    return failure;
  }

  async stop(): Promise<WorldStopFailure[]> {
    this.started = false;
    this.loop.stop();
    this.timers.stop();
    const failures: WorldStopFailure[] = [];
    if (this.runPromise) {
      try {
        await withDeadline(this.runPromise, LOOP_DRAIN_MS, '主循环终止');
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        this.log.warn('主循环未在关机期限内结束', { err: detail });
        failures.push({ worldId: 'core.loop', detail });
      } finally {
        this.loop.seal();
        this.runPromise = null;
      }
    } else {
      this.loop.seal();
    }
    const moduleFailures = (await Promise.all(this.worlds.map(async (mod): Promise<WorldStopFailure | null> => {
      try {
        await withDeadline(mod.stop(), MODULE_STOP_MS);
        return null;
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        this.log.warn(`World 停止失败: ${mod.id}`, { err: detail });
        return { worldId: mod.id, detail };
      } finally {
        const lease = this.moduleHostLeases.get(mod);
        if (lease) lease.active = false;
      }
    }))).filter((failure): failure is WorldStopFailure => failure !== null);
    failures.push(...moduleFailures);
    this.usageLog.flush();
    const ledger = this.usageLog.status();
    if (ledger.pending) failures.push({ worldId: 'core.usage', detail: `${ledger.pending} usage records remain unwritten: ${ledger.error}` });
    this.log.info('core已停止');
    return failures;
  }
}
