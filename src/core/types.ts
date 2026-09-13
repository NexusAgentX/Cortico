import type { PriceDefinition } from '../providers/pricebook.ts';
import type { ContextRecord } from '../protocol/open-responses/context.ts';
import type { StreamEvent } from '../protocol/open-responses/index.ts';
import type { ResponseClient, ProviderAttempt } from './generation.ts';
import type { ConfigGroup } from './config-schema.ts';

export type { ConfigGroup, ConfigProperty, ConfigValues } from './config-schema.ts';

/**
 * Shared contracts between the core, persona cores, and I/O worlds. Session identifiers
 * are opaque to the core.
 */


/**
 * 事件正文的上下文分区：external 进入工具回执区，internal 进入 user 区。
 * 两类事件共用总线、批次、闸门和事件库。
 */
export type EventOrigin = 'external' | 'internal';

/**
 * 事件的分类特征,与 ToolTag 同款:封闭联合,每个成员都有机械消费方。 World 按需打,
 * 不打 = 没有该特征。
 *
 *  - `snapshot`:报此刻状态的事件(世界快照、任务进度),新的一条覆盖旧的一条。
 *    消费方是交接笔记——同 source/type 只留最后一条。状态与结果混在一个 type 里的
 *    World 要先拆 type,tag 是分类,不是覆盖键。
 *  - `speak`:播放台词结果，交接笔记仅保留最近段。
 */
export type EventTag = 'snapshot' | 'speak';

/**
 * 所有 session 事件共用的持久化信封；cursor 是落库时分配的全局递增序号。
 * 事件库属于 core 运行日志且不通过 CoreApi 暴露，agent 经 World 历史工具按
 * 语义字段查询。
 */
export interface EventEnvelope {
  cursor: number;
  /** 落库时的 run;cursor 跨 run 全局单调,run 说明它躺在哪个分片里 */
  run?: string;
  /** 产生方词表,如 "qq.message" / "terminal.message" / "tick" / "worlds.note" */
  type: string;
  /** ISO 8601 带时区偏移 */
  ts: string;
  /** 产生方 id: World id | "core"(开场/交接/压力提示) | "persona"(Persona注入) */
  source: string;
  /** 外部还是内部。 World pushEvent 不填时 core 代填 external */
  origin: EventOrigin;
  /** 分类特征(见 EventTag);不填 = 没有任何特征 */
  tags?: readonly EventTag[];
  /**
   * 事件是否可进入模型上下文。旧记录缺字段时按 `deliver` 解释。
   * `archive-only` 正常投递由投影承载；水位之后且无投影引用的外部原文可在重启时补投。
   */
  contextDelivery?: 'deliver' | 'archive-only';
  /**
   * 归一化正文:渲染好的可读文本行(谁、几点、@了谁、回复了哪条),
   * 直接进入上下文。例 `[21:32] 阿明: 在吗`。
   * core 渲染时一个字都不加;游标只是事件库的定位下标,不进 text,
   * agent 看到的 `#<message_id>` 是 World 自带的平台消息号,与游标是两个命名空间。
   */
  text: string;
  /** 按人过滤的稳定键(QQ 号字符串、终端会话名等),供 qq_read_history/grep 用 */
  senderKey?: string;
  /** 驱动层私有数据(平台原生 ID 映射等),不渲染给 agent */
  meta?: Record<string, unknown>;
  /**
   * 随记录落库的附件：pushEvent 接收 BlobInput，落库时转成 BlobRef 并将可读文本附在正文后。
   * 投递时并入承载事件的上下文记录，渲染层按模型接受的 mime 决定是否附加内容分片。
   */
  blobs?: BlobRef[];
  /**
   * 自消解事件照常落库、投递和唤醒，在下一批唤醒到来时从 session 移除。仅当整批内部项都标记 ephemeral 且没有外部正文时生效。
   */
  ephemeral?: true;
}

/**
 * 投递成文载荷:push 时只给渲染回调,发车那一刻才成文并落库。
 *
 * 契约:
 *  - `render` 在投递刻调用,可异步,但必须快——读现成状态,不许现场长采样;
 *    超过投递侧 deadline 按 null 处理。
 *  - 返回 null(或超时/抛错)→ 整条蒸发:不落库、不投递。
 *  - 游标与时间戳在投递刻分配。正文描述的是投递刻的世界,戳打在 push 刻
 *    就是让时间戳和内容说两个时刻的话;push 刻只是"World 何时布置了这次观察",
 *    是行政时刻,不是经历时刻。
 *  - 进程死亡时排队中的项直接蒸发,不参与重启补投——陈旧观察不该被补看。
 */
export interface DeferredEventSpec {
  /** 事件词表 type,与即时成文事件同一命名空间 */
  type: string;
  /** 产生方 id: World id | "persona" | "core" */
  source: string;
  origin: EventOrigin;
  senderKey?: string;
  meta?: Record<string, unknown>;
  tags?: readonly EventTag[];
  /** 发车刻调用;null → 蒸发。带附件时返回 { text, blobs } */
  render: () => DeferredRendered | null | Promise<DeferredRendered | null>;
}

/** 投递成文的渲染结果:纯文本,或正文加附件。 */
export type DeferredRendered = string | { text: string; blobs?: BlobInput[] };

/** 候选原始事件：宿主以 `archive-only` 落库并填入来源与游标。 */
export type CandidateSourceEvent = Omit<
  EventEnvelope,
  'cursor' | 'source' | 'origin' | 'contextDelivery'
>;

/** 投影在发车刻分配时间戳与游标。 */
export type CandidateProjectionEvent = Omit<CandidateSourceEvent, 'ts'>;

/** projector 的一条输出；候选下标按它收编的源票据编号。 */
export interface CandidateProjection {
  candidateIndexes: readonly number[];
  event: CandidateProjectionEvent;
}

export interface CandidateEventSpec {
  source: string;
  origin: EventOrigin;
  /** 本票据对应的原始归档，按到达顺序。 */
  sourceEvents: readonly EventEnvelope[];
  /** 仅供投递闸门做字面关键词匹配，不渲染进上下文。 */
  gateText: string;
  /** 来源 World 的内存态候选；core 不解释。 */
  value: unknown;
  project: CandidateProjector;
}

/** 同一来源、同一 projector 在当前发车批内一次性选择。 */
export type CandidateProjector = (
  candidates: readonly CandidateEventSpec[],
) => readonly CandidateProjection[];

export interface CandidatePushSpec {
  /** 每条都单独作为原始历史归档。 */
  sourceEvents: readonly CandidateSourceEvent[];
  gateText: string;
  value: unknown;
  project: CandidateProjector;
  origin?: EventOrigin;
}

/**
 * 总线项:即时成文(push 刻已落库的事件)或投递成文(发车刻渲染,见
 * DeferredEventSpec)。两者与 TriggerMode 四档完全正交——何时唤醒与何时成文
 * 是两根独立的轴。
 */
export type WakeItem =
  | { event: EventEnvelope; deferred?: undefined; candidate?: undefined }
  | { event?: undefined; deferred: DeferredEventSpec; candidate?: undefined }
  | { event?: undefined; deferred?: undefined; candidate: CandidateEventSpec };


export interface EventRangeQuery {
  /** 游标区间(含端点) */
  fromCursor?: number;
  toCursor?: number;
  /** ISO时间区间(含端点) */
  fromTs?: string;
  toTs?: string;
  /** 按人过滤 */
  senderKey?: string;
  /** 按来源 World 过滤 */
  source?: string;
  /**
   * 按外部/内部过滤。库里同时躺着两者,而面向 agent 的历史工具几乎总是只要
   * external——内部项是 core 的运行记录,不该混进"谁说过什么"的查询结果。
   */
  origin?: EventOrigin;
  /** 最多返回条数(从区间尾部取,保证"最近优先") */
  limit?: number;
}

export interface EventGrepQuery {
  /** 关键词(纯文本包含匹配;实现可扩展为不区分大小写) */
  keyword: string;
  /** 每个命中自动附带前后各N条上下文 */
  context: number;
  senderKey?: string;
  source?: string;
  origin?: EventOrigin;
  fromTs?: string;
  toTs?: string;
  /** 最多返回命中组数 */
  limit?: number;
}

export interface EventGrepHit {
  hitCursor: number;
  /** 命中事件与相邻上下文,按游标升序。 */
  events: EventEnvelope[];
}

