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
  LLMUsage,
  Logger,
  ModelFacts,
  ModelSpec,
  Persona,
  PushOptions,
  SessionDecl,
  SessionInfo,
} from './types.ts';
import { createCoreConfig, type CoreConfigOptions } from './config.ts';
import type { Provider } from '../providers/base.ts';
import { Runlog, estimateMessagesTokens, nowIso, withDeadline } from './util.ts';
import { JsonlEventStore } from './event-store.ts';
import { WakeBus } from './bus.ts';
import { SessionLog } from './session.ts';
import { CoreState } from './state.ts';
import { runForkLoop } from './fork.ts';
import { LogBlobStore, blobScheme, mimeOfHandle, withBlobLines } from './blobs.ts';
import { TimerStore } from './timers.ts';
import { SessionTracker, type SessionHandle } from './sessions.ts';
import { openRun, closeRun, writeRunJson, type RunInfo } from './run.ts';
import { MainLoop, RESERVED_FRAME_NAMES, type ContextFacts } from './loop.ts';
import type { ResponseClient } from './generation.ts';

/** 单个 World 的停止期限；失败或超时写入结果，其他停止操作继续。 */
const MODULE_STOP_MS = 20_000;
/** 主循环收到 abort 后用于落完已外化片段的期限。 */
const LOOP_DRAIN_MS = 1_000;
export interface CoreOptions {
  dataDir: string;
  config?: CoreConfigOptions;
  persona: Persona;
  worlds?: World[];
  provider: Provider;
  model: ModelSpec;
}

export interface WorldStopFailure {
  worldId: string;
  detail: string;
}

export class Core {
  readonly config: CoreConfig;
  readonly dataDir: string;
  readonly provider: Provider;
  private readonly model: ModelSpec;
  /** 本次进程运行的标识与日志目录。 */
  readonly run: RunInfo;
  readonly runlog: Runlog;
  readonly store: JsonlEventStore;
  readonly bus: WakeBus;
  readonly session: SessionLog;
  readonly state: CoreState;
  readonly timers: TimerStore;
  readonly loop: MainLoop;
  readonly llm: ResponseClient;
  /** 媒体库：字节保存在 data/media/，回执与事件只存引用。 */
  readonly logBlobs: LogBlobStore;

  readonly sessions: SessionTracker;

  /** Persona注册的 session 声明;core 只按 id 查表,不对值分支 */
  readonly sessionDecls = new Map<string, SessionDecl>();
  /** 挂载表。与装配层共用同一个数组:运行中挂载/卸载就地增删。 */
  private worlds: World[];
  private persona: Persona;
  private log: Logger;
  private runPromise: Promise<void> | null = null;
  /** start() 已跑过 World 启动循环;之后挂载的 World 立即 start,之前的等 start() 统一起。 */
  private started = false;
  private stopPromise: Promise<WorldStopFailure[]> | null = null;
  /** 每个声明当前运行的 fork 实例数，用于并发记账。 */
  private readonly forkRunning = new Map<string, number>();
  /** 各 World 在途的认知请求数；并发限制由 Persona 决定。 */
  private readonly cognitionRunning = new Map<string, number>();
  /** 接收事件的主 session 声明。 */
  private readonly mainDecl: SessionDecl;
  /** World 自愿上报用量的常驻仪表条目(每 World 一条) */
  private readonly moduleUsageTracks = new Map<string, SessionHandle>();
  private readonly moduleHostLeases = new Map<World, { active: boolean }>();

