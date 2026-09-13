/**
 * core 写进模型上下文的全部文本。**全是结构记号**:某个位置结构上必须有东西、
 * 而真东西不在了时留下的形状——调用没有回执、正文被裁掉、工具不存在、进程中途停了。
 * 内容由机制决定,没有一处裁量;有裁量的话语一律由Persona经注入原语写(见
 * `types.ts` 的 `Persona`)。
 *
 * 这张表是 DESIGN §2.2「core 侧没有任何面向 agent 的散文」的**全部**例外。往里加一条
 * 之前先问:这句话有没有别的说法?有,就说明它是措辞,归Persona。
 *
 * 固定英文,不随控制台语言走:记号不是措辞,上下文的语种由Persona的注入决定。
 */

/** 工具回执被折叠(见 truncate.ts 的 FOLD_THRESHOLD) */
export const FOLD_PLACEHOLDER = '[result folded]';
/** 调用入参被折叠 */
export const FOLD_ARGS_PLACEHOLDER = '[arguments folded]';
/** 单条越过整份预算,整条换成记号 */
export const OVERSIZE_PLACEHOLDER = '[turn too long, omitted]';

/** 配对修复:重建后调用还开着,补一条回执 */
export const MISSING_RESULT = '[result missing]';
/** 配对修复:进程重启时这一轮的回执永远不会来了 */
export const MISSING_RESULT_RESTART = '[result missing (process restart)]';
/** 快照里还开着的调用:那一轮仍在主线程跑,fork 看到的是这个 */
export const PENDING_IN_MAIN_THREAD = '[result pending in the main thread]';

/** 工具名不在本 session 的工具表里 */
export const UNKNOWN_TOOL = '[unknown tool]';
/** 同上,fork 版:工具表是主 session 的子集,这是个机械事实,说清了她才不会再试 */
export const forkUnknownTool = (name: string): string =>
  `[unknown tool ${name}] This thread wires a subset of the tools. Use the ones listed above.`;

/** 上游把这次调用标成未完成(流被截断),参数不可信,不执行 */
export const NOT_EXECUTED_INCOMPLETE = '[not executed: function call incomplete]';
/** 屏障工具(barrierAfter)之后同一条消息里的调用 */
export const NOT_EXECUTED_BARRIER = '[not executed: review the preceding tool result first]';
/** fork 已经收工,同一条消息里排在后面的调用 */
export const NOT_EXECUTED_THREAD_ENDED = '[not executed: this thread already ended]';
/** 流在响应中途断了,提前派发的调用没跑完 */
export const NOT_EXECUTED_STREAM_ABORTED = '[not executed: stream aborted mid-response]';
/** 主循环已停 */
export const NOT_EXECUTED_LOOP_STOPPED = '[not executed: main loop stopped]';
/** 关机打断了这一轮,回执取不回来了 */
export const SHUTDOWN_INTERRUPTED = '[tool result unavailable: shutdown interrupted the round]';

/**
 * 工具执行失败。这个前缀曾是工具流水判定 `failed` 的**唯一**依据(靠 startsWith 嗅探),
 * 现在 `ToolOutcome.failed` 是结构字段,前缀只管给模型看。
 */
export const toolFailed = (detail: string): string => `[tool failed] ${detail}`;
/** 参数不是合法 JSON:不进 handler,就地失败 */
export const TOOL_FAILED_BAD_ARGS = toolFailed('arguments are not valid JSON');

/** 合成投递帧的表头(见 loop.ts 的 EXTERNAL_EVENT_FRAME) */
export const eventFrameHeader = (count: number): string =>
  `[${count} new event${count === 1 ? '' : 's'}]`;
/** 同上,供读回上下文的一方剥掉表头(Persona渲染交接笔记时要拿逐条事件) */
export const EVENT_FRAME_HEADER_RE = /^\[\d+ new events?\]\n?/;