export interface EventStoreReader {
  get(cursor: number): EventEnvelope | undefined;
  latestCursor(): number;
  range(q: EventRangeQuery): EventEnvelope[];
  /** 游标邻域:cursor前before条+自身+后after条 */
  around(cursor: number, before: number, after: number): EventEnvelope[];
  grep(q: EventGrepQuery): EventGrepHit[];
}

export interface EventStore extends EventStoreReader {
  /** 落库并分配游标。纯落库,不涉及投递。 */
  append(e: Omit<EventEnvelope, 'cursor'>): EventEnvelope;
}


/** 发给LLM API的工具schema(OpenAI function格式的function字段) */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema 对象 */
  parameters: Record<string, unknown>;
}

/**
 * 工具能力tag(装配层过滤用,不发给LLM)。tag 是分类轴:这次调用在她的叙事里是什么;
 * 怎么执行(串行屏障、收工)是 ToolDef 上的布尔,不进 tag。
 *  - read:  不改变外部世界、也不改变她的持久状态的查询(读工作区/读历史/看图/试算)。
 *           耗时、成本与是否占用 World 执行器都不由本 tag 保证(mc_scout 进执行器队列,
 *           web_search 联网,mc_check 读区块),并发安全不能从它推出。
 *  - write: 改写持久状态:她的记忆与工作区,以及 World 的常驻内部状态(规矩/目标/路标/蓝图)
 *  - speak: 发出她的话——观众或操作员会读到、听到的外流;对自己输出通道的动作
 *           (vtuber_interrupt)也归这里,交接笔记的最近段要看见她掐过自己
 *  - act:   改变外部世界的状态,但不产生她的话(挖方块、落子、紧急脱离)
 *  - flow:  core流程原语(fork/schedule_wake/surface)
 *  - snapshot: 回执是此刻状态的读数(队列、背包、画面),新的一次覆盖旧的一次;
 *           与其他 tag 并存(一般是 read)。消费方是交接笔记:同名只留最后一次。
 * 场景装配按 tag 取子集:如联想 fork 只注入 read 类 IO 工具的 schema。
 *
 * speak 与 act 必须分开:两者曾同挤在 speak 一格里(注释写的是"对外部世界发言
 * 或产生外部副作用"),于是 mc_do、mc_stop 也被标成 speak——任何"禁言但允许
 * 行动"的过滤都会连挖矿一起禁掉。
 *
 * 说明书必须与实际工具表严格一致;未声明的工具会在 fork 中表现为未装配。
 */
export type ToolTag = 'read' | 'write' | 'speak' | 'act' | 'flow' | 'snapshot';

export interface ToolCallContext {
  /**
   * 调用发生在哪个session。值是Persona自己定义的不透明字符串,
   * core只把它当查表键、归账标签和日志标签,不知道它的语义。
   */
  role: string;
  log: Logger;
  /**
   * 工具执行期间取到的外部事件经这里交还主循环:本轮工具结果之后按常规投递
   * (到达通知 + 正文),不混进这次调用自己的 tool result。
   * 仅主意识接线；子会话和直接单测可不提供。
   */
  queueExternalEvents?: (events: EventEnvelope[]) => void;
  /**
   * 本次调用在 session 里的 tool_call id。 World 据此把"这一次调用"与输出旁路里
   * 捕获到的同一调用对上号,也是后续执行结果事件的关联键。
   * 直接单测可不提供。
   */
  callId?: string;
  /**
   * 本次调用属于主循环的哪一轮推理:进程内单调递增,同一轮里的多次工具调用同号。
   * 消费方(如 worlds-minecraft 只读原语的一轮一答闸)据此识别「同一轮再问」。
   * 仅主意识接线;子会话和直接单测可不提供,认不出轮的消费方应照常作答。
   */
  round?: number;
  /**
   * 本次工具调用已被宿主放弃。耗时工具必须在提交外部副作用前检查它；
   * 跨进程代理超时也会触发该信号，避免迟到的结果继续改变运行态。
   */
  signal?: AbortSignal;
}

/**
 * 工具执行的完整产出:正文 + 可选二进制附件。字符串返回值等价于 `{ text }`——
 * 绝大多数工具仍然只回文本。附件随回执落库(句柄由 core 分配),文本形态接在正文后。
 */
export interface ToolOutcome {
  text: string;
  blobs?: BlobInput[];
  /** 执行失败(handler 抛出、参数不是合法 JSON)。工具流水的 failed 列读它。 */
  failed?: true;
}

