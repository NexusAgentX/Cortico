# World

Owner: `src/core/types.ts`(`World`、`WorldHost`), `src/world.ts`

World 是 Bot 与一个外部环境之间的唯一边界:把环境变化描述成事件投进事件流,把可执行的外部
行为声明成工具,并给 system 前缀一段环境描述。它不碰 Memory,不绑 Persona 的工具,与 Persona
之间只有事件与工具两种语义化的沟通。

## 契约

`World`:

| 成员 | 含义 |
|---|---|
| `id` | World id,也是配置段 `worlds.<id>`、页 id `world:<id>` 的那个 id |
| `envPromptVars()` | 环境提示词模板的占位符此刻的值。`null` = 这一段整个不进前缀;`{}` = 模板全文照发;上下文截断点会被重新调用 |
| `tools()` | 这个 World 暴露的工具 |
| `start(host)` / `stop()` | 挂载与卸载;`start` 抛错就不入挂载表 |
| `console?()` | 控制台页声明(见 [console.md](console.md)) |
| `outputTap?()` | 主 session 输出流的接收器(演出、字幕) |
| `onHandoffEnded?()`、`onTurnEnded?()` | 交接与一轮收束时清暂态;隐藏的 World 不通知 |
| `shutdownVerification?()` | 关机前要核对的外部状态,同步只读快照 |

`WorldHost` 是 Core 给 World 的:

| 成员 | 含义 |
|---|---|
| `pushEvent(e, opts?)` | 落库分配游标,按 `opts.trigger` 投递;不填 `origin` 即 `external` |
| `pushDeferred(e, { trigger })` | 投递刻才成文;`render` 回 null 或超时则整条蒸发 |
| `pushCandidate?(spec, { trigger })` | 原始事件只归档,发车刻再投影 |
| `store`、`drainPendingEvents(filter)` | 读事件库;消费待投递事件(一次性) |
| `modelFacts` | 当前模型接受什么(多模态等) |
| `blob(handle)`、`reportUsage()`、`llmStalls?()` | 附件、用量上报、模型停滞查询 |
| `cognition?` | 「代想」:把要想一想的活交给 Persona 在后台跑,Persona 关掉时句柄不存在 |
| `log` | 带锚点的 Logger |

触发档位 `trigger`:`preempt`(取消在途未外化的模型轮,立即投递)、`flush`(到达即投递,带走
积压)、`debounce`(默认,参与合批)、`piggyback`(只入队,不发车)。`deliver: false` 只落库不唤醒。

事件是 `EventEnvelope`:`cursor`、`run`、`type`、`ts`、`source`(World id)、`origin`、`tags`、
`text`(归一化正文,Core 渲染时一字不加)、`senderKey`、`meta`、`blobs`、`ephemeral`。
原则:只陈述系统能确认的事实,严禁转录认证不了来源的外部内容。

工具回执 `ToolOutcome { text, blobs?, failed? }`;handler 抛错由 Core 转成失败回执。
`endsTurn` 让一个工具结束本轮,`barrierAfter` 让流式提前派发在它之后停下。
工具名在一个 bot 内全局唯一:模型按名字调用,Core 按名字归属与隐藏。用自家短名做前缀
(`mc_`、`qq_`);与已挂载 World、Persona 自有工具或 Core 保留帧名撞名的 World 装配层拒绝
挂载,理由写进控制台。

## 定义与装配

`WorldDefinition`(`src/world.ts`):`id`、`label`、`defaults()`(配置段默认值,`enabled` 恒
false,由 bot 的 `declares` 置 true)、`preflight?`、`configOptions?`、`create(ctx)`。
`WorldContext` 给 `create`:`cfg`(活引用)、`timezone`、`language`、`botName`、`botDir` /
`packageDir` / `dataDir` / `repoRoot`、`secret()` / `storeSecret()`、`persist()`(写回
`worlds.<id>`)、`restart()`。

仓内的定义列在 `src/worlds/index.ts`;启动器把它们与扩展装进来的并成一张表交给 bot 定义
(`withWorlds()`)。bot 的 `index.ts` 只把它为之设计的渠道 id 列进 `declares`:声明过的默认启用,
声明了却没有实现的(扩展没装)在控制台是灰卡,有实现没声明的是部署侧选配、默认关。
`WorldAssembly` 管槽位:`create()` 抛错只废这一格;
`activate` / `deactivate` / `restart` 热生效并写回 `worlds.<id>.enabled`;预建实例只能停起、
不能重建。生命周期事件转给 `Persona.onWorldLifecycle`。

## 环境提示词

每个 World 一份 `ENV_PROMPT.md` 模板,三层覆盖:`src/worlds/<id>/ENV_PROMPT.md` ←
`bots/<名>/worlds/<id>/ENV_PROMPT.md` ← `<部署>/worlds/<id>/ENV_PROMPT.md`,后一层整份替换。
Persona 的段模板用 `{{world.id}}` 与 `{{world.envPrompt}}` 嵌入,前缀总装模板用
`{{worlds.envPrompts}}`。模板语法只有三条(`src/core/template.ts`)。

## 仓库里的

| id | 是什么 |
|---|---|
| `terminal` | 控制台里的对话通道,与 QQ 同层级的外部平台 |
| `qq` | OneBot 协议端,只监听名单里的群与私聊;起草-确认门 |
| `bilibili` | B 站直播间只读接入与本机 Overlay |
| `minecraft` | mineflayer 客户端,观察 = 结构化文本、动作 = 异步执行器;子进程 |
| `websearch` | 只有请求 / 响应工具,不产事件 |
| `console-fixture` | 控制台边界的活体验收件,不在真 bot 里激活 |

`vtuber`、`asr`、`pvz`、`canvas` 是扩展包(见 [extensions.md](extensions.md))。每个 World
目录有自己的 README,`src/worlds/websearch/` 最短,`src/worlds/minecraft/` 最全。

## 写一个

从 `WorldDefinition` 起:`defaults()` 定配置段,`create()` 返回实现 `World` 的实例;有面板就加
`console/client.ts`;有环境描述就加 `ENV_PROMPT.md`。测试用 `tests/helpers/fake-host.ts` 的
`FakeHost` 记录推送。放进仓库的在 `src/worlds/index.ts` 登记一行;放进仓库还是做成扩展,判据在
[CONTRIBUTING.md](../CONTRIBUTING.md)。