  constructor(options: CoreOptions) {
    this.config = createCoreConfig(options.config);
    this.dataDir = options.dataDir;
    this.provider = options.provider;
    this.model = Object.freeze({ ...options.model });
    if (!this.model.model.trim()) throw new Error('model.model is required');
    for (const key of ['contextWindow', 'maxTokens'] as const) {
      const value = this.model[key];
      if (value !== undefined && (!Number.isInteger(value) || value <= 0)) throw new Error(`Invalid model.${key}`);
    }
    const cfg = this.config;
    const dataDir = this.dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.run = openRun(dataDir, { timezone: cfg.timezone });
    this.runlog = new Runlog(join(this.run.dir, 'log.jsonl'), {
      run: this.run.id,
      timezone: cfg.timezone,
      levels: () => cfg.logging,
      incidentsDir: join(this.run.dir, 'incidents'),
    });
    this.log = this.runlog.logger('core');
    this.store = new JsonlEventStore({ dataDir, run: this.run.id, log: this.log.child('store') });
    this.bus = new WakeBus(cfg.batching, this.log.child('bus'));
    this.session = new SessionLog(dataDir, 'session-main.jsonl', () => nowIso(cfg.timezone));
    this.state = new CoreState(dataDir);
    // 先 load 再 attach：load 会整体替换状态对象，Persona首次调用 personaState() 时必须拿到已加载的状态。
    this.state.load();
    this.worlds = [...(options.worlds ?? [])];
    if (new Set(this.worlds.map(world => world.id)).size !== this.worlds.length) throw new Error('Duplicate World id');
    this.persona = options.persona;
    this.logBlobs = new LogBlobStore(dataDir);
    this.llm = options.provider;

    // TimerStore 仅提供通用持久定时器；Persona定义心跳与闹钟语义。
    this.timers = new TimerStore(dataDir, this.log.child('timer'));

    this.sessions = new SessionTracker(cfg.timezone);

    // attach 必须先于 declareSessions，后者会将工具 handler 绑定到 CoreApi。
    this.persona.attach(this.makeApi());
    const decls = this.persona.declareSessions();
    for (const decl of decls) {
      if (this.sessionDecls.has(decl.id)) throw new Error(`Duplicate session id: ${decl.id}`);
      this.sessionDecls.set(decl.id, decl);
    }
    const main = decls.filter((d) => d.receivesEvents && d.persistent);
    if (main.length !== 1) {
      throw new Error(
        `Persona必须恰好声明一个接收事件投递的常驻session,当前${main.length}个`,
      );
    }

    this.mainDecl = main[0];
    this.validateTools(this.worlds);
    this.loop = new MainLoop({
      cfg,

      llm: this.llm,
      persona: options.persona,
      decl: main[0],
      spec: () => this.activeSpec(),
      context: this.contextFacts(),
      blobs: { intern: (inputs) => this.internBlobs(inputs) },
      worlds: {
        all: () => this.worlds,

      },
      bus: this.bus,
      session: this.session,
      store: this.store,
      state: this.state,
      log: this.log.child('loop'),
      tracker: this.sessions,
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
   * 新附件字节写入日志附件库并转换为 log: 句柄；已有句柄补充 mime 和名称。
   * 无附件时返回 undefined，避免保存空数组。
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
      // 包含合成首轮对话，使继承该快照的 fork 使用相同的请求前缀。
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
    const detected = this.provider.contextWindow?.(spec.model);
    const manual = spec.contextWindow;
    if (detected === undefined) return manual;
    return manual === undefined ? detected : Math.min(detected, manual);
  }

  private contextFacts(): ContextFacts {
    return {
      hardTokens: () => {
        const spec = this.activeSpec();
        const window = this.contextWindowOf(spec);
        return window === undefined ? null : Math.max(0, window - (spec.maxTokens ?? 0));
      },
      estimateTokens: (records) => this.provider.estimateTokens?.(records, this.activeSpec()) ?? estimateMessagesTokens(records),
      contextOverflow: (error) => this.provider.contextOverflow?.(error) ?? false,
    };
  }

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
        llm: this.llm,
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
   * Persona 提供且启用 cognition 时，WorldHost 才提供该接口。
   * 请求只能列出该 World 的工具；不合法的请求返回错误，不调用 Persona。
   * Core 记录在途数供 Persona 决定并发策略。经 spawnFork 产生的用量在 fork 中记录，此处不重复计量。
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
          // Persona 异常转换为请求错误，返回 World。
          log.warn('认知请求受理失败', { err: e });
          return { error: e instanceof Error ? e.message : String(e) };
        } finally {
          this.cognitionRunning.set(mod.id, Math.max(0, (this.cognitionRunning.get(mod.id) ?? 1) - 1));
        }
      },
    };
  }

  cognitionInFlight(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, n] of this.cognitionRunning) if (n > 0) out[id] = n;
    return out;
  }

  activeSpec(): ModelSpec { return this.model; }

  private modelFacts(): ModelFacts {
    return {
      model: () => this.model.model,
      accepts: mime => this.provider.accepts?.(mime) ?? false,
      contextWindow: () => this.contextWindowOf(this.model),
    };
  }

  /** World 宿主接口;每个 World 使用以自身 id 命名的子 logger。 */
  private makeHost(mod: World): WorldHost {
    const previous = this.moduleHostLeases.get(mod);
    if (previous) previous.active = false;
    const lease = { active: true };
    this.moduleHostLeases.set(mod, lease);
    // getter 的 this 是 WorldHost；通过 self 访问 Core。
    const self = this;
    return {
      // origin 由 World 指定，默认 external；决定后续投递方式。
      pushEvent: async (
        e: Omit<EventEnvelope, 'cursor' | 'origin' | 'contextDelivery'> & { origin?: EventOrigin },
        opts?: PushOptions,
      ): Promise<EventEnvelope> => {
        if (!lease.active) throw new Error(`World ${mod.id} 的宿主生命周期已结束`);
        const deliver = opts?.deliver !== false;
        const blobs = this.internBlobs(e.blobs);
        const envelope = this.store.append({
          ...e,
          text: withBlobLines(e.text, blobs),
          ...(blobs ? { blobs } : {}),
          origin: e.origin ?? 'external',
          contextDelivery: deliver ? 'deliver' : 'archive-only',
        });
        if (deliver) {
          this.bus.push({ event: envelope }, { trigger: opts?.trigger });
        } else {
          // 仅归档事件不会经过候选处理，必须在此标记已处理以推进投递水位。
          this.loop.acknowledgeDiscarded([envelope]);
        }
        return envelope;
      },
      pushDeferred: (e, opts) => {
        if (!lease.active) return;
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
        return sourceEvents;
      },
      store: this.store,
      drainPendingEvents: async (filter) => {
        if (!lease.active) return [];
        const taken = this.bus
          .drainPending((it) => it.event?.origin === 'external' && filter(it.event))
          .map((it) => it.event as EventEnvelope);
        // 被消费的事件须标记已处理，避免投递水位停留在此并在重启后补投。
        if (taken.length > 0) this.loop.acknowledgeDiscarded(taken);
        return taken;
      },
      modelFacts: this.modelFacts(),
      blob: (handle) => this.resolveBlob(handle),
      reportUsage: (usage, opts) => {
        if (lease.active) this.reportWorldUsage(mod.id, usage, opts);
      },
      llmStalls: async (withinMs) => this.loop.llmStalls(withinMs),
      // 每次访问重新检查 Persona 开关，关闭后 getter 立即返回 undefined。
      get cognition(): CognitionHost | undefined {
        return lease.active ? self.makeCognition(mod, () => lease.active) : undefined;
      },
      log: this.runlog.logger(`worlds.${mod.id}`),
    };
  }

  private reportWorldUsage(
    worldId: string,
    usage: LLMUsage,
    opts?: { label?: string },
  ): void {
    const id = `worlds.${worldId}`;
    let track = this.moduleUsageTracks.get(id);
    if (!track) {
      track = this.sessions.open(id, opts?.label ?? `${worldId}World 自带模型`, { id });
      this.moduleUsageTracks.set(id, track);
    }
    track.record(usage);
  }

  async start(): Promise<void> {
    if (this.stopPromise) throw new Error('Core has stopped; create a new Core to resume');
    if (this.started) return;
    const dataDir = this.dataDir;
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    // 构造期已加载状态；此处再次 load 会覆盖装配后、启动前的修改。
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
    this.timers.start();
    this.runPromise = this.loop.run().catch((e) => {
      this.timers.stop();
      this.log.error('主循环异常退出', { err: e });
    });
    writeRunJson(this.run, {
      worlds: this.worlds.map((m) => m.id),
      model: this.model.model,
    });
    this.log.emit('info', 'core已启动', { event: 'started', data: { run: this.run.id } });
  }

  private validateTools(worlds: World[]): void {
    const names = new Map(this.mainDecl.tools().map(tool => [tool.name, tool]));
    for (const world of worlds) {
      for (const tool of world.tools()) {
        if (RESERVED_FRAME_NAMES.has(tool.name)) throw new Error(`Reserved tool name: ${tool.name}`);
        const existing = names.get(tool.name);
        if (existing && existing !== tool) throw new Error(`Duplicate tool name: ${tool.name}`);
        names.set(tool.name, tool);
      }
    }
  }

  /** Start the World before registering it; rebuild tools and environment at a safe loop boundary. */
  async mount(mod: World): Promise<void> {
    if (this.stopPromise) throw new Error('Core has stopped');
    this.validateTools([...this.worlds, mod]);
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

  /** 停止 World 后使租约失效、移出挂载表并重建前缀；停止失败或超时仍继续卸载。 */
  async unmount(id: string): Promise<WorldStopFailure | null> {
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

  stop(): Promise<WorldStopFailure[]> {
    return this.stopPromise ??= this.stopInternal();
  }

  private async stopInternal(): Promise<WorldStopFailure[]> {
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
    try { this.state.save(); } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log.error('Core state could not be saved', { err: error });
      failures.push({ worldId: 'core.state', detail });
    }
    for (const track of this.moduleUsageTracks.values()) track.close();
    try {
      closeRun(this.run, { endedAt: nowIso(this.config.timezone), lastCursor: this.store.latestCursor(),
        complete: failures.length === 0, reason: 'stop' });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push({ worldId: 'core.run', detail });
      this.log.error('Run closure could not be saved', { err: error });
    }
    this.log.info('core已停止');
    return failures;
  }
}