/** handler 返回 tool result 正文;异常由 core 转换为失败 result。 */
export interface ToolDef extends ToolSchema {
  /**
   * 能力tag(装配层按场景过滤)。必填:空数组=作者明确选择不分类
   * (不参与任何tag过滤,只进main);挂载时对空数组打一条warn提醒。
   */
  tags: readonly ToolTag[];
  /**
   * 执行后必须先让模型读取本工具结果，再允许后续动作。
   * 同一assistant消息里排在它后面的调用会被跳过；QQ draft用它落实一次复核。
   */
  barrierAfter?: boolean;
  /**
   * 工具执行完成后结束本次唤醒，不再调用下一轮模型。期间到达的事件退回总线，形成下一批唤醒；通常同时设置 barrierAfter，使后续工具调用得到未执行回执。
   */
  endsTurn?: boolean;
  handler: (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string | ToolOutcome>;
}

/** 无handler的工具规格(fork/schedule_wake 的 schema 段;handler 由Persona自行绑定成 ToolDef) */
export type ToolSpec = ToolSchema & { usage?: string; tags: readonly ToolTag[] };


/**
 * 记忆里二进制工件的后端,由Persona提供。句柄以 `mem:` 起头,其后的形状归后端
 * (Cormini 用工作区相对路径)。put 的 nameHint 只是名字提示,最终句柄由后端定。
 */
export interface BlobStore {
  put(nameHint: string, bytes: Uint8Array, mime: string): string;
  get(handle: string): { bytes: Uint8Array; mime: string } | null;
  list(prefix?: string): Array<{ handle: string; mime: string; size: number }>;
}

/**
 * 记录落库后对一份二进制附件的引用。句柄两个 scheme:`log:` 日志附件(core 分配,
 * 内容寻址)、`mem:` 记忆工件(Persona的 BlobStore 解析);见 src/core/blobs.ts。
 * core 对内容不做解释,唯一理解的是"当前模型吃不吃得下这个 mime"(ModelFacts.accepts):
 * 吃得下就另发内容分片,吃不下就只有 fallbackText 那一行。
 */
export interface BlobRef {
  handle: string;
  mime: string;
  name?: string;
  /** 这份附件进入 session 的文本形态;提供方总是给 */
  fallbackText: string;
}

/**
 * 记录上待落库的一份附件:新字节随本记录落进日志附件库,或一个已有句柄(`log:` / `mem:`)
 * 只附着。两种都必须带 fallbackText:持久化对象必有一个进上下文的形态。
 */
export type BlobInput =
  | { bytes: Uint8Array; mime: string; name?: string; fallbackText: string }
  | { handle: string; fallbackText: string };

/** 帧 sidecar 里的一条:事件的库内事实 + 正文位置(content.slice(start, start + chars)) */
export interface FrameEventRef {
  cursor: number;
  ts: string;
  type: string;
  source: string;
  tags?: readonly EventTag[];
  start: number;
  chars: number;
}

export interface ModelSpec {
  model: string;
  /** false = 请求关掉思维链(`reasoning.effort: 'none'`);true = 开着,深浅由 `reasoningEffort` 定。 */
  thinking: boolean;
  /**
   * 仅 thinking=true 时有效;undefined = 不发,走端点默认。词表归端点:声明了
   * `reasoningTiers` 的模块只收表内的值,开放模块收任意非空字符串。
   */
  reasoningEffort?: string;
  /** 采样温度。缺席 = 不发这个字段,走端点默认;三条方言的请求体都照发它。 */
  temperature?: number;
  maxTokens?: number;
  /**
   * 手填的上下文窗口上限(token)。生效窗口取它与 Provider 实例探到的上游自报值
   * 中较小的一个;两者都缺席时 core 没有窗口事实,不做物理钳制。
   */
  contextWindow?: number;
}

/**
 * 一个可选的推理档位。**这是给人看的档位轴**:控制台把"思考开不开"与"想多深"
 * 合成同一个选择——对操作者来说本来就是一根轴,拆成勾选框 + 强度下拉只会让人
 * 组合出端点不接受的搭配(思考关掉 + 强度拉满那一类)。
 *
 * 存储侧仍是 `ModelSpec.thinking` + `reasoningEffort` 两个字段(选中档位就发这两个值),
 * 档位只是它们的一层如实命名——**档位表按 provider 方言给**,因为词表本来就因端点而异:
 * 有的端点思维链关不掉也没有 max 档。空表 = 开放:effort 由操作者自填,模块只给候选。
 */
export interface ReasoningTier {
  /** 稳定 id(下拉的 value);同一方言内唯一 */
  id: string;
  label: string;
  /** 选中这一档就发这两个值 */
  thinking: boolean;
  effort?: string;
  /** 可选的一句实话(如"这个端点关不掉") */
  note?: string;
}

/**
 * 可选的 service_tier，由方言列出实际支持的档位。端点不接受的档位不展示；OpenAI 档位名不代表所有兼容端点都支持。
 */
export interface ServiceTier {
  /** 稳定 id,同时就是发上线的 `service_tier` 值 */
  id: string;
  label: string;
  /** 可选的一句实话(如"实测没测出收益") */
  note?: string;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens?: number;
}

/** 持久化的单次 LLM 调用记录(data/usage.jsonl 一行一条),分时段成本页的数据源 */
export interface UsageRecord {
  recordId?: string;
  version?: 2;
  /** 发生调用的 run */
  run?: string;
  /** 发生调用的主循环轮次(fork 与 World 自报用量没有) */
  round?: number;
  attempt?: ProviderAttempt;
  /** Voluntary IO-owned accounting without attribution to the active Provider. */
  charges?: import('./generation.ts').Charge[];
  /** 本地时区 ISO(nowIso 格式,可直接按前缀切时/天桶) */
  ts: string;
  /** 发生调用的 session 实例 id(常驻session用声明id,fork按序号派生) */
  sessionId: string;
  /** session 声明 id(Persona定义的不透明字符串;归账与分类标签) */
  role: string;
  label: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
  /**
   * 调用终态，缺席表示 success。failed 表示没有可用结果；discarded 表示上游已成功返回，但结果因关机或换代被丢弃。
   * 两者的实际用量均计入总消耗，并在 UsageAggregate.failed 中单列。
   */
  outcome?: 'failed' | 'discarded';
  /**
   * 请求前缀的滚动 SHA 指纹，取前 12 位，仅用于观测。可据此区分前缀变化与前缀相同时的上游缓存未命中。
   */
  prefixHash?: string;
  /** 失败行专有:开流 → 失败的墙钟耗时(ms)。故障指纹的第三元。 */
  failedAfterMs?: number;
  /** 失败行专有:上游请求 id,拿去跟供应商对账的唯一线索。 */
  requestId?: string;
  /** 失败行专有:LLMError.status(0 = 流内失败,不是 HTTP 码)。 */
  status?: number;
}

/** 单个 session 的轮数边界:soft=附收尾提醒,hard=直接结束。 */
export interface RoundCaps {
  soft: number;
  hard: number;
  /**
   * 第 `soft` 轮的工具回执末尾要拼的提醒;null 或缺席 = 不拼。措辞归Persona,
   * core 只负责拼接(与 ForkOptions.wrapUpHint 同族)。
   */
  softHint?: () => string | null;
}

/**
 * Persona在启动时向 core 注册的一组 session 声明。
 * id 由Persona定义,core 从不对它的值做分支——只用作查表键、归账标签和
 * 日志标签。"主意识"退化为一个属性:receivesEvents 为真的那个 session。
 *
 * rounds / tools 是函数:配置可热改(控制台、调参工具),core 每次用时实时读,
 * 不持启动期快照。
 *
 * **这里没有模型**:用哪个模型、怎么想全归 Provider(`LLMProviderEntry.spec`),
 * 一个端点一份。id 只作查表键、归账标签与日志标签——角色轴留着,只是不再挂模型。
 */
export interface SessionDecl {
  id: string;
  /** 仪表与日志上的展示名 */
  label: string;
  rounds: () => RoundCaps;
  /** 是否是落盘常驻会话(false=临时 fork,跑完即结束) */
  persistent: boolean;
  /** 是否接收外部事件投递 */
  receivesEvents: boolean;
  /**
   * 外部事件正文落在上下文的哪个区。与 receivesEvents 一样是结构性
   * 选择,不随配置热改:
   *
   *  - `tool`(默认):落在一对伪造的 `external_event_frame` 调用/回执里。它是
   *    保留帧,不是工具;模型仿造的同名调用被 core 丢弃。**user 消息因此
   *    只装内部系统文本,外面来的话一律在工具回执区**——这条边界是可机械检查的,
   *    该边界保证外部正文无法进入 system role。
   *  - `user`:正文直接进那条 user 消息。Persona据此显式放弃上面那条边界,
   *    换来更短的上下文(实时对话、直播这类场景要的就是这个)。
   *
   * 两种模式下,"到达抬头"这类话语都由Persona在 `onDelivery` 时机自己注入
   * (不注入就没有抬头,core 不自己加);`user` 模式下注入行排在外部正文之前。
   */
  eventDelivery?: 'tool' | 'user';
  /**
   * 输出旁路,eventDelivery 的输出侧对称物:输入侧决定事件正文怎么进
   * 上下文,这里决定模型输出在生成途中流向哪。声明了它,本 session 每轮 LLM
   * 调用都以流式进行并把增量转发给 tap;undefined=不流式,行为不变。
   * 同为结构性选择,不随配置热改。
   */
  outputTap?: OutputTap;
  tools: () => ToolDef[];
}

/**
 * session 的输出旁路。core 只转发增量,不认识其中任何词表;把增量切成
 * 演出单元之类的语义归提供 tap 的那一方(装配层把 World 的接收器填进声明)。
 */
export interface OutputTap {
  onEvent(event: StreamEvent): void;
  externalizes?(event: StreamEvent): boolean;
  onRoundEnd?(): void;
  onAbort?(reason: string): void;
}

/** 一次 fork(临时 session)的调用参数。 */
export interface ForkOptions {
  /** 已声明的 session id;模型档位/轮数上限/默认工具集从声明里取 */
  id: string;
  /** 这次 fork 的完整消息数组(继承快照与引导由Persona自己拼) */
  messages: ContextRecord[];
  /** 覆盖声明里的工具集 */
  tools?: ToolDef[];
  /** 每轮工具执行后检查:true=目标已达成,立即收线 */
  stopWhen?: () => boolean;
  /** 收尾轮(声明的 rounds().soft)附在工具结果后的收尾提醒 */
  wrapUpHint?: string;
  /** 撞满硬上限时追加到返回正文末尾的一句话;没有它,半截活会被当成结论 */
  capNote?: string;
  /**
   * 补提醒轮:循环自然结束后若 when(最后正文) 为真,机械追加一条 user 提醒
   * 再跑最多一轮(对抗 thinking 模型"写正文不调工具"的惯性)。
   */
  nudge?: { when: (lastContent: string) => boolean; message: string };
}

/** 提供给Persona的 session 只读查询结果。 */
export interface SessionInfo {
  id: string;
  /** 该声明当前正在运行的实例数(core 的并发记账) */
  running: number;
  /** 常驻 session 的当前消息快照;临时 session 返回 null */
  snapshot: ContextRecord[] | null;
  /**
   * 下一次请求的输入 token 数:上一发上游报的计数加此后新增条目的估算;没有上游
   * 计数时整份估算。只有接收事件投递的常驻 session 有值;fork 为 null。
   */
  estTokens: number | null;
  /**
   * 该 session 一次请求能收的输入上限:模型窗口减单轮生成上限。core 越过它
   * 即强制交接。窗口未知时 null;同上仅主 session 有值。
   */
  hardTokens: number | null;
}

/** 上下文交接的语义半返回值。醒来想说什么经注入原语走,不在这里。 */
export interface ContextHandoffResult {
  /** 新的动态尾(不含 system 前缀);null=交给 core 按机械默认重建 */
  tail: ContextRecord[] | null;
  /**
   * tail 是"整段候选材料",预期越过物理上限,请照机械默认裁剪。
   *
   * Persona只想**改写尾巴的内容**、不想自己裁长度时用它。不给这一位而交回
   * 越过 hardTokens 的尾巴,按Persona出错处理并告警。
   */
  trim?: boolean;
}

/**
 * 方向二:Persona请求 core 做事。
 * Persona只能通过此接口访问 core。
 */
export interface CoreApi {
  /**
   * 送一条内部唤醒项进接收事件的那个 session(即时成文:push 刻落库,文本固定)。
   * 文本由Persona撰写。
   */
  injectInternal(text: string, kind?: string): void;
  /**
   * 送一条投递成文的内部唤醒项:发车刻调用 render 成文并此刻落库(心跳这类
   * "报此刻状态"的文本,时间与安静时长按投递那一刻算)。null → 蒸发。
   * 契约同 DeferredEventSpec。
   */
  injectDeferred(kind: string, render: () => string | null | Promise<string | null>): void;
  /**
   * 以外部事件的身份投递Persona写好的正文(即时成文,source 记 persona,origin
   * external):进事件帧,不进 [system] 提示行。交接笔记这种"发生过什么"的记录走它。
   */
  injectExternal(text: string, kind?: string): void;
  /** 在安全回合边界请求一次上下文交接事务;已有请求在途时返回 false。 */
  requestContextHandoff(): boolean;
  /** 创建一个临时 session 跑完工具循环,返回它最后一段正文。 */
  spawnFork(opts: ForkOptions): Promise<string>;
  /** 按 id 只读查询 session 状态。 */
  sessionInfo(id: string): SessionInfo;
  /** 带用量归账与重试的 LLM 调用。 */
  llm: ResponseClient;
  /** 通用持久定时器:到点回调、跨重启恢复;载荷对 core 不透明。 */
  timers: TimersApi;
  /** 投递闸门:扣留一切唤醒项,整批 FIFO 放行。安装/解除与到期语义归Persona。 */
  deliveryGate: DeliveryGateApi;
  /**
   * 对 core 不透明的人格持久状态,按原子写入保存。
   * 返回活对象;修改后调用 savePersonaState()。
   */
  personaState(): Record<string, unknown>;
  savePersonaState(): void;
  /**
   * 当前主 session 工具表里带某个 tag 的工具名。
   *
   * Persona不认识 World 的具体工具,但有时需要按**能力类别**处理它们——
   * 比如交接时把"她自己说过的话"占位化,那要先知道哪些调用是 speak 类。
   * tag 是这条边界上唯一的共同语言:World 自报 tag,Persona按 tag 取子集,
   * 谁也不必知道对方的名字。
   */
  toolsTagged(tag: ToolTag): ReadonlySet<string>;
  /** 按句柄取回一份二进制(同 WorldHost.blob);Persona把日志附件存进自己的记忆时用。 */
  blob(handle: string): { bytes: Uint8Array; mime: string } | null;
  log: Logger;
}

/** 持久定时器条目。payload 对 core 不透明;调度时间由 atIso 定义。 */
export interface TimerEntry {
  id: string;
  /** 到期时刻(原样保存设定方给的 ISO) */
  atIso: string;
  payload: Record<string, unknown>;
}

/** 通用持久定时器原语:设定/取消/列举 + 到期回调;跨重启恢复。 */
export interface TimersApi {
  set(atIso: string, payload?: Record<string, unknown>): { ok: true; id: string } | { ok: false; error: string };
  cancel(id: string): boolean;
  list(): ReadonlyArray<TimerEntry>;
  /** 清除全部定时器(运维动作);返回清掉条数 */
  clearAll(): number;
  /** 到期回调(单持有方,attach 时注册)。到期条目已从表中移除。 */
  onDue(handler: (entry: TimerEntry) => void): void;
}

/**
 * 投递闸门:安装期间一切唤醒项(事件与内部项)都被扣留,出口只有解除、
 * 关键词命中与积压溢出,三条出口都整批 FIFO 放行——总线的全序不变式
 * (上下文序 = 到达序)对闸门同样成立。keyword 命中与溢出经回调交给持有方处置。
 */
export interface DeliveryGate {
  id: string;
  /** 区分大小写的字面子串;只匹配外部事件正文。 */
  keyword?: string;
  /** 被扣事件积压超过此数时,连同回调通知临时放行一批。 */
  overflowLimit: number;
  onKeyword: () => void;
  onOverflow: () => void;
}

export interface DeliveryGateApi {
  /** 安装或替换闸门。此前无闸门时,已积压的内容获准放行一次。 */
  set(gate: DeliveryGate): void;
  /** 只解除匹配 id 的闸门;deliverQueued=false 用于"先解闸,再把通知和积压合成一个回合"。 */
  clear(id: string, deliverQueued?: boolean): boolean;
  isBlocked(): boolean;
}


/**
 * 模型能力事实表。这是 core 关于模型的全部知识:
 * 纯事实,不含任何选择。**运行时查询,不是启动期快照**——模型可以热改,
 * 快照会过期。
 *
 * 刻意不定义模态词表(image/audio/…),只有 mime:core 唯一需要理解的东西
 * 就是"当前接收事件的那个模型吃不吃得下这个 mime"。
 */
export interface ModelFacts {
  /** 接收事件投递的那个 session 现在用的模型名 */
  model(): string;
  /** 该模型是否接受这个 mime 的内容分片 */
  accepts(mime: string): boolean;
  /** 该模型的生效上下文窗口(token):上游自报与手填取小;两者都不知道则 undefined */
  contextWindow(): number | undefined;
}

/**
 * 一条事件对合批的触发方式。推事件的人自己判断——core 不认识任何
 * 事件种类,只按这四档办。四档只回答"何时唤醒";"何时成文"(即时/投递)是
 * 另一根正交的轴,见 DeferredEventSpec。
 */
export type TriggerMode =
  /** 立刻投递整批，并请求主循环取消尚未外化的在途模型轮。 */
  | 'preempt'
  /** 到达即冲洗窗口:立刻投递,把积压一起带走。被@、终端消息、内部唤醒走这档 */
  | 'flush'
  /** 常规:参与防抖计时,刷新安静窗口,受地板与上限约束 */
  | 'debounce'
  /**
   * 搭车：只入队，不触发投递或刷新计时器，随下一批带出。
   * 用于不单独唤醒 agent 的高频状态更新。
   */
  | 'piggyback';

export interface PushOptions {
  /**
   * false=只落库不投递(不唤醒agent)。用于:自己发出的消息回录、
   * 宕机补缺口的历史回填。默认true。
   */
  deliver?: boolean;
  /** 这条事件怎么触发合批;默认 'debounce' */
  trigger?: TriggerMode;
}

/**
 * 认知外包:World 向**她**请求一次"想事情"的入参。
 *
 * 主权划分是这套东西唯一要记住的事:
 *  - **World**给 `brief`(要想的是什么,散文)和它**自己的**工具名单;
 *  - **Persona**定头(用哪个前缀/继承不继承出线态)、定档(模型)、定预算(轮数/token/超时)、
 *    定开关(全局关掉整个能力);
 *  - **core** 只做机械的三件事:注入句柄、校验工具白名单、并发记账。
 *
 * 边界(这条是本设计的要害):**World 不能自己开一个意识面**。它没有模型档位、没有前缀、
 * 没有轮数,拿不到 LLM 客户端,也点不动别人的工具——它只能"请求",由Persona决定
 * 用什么头脑、花多少钱去想,以及想不想。 World 自带的辅助模型(QQ 识图那类)是
 * 另一回事:那是 World 自己的 runtime,自己上报用量,与本 hook 无关。
 */
export interface CognitionRequest {
  /**
   * 任务说明,World 自己写的散文。Persona会把它包进自己的引导语里——所以这里
   * 只说"要办的事",不要写"你是谁"、不要指定模型或轮数。
   */
  brief: string;
  /**
   * 这次请求想让她用上的工具名。**只能点名请求方 World 自己声明过的工具**
   * (`World.tools()` 里的名字);点到别的 World 或人格自己的工具,core 直接
   * 以 `{error}` 驳回,请求根本不会到Persona那一侧。不给 = 不带任何 World 工具
   * (Persona仍可按自己的判断附上它自己的工具,比如记忆)。
   */
  tools?: string[];
  /**
   * 量级提示,**建议而非指令**:World 比谁都清楚这活儿大概多大,但预算归Persona,
   * 她可以照办、可以打折、也可以完全无视。
   */
  hint?: {
    /** 大概需要几轮工具循环 */
    rounds?: number;
  };
}

/**
 * 一次认知请求的结果。要么有正文,要么有一句人话的失败原因——
 * World 两种都要能如实转述给她(「构思没成:原因」这类事件是必须有的)。
 */
export type CognitionResult = { text: string } | { error: string };

/** World 侧看到的认知外包句柄。Persona没实现或全局开关关着时,这个句柄**不存在**。 */
export interface CognitionHost {
  /** 发一次请求。不抛错——一切失败(校验不过、人格实现炸了)都以 `{error}` 形式返回。 */
  request(req: CognitionRequest): Promise<CognitionResult>;
}

/** core 交给Persona的机械事实(它自己查不到的那些)。 */
export interface CognitionContext {
  /** 发起请求的 World id */
  worldId: string;
  /**
   * `req.tools` 点名的那些工具的**定义本体**——core 已按白名单校验并解析好,
   * Persona直接装进 fork 的工具集即可,不必去认识 World 的工具表。
   * 没点名 = 空数组。
   */
  tools: ToolDef[];
  /**
   * 该 World 当下在途的认知请求数,**含这一次**(core 的并发记账)。
   * 单实例/排队之类的策略归Persona,它据此判断;core 只数数,不拦。
   */
  running: number;
}

/**
 * Persona提供的认知外包实现。**可选**——不提供 = World host 上没有这个句柄。
 *
 * 与 `SessionDecl` 同款:`enabled` 是函数,每次现读(全局开关热改立即生效)。
 */
export interface PersonaCognition {
  /**
   * 全局开关。返回 false = World host 上**不出现**该句柄(不是返回 error——
   * World 要能用 `if (host.cognition)` 判断这台机器上有没有这个能力)。
   * 不提供 = 恒开。
   */
  enabled?(): boolean;
  /**
   * 受理一次请求。头/档/预算/引导语全归这里;拿到的工具已过白名单。
   * 抛错由 core 兜成 `{error}`,不会炸穿 World。
   */
  request(req: CognitionRequest, ctx: CognitionContext): Promise<CognitionResult>;
}

/** Core 提供给 World 的宿主接口；有回执的方法均支持跨进程异步实现。 */
export interface WorldHost {
  /**
   * 落库(分配游标)并按opts决定是否进合批投递;resolve 为落库后的完整信封。
   * 普通成文事件走此通道,内外部共用一张信封:
   *  - `origin` 不填 = `external`("外面发生了什么");
   *  - `origin: 'internal'` = World 报自己这一侧机制的话(静默提醒、自省信号),
   *    或一条**经过认证的操作员通道**(worlds-terminal 的口令标记)。
   *    纪律:**严禁转录任何认证不了来源的外部内容**——投递侧按 origin 标签路由,
   *    internal 进 user 区(可信内部文本),external 进事件帧。
   */
  pushEvent(
    e: Omit<EventEnvelope, 'cursor' | 'origin' | 'contextDelivery' | 'blobs'> & { origin?: EventOrigin; blobs?: BlobInput[] },
    opts?: PushOptions,
  ): Promise<EventEnvelope>;
  /**
   * 投递成文事件:push 时只给渲染回调,发车刻成文并此刻落库,
   * 游标/时间戳都是投递刻的。render 返回 null 或超时 → 整条蒸发。
   * `origin` 同 pushEvent(不填=external)。无回执——游标在投递刻才存在。
   * 隐藏 World 的项直接丢弃(没有正文可落库)。典型用法:世界快照挂 `piggyback`,
   * 搭下一班车且永远是发车刻的新鲜内容;急了照样可以挂 `flush`。
   */
  pushDeferred(
    e: Pick<DeferredEventSpec, 'type' | 'senderKey' | 'meta' | 'tags' | 'render'> & { origin?: EventOrigin },
    opts?: { trigger?: TriggerMode },
  ): void;
  /**
   * 候选投递：原始事件只归档，无正文票据参与总线发车。projector 在
   * 发车刻看到本来源的完整候选批，选中投影在当前批尾落库并投递。
   */
  pushCandidate?(
    spec: CandidatePushSpec,
    opts?: { trigger?: TriggerMode },
  ): Promise<readonly EventEnvelope[]>;
  /** 只读事件库(qq_read_history/qq_grep_history的数据源) */
  store: EventStoreReader;
  /**
   * 取走当下已积、尚未投递的事件(只 event 类且匹配 filter),消费一次返回。非阻塞。
   * 起草工具用它取走"起草这段时间已到的会话消息"，再由主循环作为user消息
   * 投递以供复核；消费后这些事件不会在后续批次重复投递(consume-once)。
   */
  drainPendingEvents(filter: (e: EventEnvelope) => boolean): Promise<EventEnvelope[]>;
  /**
   * 主模型的能力事实(运行时查询)。 World 据此决定要不要随回执附图;
   * "要不要降级"由 core 渲染时自己按 mime 做的机械事。
   */
  modelFacts: ModelFacts;
  /**
   * 按句柄取回一份二进制(`log:` 与 `mem:` 都收;core 按 scheme 派发)。
   * 句柄不合形状或内容不在 → null。进日志的字节不经这里:随记录的 `blobs` 一起落库。
   */
  blob(handle: string): { bytes: Uint8Array; mime: string } | null;
  /**
   * World 自愿上报自己消耗的 token;core 不接管 World 自带模型的 runtime。
   * 上报后会进 session 统计与 usage.jsonl,
   * 成本页看得到。不报就不记——这个缺口要在框架文档里对 World 作者写明。
   */
  reportUsage(usage: LLMUsage, opts?: { model?: string; label?: string; charges?: import('./generation.ts').Charge[] }): void;
  /**
   * 最近 withinMs 毫秒内 core 调模型卡住(失败/流中断)的次数。
   *
   * World 只知道"她这段时间没开口",分不清是她不想说还是根本没轮到她说。这是
   * 那个分辨器:静默提醒用它把「安静 60 秒」说成「安静 60 秒,其中卡了 3 次」。
   * 可选——不是每个宿主都接线(直连测试、部分子进程宿主可以不给)。
   */
  llmStalls?(withinMs: number): Promise<number>;
  /**
   * 可选的认知外包能力，主权划分见 CognitionRequest。人格未实现、全局关闭或跨进程宿主未接线时为 undefined； World 据此选择降级路径。
   */
  cognition?: CognitionHost;
  log: Logger;
}

/**
 * 可清除的落盘或内存存储单元。来源包括 core 派生项和 `WorldConsoleDecl.storage`。
 */
export interface StoragePart {
  key: string;
  label: string;
  kind: 'disk' | 'memory';
  /**
   * 控制台分节归属。留空表示框架存储;World 存储填写 World 名。
   * 分节让不同生命周期和清理语义的存储保持独立。
   */
  group?: string;
  /** 落盘文件/目录的相对说明(如 data/events.jsonl);内存部分留空 */
  location?: string;
  /** 不可恢复地删除经历或 session;前端要求加强确认。 */
  danger?: boolean;
  /** 一句话说明清除后果 */
  note?: string;
  /** 一键清空时的执行序(升序;缺省0。session=10最后清:它清完即重建前缀) */
  order?: number;
  /** 当前规模描述(条数/大小),实时计算 */
  stat(): string;
  /** 执行清除,返回结果描述;抛错=清除失败 */
  clear(): Promise<string> | string;
}

/**
 * 一个专用面板的声明。**与 `src/web/shared/console-protocol.ts` 的
 * `ConsolePanelDecl` 同形**(结构类型,两边可直接互相赋值),但在这里就地定义而不是
 * 从那份协议 import:`core/` 是被 web 依赖的下层,反过来 import 会把依赖方向掉个个儿,
 * 而且那份协议本来就 import 了 core 的类型——成环。字段语义以协议那份为准,
 * 改动要两边一起改。
 *
 * `id` 是**控制台一页内的局部 id**(`gate`,不是 `qq-gate`):World 不必把自己的名字
 * 编进面板 id 里,那正是旧的全局扁平 id 要求中央前端持一张全局表的原因。
 */
export interface WorldPanelDecl {
  /** 本 World 内唯一,`[a-z0-9-]`,不带 World 名前缀。 */
  id: string;
  title: string;
  /** 一句话说明,控制台可显示在标题旁 */
  description?: string;
  /** 允许经 HTTP GET 调用的方法；省略时沿用兼容行为，允许本面板全部方法。 */
  getMethods?: readonly string[];
}

/**
 * 模板里一个占位符的声明。控制台照它在编辑器旁边列出"这份模板有哪些洞、
 * 每个洞填的是什么",再配上该洞**此刻的实际展开值**——那比任何文字描述都直观。
 */
export interface PromptVarDecl {
  /** 占位符名,含命名空间:`qq.conversations` / `memory.roster` */
  name: string;
  /** 一句话:这个洞填的是什么运行时事实 */
  description: string;
  /**
   * 值是否可能带换行(清单一类)。编辑器据此提示"建议独占一行"——渲染时**不做
   * 缩进跟随**,`- {{x}}` 里 x 的第二行不会自动补 `- `。
   */
  multiline?: boolean;
}

/**
 * 一份可编辑的提示词模板。读文件、算 revision、原子写回都由框架代办,
 * `path` 是本地绝对路径,不上线。
 */
export interface PromptDocDecl {
  /** 全局唯一,惯例 `worlds.<World>.<名>` / `persona.<名>` */
  key: string;
  title: string;
  description: string;
  /** 此刻该读的那份文件。可以尚不存在(部署侧的文本在首次保存前没有它):读作空,保存时创建。 */
  path: string;
  /**
   * 这份模板在**部署侧**的覆盖文件。给了它,框架就按"部署层压过包层"处理:
   * 读取按 `path`(声明方已解析成此刻该读的那份),写入一律落到这里——
   * 部署者调出来的提示词是私有资产,不该写进随包发出去的文件。
   * 不给 = 这份模板只有一层,读写同一个 `path`(比如宪法,它本来就住在 Memory 里)。
   */
  deploymentPath?: string;
  /**
   * `envPrompt` = 本 World 进前缀的那份环境提示词模板;`prefix` = Persona的顶层
   * 装配模板。不标 = 普通可编辑文件,框架不拿它渲染任何东西。
   */
  role?: 'envPrompt' | 'prefix';
  /** 这份模板可用的占位符。与运行时报的值集合一致性由测试钉住。 */
  vars?: PromptVarDecl[];
}

/**
 * 一条链路的状态灯。四态,World 自报;控制台只按 state 上色,不从徽标反推。
 *
 * 判据是**这条链路现在能不能干它的活**,不是它此刻忙不忙:
 *
 * | state     | 什么时候报                                   |
 * | --------- | -------------------------------------------- |
 * | `online`  | 链路通,能干活(闲着也算)                      |
 * | `loading` | 正在过渡:连接中、子进程启动中、引擎预热       |
 * | `error`   | 本该在跑却干不了:连不上、子进程挂了、设备打不开 |
 * | `offline` | 被关着或没配:玩法关掉、接入门关着、密钥没填    |
 *
 * `offline` 与 `error` 的界线是**有没有人指望它现在在跑**。关掉的东西不是故障——
 * 红灯要留给"扫一眼就该去看"的那种事,否则常驻的红会把真出事的红淹掉。
 */
export interface WorldLamp {
  /** 这是哪条链路(「VTS」「协议端」「后端」)。导航上没有它的位置,只进悬停说明。 */
  label: string;
  state: 'online' | 'loading' | 'error' | 'offline';
  /** 悬停时的一句细节。不占版面,只进 title。 */
  hint?: string;
}

/**
 * 一个 World 最多点几颗灯。
 *
 * 七这个数是**版面**给的:左栏一行 280px,名字之外只剩得下这么多颗 6px 的点;
 * 再多就要么挤掉名字,要么小到分不清颜色。超出的由框架截掉——World 该自己挑出
 * "扫一眼要看的那几条",而不是把内部所有开关都摆到导航上。
 */
export const MODULE_LAMP_MAX = 7;

/**
 * World 声明的控制台表面。控制台按声明通用路由，只渲染支持的 panel id。
 */
export interface WorldConsoleDecl {
  /**
   * 控制台显示名。不报 = 用定义里的 `label`。实例知道控制台语言(`WorldContext.language`),
   * 想按语言给显示名的 World 在这里报;装配层的槽位名与回执仍用定义里的那一个。
   */
  label?: string;
  /**
   * 状态灯,一条链路一颗,至多 `MODULE_LAMP_MAX` 颗。徽标那种"标签 值"的小字在
   * 导航行里排不开,灯排得开——所以 World 内部那几条链路(连接、子进程、外设…)
   * 在这里各占一颗,顺序由 World 自己定。不报 = 控制台不画灯(不替 World 猜)。
   */
  lamps?: WorldLamp[];
  /** 状态徽标(如"在线 3 人"),控制台原样显示 */
  badges?: Array<{ label: string; value: string | number; tone?: 'on' | 'off' | 'plain' }>;
  /**
   * World 专用面板采用 { id, title, description? } 对象声明。id 在控制台一页内唯一，不带 World 名前缀；跨页的隔离由 page id 提供。
   */
  panels?: WorldPanelDecl[];
  /**
   * 面板数据调用面:控制台将 HTTP 请求映射为 `(panel, method, args)`,调用语义由
   * World 定义,返回值默认编码为 JSON。
   * 返回 `{ $binary: { mime, base64 } }` 时控制台按二进制响应(音频试听这类)。
   * 不声明 = 该 World 的面板没有数据面,对应端点 503。
   */
  invoke?(panel: string, method: string, args: unknown[]): Promise<unknown>;
  /**
   * 面板流式面。`invoke` 管请求—应答,这条管**推送**(日志尾随、对话、演出流)。
   * 一条连接调用一次;框架不广播、不去重、不保证单实例,要扇出就自己持 socket 集合。
   * 不声明 = 该 World 没有流式面,对应的 WS 握手被拒。
   */
  stream?(panel: string, socket: WorldStreamSocket): void;
  /**
   * World 自有的提示词模板文件,控制台提供编辑。
   * key 全局唯一(惯例 `worlds.<World>.<名>`);path 是本地文件绝对路径。
   *
   * `role: 'envPrompt'` 的那一份就是本 World 的环境提示词模板——框架读它、用
   * `envPromptVars()` 的值插值。**显式标角色,不按 key 字符串猜**。
   */
  promptDocs?: PromptDocDecl[];
  /**
   * 本 World 自己攒下的、可以清除的东西(地标记忆、 World 日志一类)。
   * 控制台把它们与框架那几条并列在存储页,单独归一节。
   */
  storage?: StoragePart[];
  /**
   * World 自带的独立页面入口。控制台不解析 href 的路径语义；`inheritTheme` 只请求
   * 打开时附带一份当前主题快照。href 一般是 World 自己起的 HTTP 服务地址。
   */
  links?: Array<{ label: string; href: string; inheritTheme?: boolean }>;
  /** 本 World 声明的可调配置项(控制台按 JSON Schema 通用渲染表单) */
  config?: ConfigGroup[];
}

export type ShutdownVerificationStatus = 'verified-ended' | 'still-live' | 'unknown';

/**
 * World 在 stop() 内完成并缓存的外部状态检查。汇总层只读取结果，不重新访问外部系统。
 */
export interface ShutdownExternalCheck {
  key: string;
  label: string;
  status: ShutdownVerificationStatus;
  detail: string;
  /** 未验证结束时由操作者执行的动作；框架不会替人执行。 */
  manualAction: string;
}

/** World 注册契约:环境提示词+事件词表(pushEvent自带)+工具集 */
export interface World {
  id: string;
  /**
   * 环境提示词模板此刻的变量值。**World 不产出前缀文本,只报值**——文本一律来自
   * `promptDocs` 里 `role: 'envPrompt'` 那份模板,框架读它并插值。
   *
   * 返回 `null` = 本 World 这一段整个不进前缀(World 自己关掉了半边功能时用)。
   * 没有占位符的模板返回 `{}` 即可,模板全文照发。
   *
   * **截断点会被重新调用**,与旧的取文本方法同一时机——有 World 把这一刻当作
   * "上下文窗口换了"的信号来重置自己的增量基线,挪调用时机前先查一遍。
   */
  envPromptVars(): Record<string, string> | null | Promise<Record<string, string> | null>;
  /** World 工具集(schema+description+handler 都由 World 自己提供;使用时机与该回避的模式写进环境提示词模板,description 只放这个工具自己的定义与用法) */
  tools(): ToolDef[];
  /** 本 World 要在控制台露出什么(可选;不声明=控制台只显示通用信息) */
  console?(): WorldConsoleDecl;
  /**
   * 本 World 对主 session 输出流的接收器(见 `SessionDecl.outputTap`)。Persona把所有
   * 挂载 World 的接收器扇出成一个 tap 填进声明;World 运行中挂载/卸载时接收集合随之变化。
   */
  outputTap?(): OutputTap;
  /** 连接平台,开始推事件。host由core在挂载时传入。 */
  start(host: WorldHost): Promise<void>;
  stop(): Promise<void>;
  /**
   * 上下文交接事务收尾时的钩子:新 session 已装好前缀与动态尾,总线尚未恢复投递,
   * 此刻推的项落在新 session 第一批。只通知时机,不携带快照;隐藏 World 不通知。
   */
  onHandoffEnded?(): void;
  /**
   * 一轮自然收束时的钩子(assistant 自然结束、LLM 失败或硬轮数封顶):World 用它清理
   * 只在本轮内有效的暂态,如未确认的草稿。只通知时机;隐藏 World 不通知。
   */
  onTurnEnded?(): void;
  /**
   * stop() 完成后可选的外部状态账。没有外部状态需要确认的 World 不声明此方法。
   * 此方法必须是同步只读快照；网络探针应在 stop() 的既有预算内完成并保存结果。
   */
  shutdownVerification?(): readonly ShutdownExternalCheck[];
}



/**
 * `text` 是 system 前缀的确切片段内容。`title` 仅供操作者识别,不参与拼接。
 */
export interface PrefixSegment {
  title: string;
  text: string;
  /**
   * 来源模板的 promptDoc key，由后端显式提供编辑映射；缺席表示现拼内容，控制台只读。
   */
  sourceKey?: string;
}

export interface WorldPrefixContext {
  id: string;
  /** 模板渲染后的环境提示词文本(框架已插值;World 不产出文本) */
  envPrompt: string;
  /** 这段来自哪份模板,原样传给 PrefixSegment.sourceKey */
  sourceKey?: string;
}

/** core 在 system 前缀拼装期间提供的事实。 */
export interface SystemPrefixContext {
  now: Date;
  timezone: string;
  /** 按 World id 排序 */
  worlds: WorldPrefixContext[];
}

export type SessionOpeningReason = 'new' | 'restarted' | 'cleared';

/**
 * 一轮合成首轮对话(风格锚)。第一次对话来回对模型的语言风格有锚定作用;
 * Persona提供内容,core 在出线态把它插在 system 前缀之后、真实历史之前。
 */
export interface FirstTurnRound {
  /** 伪造的首条 user 输入 */
  user: string;
  /** 伪造的 assistant 思维链;空/缺省 = 该轮不带 reasoning_content */
  thinking?: string;
  /** 伪造的 assistant 回复正文 */
  reply: string;
}

export interface MemoryAssemblyContext {
  now: Date;
  timezone: string;
}

/** 一个 World 的挂载或可见状态被装配层改变。`label` 是控制台显示名。 */
export type WorldLifecycleEvent =
  | { kind: 'mounted' | 'unmounted' | 'restarted'; id: string; label: string }
  | { kind: 'visibility'; id: string; label: string; visible: boolean };

/**
 * 方向一:core 回调Persona。
 *
 * 时机钩子契约:钩子按**机械时机**命名,只通知时机、携带该时刻独有的机械事实,
 * 返回 void(两个例外:onHandoff 的 {tail} 是重建输入,onStallsRecovered 的字符串是
 * 待注入的措辞)。Persona想在任何时刻说什么,一律走注入原语
 * (CoreApi.injectInternal / injectDeferred / injectExternal);想做什么,走对应原语
 * (requestContextHandoff / spawnFork / …)。core 自己一个字不写,不解释任何文本语义。
 *
 * 时机钩子全部可选,缺席即"这一刻不做":不注入、不交接、不提交。必填的只有
 * 前缀、session 声明、attach 与 memoryDir——缺了 session 起不来。
 */
export interface Persona {
  /**
   * system 前缀的有序命名段。Persona定义段的内容与排列;core 按序拼接 `text`。
   */
  systemSegments(ctx: SystemPrefixContext): Promise<PrefixSegment[]>;
  /**
   * 自有模板里各占位符**此刻**的值。纯展示:控制台把它显示在编辑器旁边,
   * 好让人看清每个洞会填进什么。不提供 = 那些洞只有名字与说明,没有实时预览。
   */
  promptVarValues?(ctx: { now: Date; timezone: string }):
    | Record<string, string>
    | Promise<Record<string, string>>;
  /**
   * 时机:session 开场(全新/重启恢复/清空重开)。开场白经 injectInternal 注入。
   */
  onOpening?(ctx: { reason: SessionOpeningReason }): void;
  /**
   * 时机:一批唤醒项即将进入 session(投递刻,已成文、已分配游标,尚未渲染进上下文)。
   * ctx.events 是本批全部信封(内部+外部,投递序)——这是该时刻独有的事实,别处查不到。
   * 钩子执行期间经 injectInternal 注入的即时项**收编进本批**,排在既有内部行之后、
   * 外部正文之前,同批原子到达。慢工作别放这里:投递在等它返回。
   */
  onDelivery?(ctx: { events: EventEnvelope[] }): void;
  /**
   * 时机:一批处理完、回合循环收束。上下文压力策略在Persona:经 sessionInfo()
   * 查 estTokens 与自己的阶段预算,想预警就注入,想交接就 requestContextHandoff()。
   * core 只保留一条物理钳制:计数越过 hardTokens 时无条件强制交接。
   */
  onBatchEnd?(): void;
  /**
   * 时机:一轮自然收束(assistant 自然结束、LLM 失败或硬轮数封顶)。
   */
  onTurnEnded?(): void;
  /**
   * 时机:一批处理完且总线空闲。记忆留痕(如提交人格 git)放这里,不占回合。
   */
  onIdle?(): void | Promise<void>;
  /**
   * 时机:一串连续 LLM 失败恢复。core 只报机械事实(卡了几次、静默多久);
   * 措辞与「一次孤立失败值不值得占一条上下文」的裁量归人格:返回 null = 这串不说。
   */
  onStallsRecovered?(info: { count: number; quietMs: number }): string | null;
  /**
   * 时机:装配层激活 / 停用 / 重启了一个 World,或改了它对 agent 的可见性。
   * 启动期的初始挂载不报。想告诉 agent 的话经注入原语。
   */
  onWorldLifecycle?(event: WorldLifecycleEvent): void;
  /**
   * Persona 自有工具的名字:各 session 声明交出的表里,不是挂载 World 交出的那些。
   * 装配层据此拒绝与之撞名的 World。不提供 = 装配层不查这一侧,撞名只在装配工具表时
   * 告警并留先到的。
   */
  ownToolNames?(): string[];
  /**
   * 合成首轮对话(风格锚)的内容。core 在出线态把每轮插在 system 前缀之后、
   * 真实历史之前(不落盘;开关在 cfg.context.firstTurn,默认开)。user 或 reply
   * 为空白的轮次被机械跳过——发货态的空模板文件因此天然等于"不注入"。
   * 内容随 system 前缀重建一起刷新(编辑后重载前缀生效)。不提供 = 无此机制。
   */
  firstTurn?(): FirstTurnRound[];
  /** 工作区绝对路径,供 Web 面板与人格版本管理使用。 */
  memoryDir: string;
  /**
   * 记忆里的二进制工件(`mem:` 句柄的后端)。memory 持有 bot 的全部持久化状态,
   * 能装二进制是这份契约的一部分;core 只按 scheme 把句柄派过来。
   */
  blobs: BlobStore;


