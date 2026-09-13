# src/core

Owner: `src/core/core.ts`, `src/core/types.ts`, `src/core/loop.ts`, `src/core/bus.ts`

Core 持有 session、事件流与模型调用的生命周期:投递、调度、上下文交接、工具派发、容量钳制、
错误隔离、Provider。它不拥有、不解释、不生成任何语义内容;写进上下文的全部文本在 `markers.ts`,
都是结构记号。

## 文件

| 文件 | 管什么 |
|---|---|
| `types.ts` | 全部契约:`Persona`、`World`、`WorldHost`、`CoreApi`、事件、工具、日志、配置类型 |
| `core.ts` | 组合根,`Persona` / `CoreApi` 的边界 |
| `loop.ts` | 主 session 的回合循环、事件投递、交接的机械半 |
| `bus.ts` | `WakeBus`:合批事件总线、四档触发、全序不变式、两个闸门 |
| `fork.ts` | 临时 session 的工具循环 |
| `session.ts`、`sessions.ts` | 常驻 session 的只追加上下文;运行中各 session 的观察注册表 |
| `event-store.ts` | 按 run 分片的 JSONL 事件库,cursor 跨 run 全局单调 |
| `state.ts`、`run.ts`、`timers.ts` | `core-state.json`;run 目录;通用持久定时器 |
| `transcript.ts`、`tool-log.ts`、`usage-log.ts` | 主 session 副本、工具调用流水、用量账 |
| `cost.ts`、`billing.ts`、`generation.ts` | 消耗汇总、计费余额、`ResponseClient` 与计量口径 |
| `prefix.ts`、`template.ts` | system 前缀装配、环境提示词三层覆盖、模板渲染 |
| `truncate.ts`、`markers.ts`、`blobs.ts` | 上下文压缩、结构记号、附件句柄(`log:` / `mem:`) |
| `config.ts`、`config-schema.ts` | `CORE_DEFAULTS`、深合并、旋钮声明 |
| `instance-lock.ts`、`language.ts`、`secrets.ts` | 单实例锁、控制台语言、按名取密钥 |
| `log-context.ts`、`ipc-logger.ts`、`util.ts` | 日志锚点、子进程日志回传、Logger 与 token 估算 |

## Core 类

构造期:挂事件库、session、状态、定时器、日志;`persona.attach(core)` 之后
`persona.declareSessions()`,恰好一个 `receivesEvents` 且 `persistent` 的声明,否则抛错。
公开面:`store`、`bus`、`session`、`state`、`timers`、`loop`、`llm`、`sessions`、`providers`、
`sessionDecls`;`spawnFork`、`resolveBlob` / `internBlobs`、`setWorldVisible`、`activeSpec` /
`activeProviderEntry`、`mountWorld` / `unmountWorld`、`start` / `stop`。

`CoreApi`(Persona 拿到的):`injectInternal` / `injectDeferred` / `injectExternal`、
`requestContextHandoff`、`spawnFork`、`sessionInfo`、`llm`、`timers`、`deliveryGate`、
`personaState` / `savePersonaState`、`toolsTagged`、`blob`、`log`。

## 总线与唤醒

`WakeBus` 四档触发:`preempt`、`flush`、`debounce`、`piggyback`。debounce 发车四条判据:不早于
首件 + `minBatchAgeMs`、不早于末件 + `quietGapMs`、不晚于首件 + `maxBatchAgeMs`、积压到
`maxBatchSize` 立即投递。搭车项自己不发车。两个闸门:操作者的 `paused` 与 Persona 的
`DeliveryGate`。单消费者 `nextBatch()`。`batching` 配置是活引用,热改立即生效。

投递水位 `lastDeliveredCursor` 持久化;队列不持久化,重启只补投水位之后的外部事件,内部事件
只对当次运行有效。

## 主循环

一次唤醒 = 一批事件 → 若干轮模型调用。`SessionDecl.rounds()` 给 `{ soft, hard, softHint? }`:
到软轮把 `softHint` 拼到最后一条回执尾;到硬轮记 warn 并强制结束;`endsTurn` 工具与自然结束
同一出口;收工期间到达的事件退回总线成下一批。模型调用失败按 `ResubmitPolicy` 续拍
(连续 2 次、每批 4 次、退避 2s / 10s)。

工具派发:参数非法 JSON 回 `TOOL_FAILED_BAD_ARGS` 不派发;未知工具回 `UNKNOWN_TOOL`;handler
异常转失败回执;流式时 `EagerDispatch` 提前派发,屏障成立、结果按 call id 配对。回执超过
8000 字符记 warn。

## 上下文

`hardTokens = max(0, contextWindowOf(spec) − spec.maxTokens)`,`contextWindowOf` 取上游探到值
与手填 `contextWindow` 的较小者,都缺则不钳。批内轮边界收束、批末交接、越过即强制交接、上游
拒绝「输入超上下文」也置位交接。交接:`Persona.onHandoff(snapshot, { hardTokens })` 回
`{ tail, trim? }`,Core 重建 system 前缀、按 `hard − estimate(prefix)` 钳尾、重置 session。
阶段预算与保留比例归 Persona。

## 错误隔离

World 构造失败只废一格;`start()` 抛错不入表;`stop()` 失败或超时只记账不阻止卸载;Persona 钩子
异常一律 warn;`console()` 抛错不拖垮前缀;主循环异常退出只记 error 并停定时器;进程级兜底在
启动器,走同一套分步关机。
