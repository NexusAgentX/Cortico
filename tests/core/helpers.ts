import { createHash } from 'node:crypto';
import { FixtureHandoffResult as ContextHandoffResult } from './fixture-protocol.ts';
import { FixtureClient, adaptClient, adaptTap, records, messages, type FixtureTap, type FixtureHarnessApi } from './fixture-protocol.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { ChatMessage, LLMChatOptions, LLMDelta, LLMResult } from './fixture-types.ts';
import type { EventEnvelope, FirstTurnRound, CoreApi, CoreConfig, World, LLMUsage, ModelSpec, Persona, SessionDecl, ToolDef, ToolTag, ToolSchema, BlobInput, BlobRef } from '../../src/core/types.ts';
import type { BotConfig } from '../../bots/corti-soulmate/assemble.ts';
import { composeDefaults, type LoadedConfig } from '../../bots/corti-soulmate/assemble.ts';
import { validatePairing } from "./fixture-truncate.ts";
import { nullLogger } from '../../src/core/util.ts';

export function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'bot-core-test-'));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows偶发句柄滞留,忽略
      }
    },
  };
}

export function makeCfg(patch?: Partial<BotConfig>): BotConfig {
  const cfg: BotConfig = JSON.parse(JSON.stringify(composeDefaults()));
  return Object.assign(cfg, patch);
}

/**
 * 当前活跃端点的模型档(可就地改)。模型整组归 Provider,测试要改窗口/生成上限
 * 就得改这一份——Persona那边已经没有模型可改了。
 */
export function activeSpec(cfg: CoreConfig): ModelSpec {
  const entry = cfg.providers[cfg.activeProvider];
  if (!entry?.spec) throw new Error(`夹具的 provider ${cfg.activeProvider} 没有模型档`);
  return entry.spec;
}

/**
 * 一次假部署(LoadedConfig)。密钥按名字取——测试里给什么名字都返回同一个假值,
 * 除非显式给 secrets 映射。
 */
export function makeLoaded(opts: {
  config: BotConfig;
  rootDir: string;
  memoryDir: string;
  dataDir: string;
  secrets?: Record<string, string>;
}): LoadedConfig<BotConfig> {
  return {
    config: opts.config,
    secret: (name) => opts.secrets?.[name] ?? (opts.secrets ? '' : 'fake-key'),
    rootDir: opts.rootDir,
    memoryDir: opts.memoryDir,
    dataDir: opts.dataDir,
  };
}

export class FakeLLM implements FixtureClient {
  respond(request: import('../../src/protocol/open-responses/index.ts').Request, options?: import('../../src/core/generation.ts').GenerateOptions): Promise<import('../../src/core/generation.ts').Generation> {
    return adaptClient({ chat: this.chat.bind(this) }).respond(request, options);
  }
  queue: ChatMessage[] = [];
  /** 每次chat收到的入参快照(断言用) */
  calls: Array<{ spec: ModelSpec; messages: ChatMessage[]; tools?: ToolSchema[] }> = [];
  /** 队列耗尽时自然结束当前回合。 */
  fallback: () => ChatMessage = () => textReply('');
  /** 下一次chat抛出该值(断流路径用);抛完自动清除 */
  throwNext: unknown = null;
  /** 接下来连续若干次 chat 各抛一个(续拍路径用);先于 throwNext 消费,用完自动清空 */
  throwSequence: unknown[] = [];
  /** 断流前先转发这些增量(模拟"闭合过的调用已提前派发"的真实时序);用完自动清除 */
  emitBeforeThrow: LLMDelta[] | null = null;
  /** 下一次调用停在 prefill，直到调用方 signal 取消。 */
  blockUntilAbort = false;
  /** 每次回答附带的上游用量计数;undefined = 上游没报(core 只能本地估算)。 */
  usage: LLMUsage | undefined = undefined;

  script(...msgs: ChatMessage[]): void {
    this.queue.push(...msgs);
  }