  /** core 装配时把窄接口交给Persona;必须在 declareSessions 之前调用。 */
  attach(core: CoreApi): void;
  /** 注册一组 session 声明。必须恰好有一个 receivesEvents=true 的常驻声明。 */
  declareSessions(): SessionDecl[];
  /**
   * 时机:交接事务(稳定回合边界上,快照已取,投递暂停)。返回新动态尾;null=交给
   * core 按机械默认重建。返回值仍须过工具配对与物理钳制:前缀加尾巴不得越过
   * `ctx.hardTokens`,越过按机械默认裁到能发为止。尾巴留多长是Persona的裁量,
   * core 没有保留比例。醒来想说的话在钩子内注入——事务期间总线不投递,注入项
   * 自然落在重建后新 session 的第一批。
   */
  onHandoff?(snapshot: ContextRecord[], ctx: { hardTokens: number | null }): Promise<ContextHandoffResult>;

  /**
   * 可选的认知外包受理实现；未提供时， World host 不暴露 cognition 句柄。
   * 人格决定前缀、模型档、轮数、token、超时和记忆工具；core 仅转交请求方身份与已校验的工具，主权划分见 CognitionRequest。
   */
  cognition?: PersonaCognition;

  /**
   * Persona要在控制台里露出什么(可选)。与 `World.console?()` 对称。
   *
   * 对称是有理由的,不只是好看:控制台的「换人格 → Web Core 零修改」要成立,最自然
   * 的方式就是让Persona**自报**它的控制面,而不是靠装配层替它转述一遍。
   *
   * **可选**——无头实现、测试假件、不需要控制台的Persona都不必实现它;
   * 所以这不会给 `Persona` 强加 web 知识。
   *
   * 归属判据:这里出的是**认知绑定**的那些——记忆视图、
   * 工作区、入梦。**部署绑定**的(模型档位、存档点、统一重置)归装配层的
   * `ConsoleContribution.consolePages`,因为它们要写 config.json、要跨 owner 编排。
   *
   * 面板 id 在本人格内唯一,不带任何前缀;page id 由装配层按 bot 名生成。
   */
  console?(): PersonaConsoleDecl;
}

/**
 * Persona声明的控制台表面。与 `WorldConsoleDecl` 同形,少了 `links`
 * (Persona不起自己的 HTTP 服务)。
 */
/**
 * 一条已建立的流式连接,交给 World 用。
 *
 * 与 `src/web/shared/console-protocol.ts` 的 `ConsoleStream` **同形**,在这里
 * 就地定义而不是 import ——那份文件本来就 import 本文件,反向会成环,也会把
 * core 这一层的依赖方向掉个个儿。TypeScript 的结构类型让两边直接互赋。
 * 改这里要同步改那边。
 */
export interface WorldStreamSocket {
  /** 推一帧。连接已关时静默丢弃,不抛。 */
  send(data: string): void;
  /** 主动关闭。`reason` 原样带给对端。 */
  close(reason?: string): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: () => void): void;
  readonly open: boolean;
}

