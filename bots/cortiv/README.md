# 可缇Corti (CortiV)

Owner: `bots/cortiv/index.ts`

AI VTuber 实时系统。Persona `CortiV`(persona/persona.ts)继承可缇mini 的
`Cormini` 基类,把直播 memory 系统内建为类行为。

## Run

```bash
pnpm start cortiv
```

控制台: `http://127.0.0.1:7789/`

## World

| World | 状态 |
|---|---|
| `terminal` | 控制台聊天 |
| `minecraft` | Minecraft 语义操作、任务队列和客户端托管 |
| `pvz` | 植物大战僵尸语义操作、任务队列和游戏托管。实现在扩展包 `cortico-world-pvz`,没装它这一格是灰卡片;默认关 |
| `vtuber` | L1–L4 演出、TTS 直写声卡、演出流 SSE `http://127.0.0.1:7792/stream` + 弹幕输入 WS。实现在外部包 `cortico-world-vtuber`,由扩展层装载;没装它这一格是灰卡片 |
| `bilibili` | B 站直播间只读接入（弹幕/礼物/SC/上舰/人流读数）。默认关，填 `worlds.bilibili.roomId` 与 `worlds.bilibili.sessdata` 后开 |
| `asr` | 麦克风语音识别。实现在扩展包 `cortico-world-asr`,没装它这一格是灰卡片;默认关 |

`.env` 可选：`VTS_AUTH_TOKEN`（首次连 VTS 弹窗允许后可写入）。

## 事件投递

默认模式：外部事件正文落在伪造的 `external_event_frame` 回执里，
user 区只装内部系统文本。两个 bot 一致。

## Memory 系统(直播场景)

载体仍是工作区文件,机制内建在 [`CortiV`](persona/persona.ts)(不是构造开关——变体即类):

| 件 | 机制 |
|---|---|
| 观众档案 | `viewers/<来源>/<数字ID>.md`,首行=一句话摘要。带 `senderKey` 的外部事件在**当前上下文窗口首次出现**时,首行被机械唤起注入(投递刻收编,同批原子到达);交接清空上文后再出现重念一次,热重启不重念。脱敏期(uid 抹零,无 senderKey)整条静默降级。梦往档案追加印象时须用 `edit_file` 重写首行,首行随印象走。 |
| 工作区工具 | 基类的 `read_file`(可带行区间)/`write_file`/`edit_file`/`delete_file`/`list_files`/`glob_files`/`grep_files`,加 CortiV 自己的 `append_file`、`git_log`、`git_show`、`recall_viewer`。写、改、追加、删每次落盘都提交进工作区 git,署她自己的名。 |
| 主动取档 | `recall_viewer`:按 id 交回整份档案;按名字对本场见过的人与档案首行,唯一命中一份时带全文,没档案的人给出 id。唤起只带首行、弹幕正文不带 id,这是她拿整份印象的路。 |
| 前缀卫生 | 前缀树里 `viewers/` 与 `handoffs/` 折叠为计数(几百份档案不进缓存前缀);`list_files` 对指定目录全量,其余每个子目录只列前 10 项并折叠计数;前缀里的提示指向 `recall_viewer`。 |
| 软边界速记 | 批末超 `context.softRatio` 先注入一次提醒("近期自动带过去,把很久以前还在跟的事写下来"),下一批末仍超才请求交接;Core 另有越过模型物理上限强制交接的钳制。 |
| 并行梦 | 交接**立即返回**(近期尾机械保留,直播不断流);交接前完整快照(头部优先渲染——会死的恰恰是头部)交给后台 `dream` fork 整理:合并观众档案、蒸馏场次、修正过时内容。单实例排队,同档模型,浮现非 `(nothing)` 才注入打扰她。 |

她认人的键永远是数字 uid(B 站改名随意,名字只是数据);唤起触发不依赖进场消息
(普通进场只进人流聚合),弹幕/礼物/上舰谁先到谁触发。

## 与 cormini

| | cormini | cortiv |
|---|---|---|
| `web.port` | 7788 | 7789 |
| vtuber | 无 | 舞台最小可行性 |
