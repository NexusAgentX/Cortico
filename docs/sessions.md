# Session

Owner: `src/core/sessions.ts`, `src/core/types.ts`(`SessionDecl`、`Persona.onHandoff`), `src/core/loop.ts`

一个 session 是一次独立的模型对话:常驻的那一个接收事件投递,其余是临时 fork。session 由
Persona 声明,Core 只把 `role` 当分类标签。

## 声明

`Persona.declareSessions()` 回一组 `SessionDecl`,其中恰好一个 `receivesEvents: true`:

| 字段 | 含义 |
|---|---|
| `id`、`label` | 不透明 id 与展示名 |
| `rounds()` | 软 / 硬轮数上限,函数以便热改 |
| `persistent` | 是否落盘;临时 fork 不落 |
| `receivesEvents` | 事件投递给它;这就是主意识 |
| `eventDelivery` | 事件以 `tool` 回执还是 `user` 消息进入上下文 |
| `outputTap` | 输出流的旁路(演出、字幕) |
| `tools()` | 这个 session 可用的工具 |

声明里没有模型。模型归端点条目的 `spec`,Persona 拿不到。

## 上下文与交接

Core 只守一条物理线:`hardTokens = 生效窗口 − spec.maxTokens`,生效窗口是上游自报值与手填
`contextWindow` 的较小者,两者都缺则不钳。碰线、或上游拒绝「输入超上下文」时,Core 调
`Persona.onHandoff(snapshot, { hardTokens })`,Persona 决定留哪段尾巴、交接笔记怎么写;Core
重建 system 前缀、钳尾、重置 session。

阶段预算(`context.maxTokens`、`softRatio`、`keepRatio`)是 Persona 自己的配置,不在 Core 里。
Cormini 一系的默认:64000 / 0.85 / 1/3;终端页上下文圈的分母与黄线读的是这几个数。

## fork

`ForkOptions { id, messages, tools?, stopWhen?, wrapUpHint?, capNote?, nudge? }` 起一个临时
session 跑独立的工具循环;World 的「代想」(cognition)与 Persona 的梦、潜意识都走这条路。
并发数由 Core 记账,控制台「运行诊断 → session」看得到。

## 持久化

常驻 session 落 `data/session-main.jsonl`,只追加;交接时的重置先写 `.tmp` 再 rename。
统计(调用次数、prompt / completion / 缓存命中 / 推理 token)只在内存,重启清零;已结束的
临时 session 保留最近 8 个供查看。