export interface PersonaConsoleDecl {
  badges?: Array<{ label: string; value: string | number; tone?: 'on' | 'off' | 'plain' }>;
  panels?: WorldPanelDecl[];
  invoke?(panel: string, method: string, args: unknown[]): Promise<unknown>;
  /** Persona自有的模板(宪法、前缀装配、记忆骨架…),与 World 的同形。 */
  promptDocs?: PromptDocDecl[];
  storage?: StoragePart[];
  config?: ConfigGroup[];
}


/**
 * 级别语义(评审依据):
 *  - error:功能已丢失或需要人处理;带 err 或 data,触发事故包。
 *  - warn:与预期不符但系统自己顶住了(重试、降级、回执与现场不一致)。
 *  - info:状态迁移,值班的人愿意逐条读(World 起停、连接、任务受理与完成、交接)。
 *  - debug:排查一次问题要看的中间量,数字放 data 不烤进 msg。
 *  - trace:高频状态机(注视/姿态过渡、每拍、每帧注入),默认不落盘。
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVEL_RANK: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

export interface LogError {
  name: string;
  message: string;
  stack?: string;
}

/** 日志锚点:落盘刻从异步上下文读,显式给的覆盖上下文。 */
export interface LogAnchorFields {
  sess?: string;
  round?: number;
  resp?: string;
  call?: string;
  ev?: number;
  task?: number;
}