  async chat(
    spec: ModelSpec,
    messages: ChatMessage[],
    tools?: ToolSchema[],
    opts?: LLMChatOptions,
  ): Promise<LLMResult> {
    this.calls.push({ spec, messages: messages.map((m) => ({ ...m })), tools });
    if (this.blockUntilAbort) {
      this.blockUntilAbort = false;
      await new Promise<never>((_resolve, reject) => {
        const signal = opts?.signal;
        if (!signal) throw new Error('阻塞测试需要 AbortSignal');
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    if (this.throwSequence.length > 0 || this.throwNext !== null) {
      let e: unknown;
      if (this.throwSequence.length > 0) e = this.throwSequence.shift();
      else { e = this.throwNext; this.throwNext = null; }
      const deltas = this.emitBeforeThrow;
      this.emitBeforeThrow = null;
      if (deltas && opts?.onDelta) for (const d of deltas) opts.onDelta(d);
      throw e;
    }
    const message = this.queue.shift() ?? this.fallback();
    if (opts?.onDelta) for (const d of messageDeltas(message)) opts.onDelta(d);
    return { message, usage: this.usage };
  }
}

/** 从完整消息合成流式增量(与真实流同序:reasoning → content → 逐个工具调用) */
export function messageDeltas(message: ChatMessage): LLMDelta[] {
  const out: LLMDelta[] = [];
  if (message.reasoning_content) out.push({ type: 'reasoning', text: message.reasoning_content });
  if (message.content) out.push({ type: 'content', text: message.content });
  (message.tool_calls ?? []).forEach((call, index) => {
    out.push({ type: 'tool_call.begin', index, id: call.id, name: call.function.name });
    if (call.function.arguments) {
      out.push({ type: 'tool_call.delta', index, argsFragment: call.function.arguments });
    }
    out.push({ type: 'tool_call.end', index });
  });
  return out;
}

let idSeq = 0;
export function nextId(prefix = 'call_'): string {
  return `${prefix}${++idSeq}`;
}

/** 模型应答:调用若干工具 */
export function toolReply(
  calls: Array<{ name: string; args?: Record<string, unknown>; id?: string }>,
  content = '',
): ChatMessage {
  return {
    role: 'assistant',
    content,
    reasoning_content: '',
    tool_calls: calls.map((c) => ({
      id: c.id ?? nextId(),
      type: 'function' as const,
      function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
    })),
  };
}

/** 模型应答:无tool_calls的纯文本 */
export function textReply(content: string): ChatMessage {
  return { role: 'assistant', content, reasoning_content: '' };
}

/**
 * 最小人格实现:一个主 session + 一个 fork 声明,足够驱动 MainLoop。
 * 核心动作的 handler 直接接到传进来的 CoreApi 上(与真实现同形状)。
 */
export function makeFakePersona(extraTools: ToolDef[] = [], opts?: FakePersonaOptions): FakePersona {
  let core: CoreApi | null = null;
  const api = (): CoreApi => {
    if (!core) throw new Error('fake persona 未 attach');
    return core;
  };
  const emergences: string[] = [];
  let pressureWarned = false;
  const primitives = corePrimitiveSpecs();
  const persona: FakePersona = {
    // core 按 Persona 返回的顺序拼接段文本。
    systemSegments: async (ctx) => {
      if (opts?.silent) return [];
      return [
        { title: 'ORIENTATION', text: 'ORIENTATION:你是测试人格。' },
        { title: 'CONSTITUTION', text: 'CONSTITUTION:测试宪法。' },
        ...ctx.worlds
          .filter((mod) => mod.envPrompt)
          .map((mod) => ({
            title: `环境:${mod.id}World`,
            text: `环境:${mod.id}World\n${mod.envPrompt}`,
          })),
        {
          title: 'tools',
          text: '完成行动后自然结束回合。',
        },
        {
          title: 'MEMORY',
          text:
            `MEMORY测试段。时间:${ctx.now.toISOString()} 时区:${ctx.timezone}\n` +
            `浮现:${emergences.join('|') || '(无)'}`,
        },
      ];
    },
    onOpening: ({ reason }) => {
      if (opts?.silent) return;
      api().injectInternal(
        reason === 'new'
          ? '[system] Session started.'
          : reason === 'cleared'
            ? '[system] Session cleared and restarted.'
            : '[system] Process restarted.',
        'opening',
      );
    },
    onDelivery: (ctx) => {
      opts?.onDelivery?.(ctx);
      if (opts?.silent) return;
      const arrived = ctx.events.filter((e) => e.origin === 'external').length;
      if (arrived === 0) return;
      api().injectInternal(
        `[system] ${arrived} new event${arrived === 1 ? '' : 's'} arrived.`,
        'notice',
      );
    },
    // 与真实现同形的批末压力裁量:软阈值先预警一次,已预警仍超则请求交接。
    onBatchEnd: () => {
      if (opts?.onBatchEnd) {
        opts.onBatchEnd(api());
        return;
      }
      const info = api().sessionInfo('main');
      if (info.estTokens === null) return;
      const cfg = opts?.cfg ?? composeDefaults();
      if (info.estTokens <= cfg.context.maxTokens * cfg.context.softRatio) return;
      if (opts?.pressureNotice === null || opts?.silent) {
        api().requestContextHandoff();
        return;
      }
      if (!pressureWarned) {
        pressureWarned = true;
        api().injectInternal(
          opts?.pressureNotice ?? '[system] Context will truncate soon.',
          'notice',
        );
        return;
      }
      api().requestContextHandoff();
    },
    toolUsageText: () => '完成行动后自然结束回合。',
    tools: () => extraTools,
    emergences: () => [...emergences],
    attach: (h) => {
      core = h;
    },
    declareSessions: () => [
      {
        id: 'main',
        label: '主意识',
        rounds: () => ({
          soft: opts?.cfg?.loop.softCap ?? composeDefaults().loop.softCap,
          hard: opts?.cfg?.loop.hardCap ?? composeDefaults().loop.hardCap,
          softHint: () => (opts?.softHint === undefined
            ? '[system] You have been acting for many rounds this turn. Call end_turn to end the turn when you are done.'
            : opts.softHint),
        }),
        persistent: true,
        receivesEvents: true,
        tools: () => [
          ...primitives.map((spec) => ({
            ...spec,
            handler: async (args: Record<string, unknown>): Promise<string> => {
              if (spec.name === 'fork') return opts?.onFork?.(args) ?? '[fork not wired]';
              if (spec.name === 'schedule_wake') return fakeScheduleWake(api(), args);
              return `[unknown core action: ${spec.name}]`;
            },
          })),
          ...extraTools,
          ...(opts?.worlds ?? [])
            .slice()
            .sort((a, b) => a.id.localeCompare(b.id))
            .flatMap((m) => m.tools()),
        ],
        ...opts?.mainPatch,
        outputTap: adaptTap(opts?.mainPatch?.outputTap),
      },
      ...(opts?.extraSessions ?? []),
    ],
    onHandoff: async (snapshot, ctx) => {
      pressureWarned = false;
      if (opts?.onHandoff) {
        const result = await opts.onHandoff(messages(snapshot), ctx);
        return { ...result, tail: result.tail ? records(result.tail) : null };
      }
      if (!opts?.silent) {
        api().injectInternal('[system] Context truncation just completed.', 'handoff');
      }
      return { tail: null };
    },
    ...(opts?.firstTurn ? { firstTurn: opts.firstTurn } : {}),
    // 指向一个保证不存在的路径:若解析到真实的 persona/ 目录,
    // readdirSync(memoryDir) 会读到当下的 proposals/ 文件,测试结果就随真实运行状态漂移。
    memoryDir: '__fake_persona_dir_does_not_exist__',
    blobs: { put: (name: string) => `mem:${name}`, get: () => null, list: () => [] },
  };
  return persona;
}

/** 核心动作的 schema(与真实现同名同形,handler 由上面接到 CoreApi) */
function corePrimitiveSpecs(): Array<{
  name: string;
  description: string;
  tags: readonly ToolTag[];
  parameters: Record<string, unknown>;
}> {
  return [
    {
      name: 'fork',
      description: '并发思路',
      tags: ['flow'],
      parameters: { type: 'object', properties: { mode: { type: 'string' }, task: { type: 'string' } } },
    },
    {
      name: 'schedule_wake',
      description: '定时唤醒',
      tags: ['flow'],
      parameters: {
        type: 'object',
        properties: {
          at: { type: 'string' },
          after_minutes: { type: 'number' },
          note: { type: 'string' },
        },
      },
    },
  ];
}

/** 潜意识那一面(SubconsciousPersona)与 core 那一面(Persona)都齐 */
export interface FakePersona extends Persona {
  emergences(): string[];
  tools(sessionId: string): ToolDef[];
  toolUsageText(sessionId: string): string;
}

export interface FakePersonaOptions {
  /** 模型档位与轮数上限的来源(缺省用 DEFAULT_CONFIG) */
  cfg?: BotConfig;
  /** 额外的 session 声明(测 fork 原语用);会接在主声明之后 */
  extraSessions?: SessionDecl[];
  /** 覆盖主声明的字段(测"必须恰好一个接收投递的常驻session") */
  mainPatch?: Omit<Partial<SessionDecl>, 'outputTap'> & { outputTap?: FixtureTap | SessionDecl['outputTap'] };
  /** 主 session 工具表里要并进来的 World */
  worlds?: World[];
  /** fork 工具的执行体(真实现里是潜意识) */
  onFork?: (args: Record<string, unknown>) => Promise<string>;
  /** 上下文交接策略(真实现里是"梦 + 按 keepRatio 留尾");覆盖时醒来消息也归你注入 */
  onHandoff?: (snapshot: ChatMessage[], ctx: { hardTokens: number | null }) => Promise<ContextHandoffResult>;
  /** 投递刻时机钩子的旁观者(断言收编行为用;在默认抬头注入之前调) */
  onDelivery?: (ctx: { events: EventEnvelope[] }) => void;
  /** 完全接管批末时机钩子(压力裁量测试用) */
  onBatchEnd?: (api: CoreApi) => void;
  /** 软压力预警文本;null=不预警,超软阈值直接请求交接 */
  pressureNotice?: string | null;
  /** 软轮数上限那一轮拼在回执末尾的提醒;null=不拼。缺省一句英文(老断言照旧)。 */
  softHint?: string | null;
  /** 合成首轮对话(风格锚)的内容;不给=人格不提供该机制 */
  firstTurn?: () => FirstTurnRound[];
  /**
   * 沉默人格:所有时机钩子不注入任何话语(压力裁量退化为直接请求交接)。
   * 用来验收 core 不会自己往上下文写任何一句话。
   */
  silent?: boolean;
}

/** 与真实现同形状的 schedule_wake 参数解析(闹钟语义归Persona,经 timers 原语落地) */
async function fakeScheduleWake(
  core: CoreApi,
  args: Record<string, unknown>,
): Promise<string> {
  const rawAt = typeof args.at === 'string' ? args.at.trim() : '';
  const afterMinutes = Number(args.after_minutes);
  let at = rawAt;
  if (!at) {
    if (!Number.isFinite(afterMinutes) || afterMinutes <= 0) {
      return '[bad input] provide at or a positive after_minutes';
    }
    at = new Date(Date.now() + Math.max(10_000, afterMinutes * 60_000)).toISOString();
  }
  const r = core.timers.set(at, { note: String(args.note ?? '') });
  return r.ok ? `[system/scheduled] Wake set for ${at} (id: ${r.id}).` : `[bad input] ${r.error}`;
}

/**
 * Persona看到的 core 表面。默认提供无副作用实现,单测按需覆盖。
 */
export function makeFakeHarnessApi(patch: Partial<FixtureHarnessApi> = {}): CoreApi {
  const state: Record<string, unknown> = {};
  return {
    blob: () => null,
    injectInternal: () => {},
    injectDeferred: () => {},
    injectExternal: () => {},
    requestContextHandoff: () => true,
    timers: {
      set: () => ({ ok: true, id: 'timer_fake' }),
      cancel: () => false,
      list: () => [],
      clearAll: () => 0,
      onDue: () => {},
    },
    deliveryGate: {
      set: () => {},
      clear: () => false,
      isBlocked: () => false,
    },
    personaState: () => state,
    savePersonaState: () => {},
    toolsTagged: () => new Set<string>(),
    log: nullLogger(),
    ...patch,
    llm: adaptClient(patch.llm ?? new FakeLLM()),
    spawnFork: options => patch.spawnFork?.({ ...options, messages: messages(options.messages) }) ?? Promise.resolve(''),
    sessionInfo: id => {
      const info = patch.sessionInfo?.(id) ?? { id, running: 0, snapshot: null, estTokens: null, hardTokens: null };
      return { ...info, snapshot: info.snapshot ? records(info.snapshot) : null };
    },
  };
}

/**
 * 假 World 的环境提示词模板也走真文件——框架只从 `role: 'envPrompt'` 的模板取文本,
 * 测试不该有一条绕开模板的捷径,否则钉不住"前缀只来自模板"这条不变量。
 */
const FAKE_TEMPLATE_DIR = mkdtempSync(join(tmpdir(), 'bot-fake-worlds-'));
let fakeTemplateSeq = 0;

export function makeFakeIO(id: string, tools: ToolDef[] = [], staticText = ''): World {
  const path = join(FAKE_TEMPLATE_DIR, `${id}-${++fakeTemplateSeq}.md`);
  writeFileSync(path, staticText || `${id}World 环境。`, 'utf8');
  return {
    id,
    envPromptVars: () => ({}),
    console: () => ({
      promptDocs: [
        { key: `worlds.${id}.envPrompt`, title: `${id} · 环境提示词`, description: '测试模板', path, role: 'envPrompt' as const },
      ],
    }),
    tools: () => tools,
    start: async () => {},
    stop: async () => {},
  };
}

/** 改假 World 的环境提示词 = 改它的模板文件(与真 World 同一条路径)。 */
export function rewriteFakeIOTemplate(mod: World, text: string): void {
  const doc = mod.console?.()?.promptDocs?.find((d) => d.role === 'envPrompt');
  if (!doc) throw new Error(`${mod.id} 没有环境提示词模板`);
  writeFileSync(doc.path, text, 'utf8');
}

export function makeTool(name: string, result: string | (() => string | Promise<string>)): ToolDef {
  return {
    name,
    description: `测试工具${name}`,
    tags: [],
    parameters: { type: 'object', properties: {} },
    handler: async () => (typeof result === 'function' ? result() : result),
  };
}

export function assertPairing(msgs: ChatMessage[]): void {
  expect(validatePairing(msgs)).toEqual([]);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * MainLoop 依赖里的附件内部化假件:新字节按内容哈希发 `log:` 句柄并记在内存,
 * 已有句柄原样保留。rig 用它,断言可以从返回的 map 读回字节。
 */
export function fakeBlobIntern(): { intern(inputs: readonly (BlobInput | BlobRef)[] | undefined): BlobRef[] | undefined; bytes: Map<string, Uint8Array> } {
  const bytes = new Map<string, Uint8Array>();
  return {
    bytes,
    intern: (inputs) => {
      if (!inputs?.length) return undefined;
      return inputs.map((b) => {
        if (!('bytes' in b)) return { handle: b.handle, mime: 'mime' in b ? b.mime : 'application/octet-stream', fallbackText: b.fallbackText };
        const handle = 'log:' + createHash('sha1').update(b.bytes).digest('hex').slice(0, 12) + (b.mime === 'image/png' ? '.png' : '.bin');
        bytes.set(handle, b.bytes);
        return { handle, mime: b.mime, ...(b.name ? { name: b.name } : {}), fallbackText: b.fallbackText };
      });
    },
  };
}