/** `data/runs/<run>/log.jsonl` 一行。 */
export interface LogRecord extends LogAnchorFields {
  /** cfg.timezone 的 ISO,毫秒 */
  ts: string;
  run: string;
  /** 本流进程内单调序号 */
  seq: number;
  level: LogLevel;
  /** 子系统路径:core.loop / worlds.minecraft.skill / console … */
  area: string;
  /** 机器可读小类,同区域内自洽 */
  event?: string;
  /** 一句中文,单独读得懂 */
  msg: string;
  durMs?: number;
  /** 同一 (area, event|msg 模板) 在折叠窗口内重复的条数,只出现在折叠汇总行 */
  repeat?: number;
  data?: unknown;
  err?: LogError;
}

/** 一次写入。ts / run / seq 由 sink 补;子进程转来的记录自带 ts 与锚点。 */
export interface LogInput extends LogAnchorFields {
  level: LogLevel;
  area: string;
  msg: string;
  event?: string;
  durMs?: number;
  data?: unknown;
  err?: unknown;
  ts?: string;
}

export interface LogEmitOptions extends LogAnchorFields {
  event?: string;
  durMs?: number;
  data?: unknown;
  err?: unknown;
  ts?: string;
}

export interface Logger {
  trace(msg: string, data?: unknown): void;
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  /** data 是 Error 或带 err/error 键时,栈进 err 字段 */
  error(msg: string, data?: unknown): void;
  /** 带机器可读小类、耗时与显式锚点的记录 */
  emit(level: LogLevel, msg: string, opts?: LogEmitOptions): void;
  /** 派生带区域前缀的子logger */
  child(area: string): Logger;
}


/**
 * 一个可接入的 LLM 供应端点(部署事实)。core 按 `activeProvider`
 * 在这些条目之间路由;条目内容是纯机械参数,core 不理解模型语义。
 */
export interface LLMProviderEntry {
  options?: Record<string, unknown>;
  /**
   * 这个端点用哪个模型、怎么想。`ModelSpec` 整组归 Provider——Persona拿不到
   * 也不问,一个端点一份,不按 session 角色分岔。
   *
   * 缺席 = 这个端点还没选模型(控制台刚建出来的实例就是这样)。启用时控制台
   * 拦下,真被调用时 core 报错;框架不替部署猜一个模型名。
   */
  spec?: ModelSpec;
  serviceTier?: string;
  pricing?: PriceDefinition[];
  /** Discovered Provider module ID. */
  kind: string;
  baseUrl: string;
  /** 部署密钥名(经 loaded.secret 取值);不填 = 无鉴权(本地 server) */
  secret?: string;
  /**
   * 手动声明:这个端点后面接的模型吃不吃图。决定 core 是否向它发送 image
   * content 分片(ModelFacts.accepts 的数据源)。是端点后面那个底模的事实,
   * 与客户端方言无关,所以是人工开关而不是探测。
   */
  multimodal?: boolean;
}

/**
 * core 机械设施读取的配置。模型档位、轮数上限和记忆容量由 session 声明实时
 * 提供；各组件声明自己的配置段，部署层合成完整运行时配置。上下文阶段长度、
 * 软预警线与交接保留比例是Persona的裁量,归它自己的配置段。
 */
export interface CoreConfig {
  /** 展示名:控制台标题与终端出方消息的 from。框架不预设身份,默认 'bot'。 */
  displayName: string;
  timezone: string;
  /**
   * 控制台语言(部署事实)。不填 = 进程启动时读一次系统区域,不是中文就按英文。
   * 只管控制台与各所有方给控制台的文案;发给模型的文本不归它管。
   */
  language?: 'zh' | 'en';
  /** 可接入的 LLM 供应端点表(部署事实;名字是部署自取的不透明字符串) */
  providers: Record<string, LLMProviderEntry>;
  /** 当前接的那个端点(providers 的键)。热改即时生效——每次 LLM 调用现读。 */
  activeProvider: string;
  /** provider 条目的形状版本(3 = 一个端点一份 `spec`);控制台写配置时落盘。 */
  providerSchemaVersion?: number;
  context: {
    /**
     * 保留历史思维链:true=历史 assistant 的推理照原样发回去,false=发请求前丢弃。
     * 落盘 session 不受影响(仍留全文供观察)。
     *
     * "推理"具体是哪一半由方言决定:签名方言(原生 Responses 那一路)回传的是
     * `reasoningRef` 签名——只有它进得了上下文;明文方言回传的是
     * `reasoning_content`。关掉即回到"每轮从零开始想"。
     */
    keepPastThinking: boolean;
    /**
     * 合成首轮对话(风格锚)开关:true=出线态注入Persona firstTurn() 的内容。
     * 内容为空时开着也不注入;关闭下一次请求即消失(不落盘,无需清历史)。
     */
    firstTurn: boolean;
  };
  batching: {
    /** 末件到达之后安静这么久才投递(防抖) */
    quietGapMs: number;
    /** 首件到达起至少攒这么久(地板):细水长流的事件源不会每条各叫醒一次 */
    minBatchAgeMs: number;
    /** 首件到达起最多攒这么久:消息流不断也到点强制投递 */
    maxBatchAgeMs: number;
    /** 积压事件达到这个条数就强制投递,不再等钟 */
    maxBatchSize: number;
  };
  web: { port: number };
  paths: {
    /** Memory 目录(相对部署目录或绝对);目录名由 Persona 自定,默认 memory */
    memory: string;
    /** data/运行时数据目录 */
    data: string;
  };
  logging: {
    /** 落盘门槛:低于它的记录不写 log.jsonl */
    file: LogLevel;
    /** 打到 stdout 的门槛 */
    console: LogLevel;
    /**
     * 按区域覆盖落盘门槛,`area=level` 逗号分隔,区域可带 `*` 后缀:
     * `worlds.vtuber.state=trace,worlds.minecraft.*=info`。最长前缀命中优先。
     */
    areas: string;
  };
}
