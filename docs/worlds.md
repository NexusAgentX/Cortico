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

事件还是工具:被动发生的是事件,bot 主动要看的是工具。描述「此刻状态」的快照用 `pushDeferred`
在发车刻成文、挂 `piggyback` 只搭车不发车;要 bot 立刻停手的才 `preempt`。World 内部状态的生命周期
变化(服务器起停、换存档、连接断续)都投事件告知 bot:静默切换会让两边状态错开,bot 以为自己还在
旧状态。

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
`WorldContext` 给 `create`:`cfg`(活引用)、`timezone`、`botName`、`botDir` /
`packageDir` / `dataDir` / `repoRoot`、`secret()` / `storeSecret()`、`persist()`(写回
`worlds.<id>`)、`restart()`。界面语言不在其中:它是每个请求的属性,`console(language)` 与
`configOptions(kind, language)` 每次传入(见 [console.md](console.md))。

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

环境提示词与工具 `description` 的分工:使用时机、该回避的错误模式这类要连着说、会随迭代变动的
语义内容写进环境提示词;每个工具自己的定义与用法写进 `description`,那是独立的、机械的、从 handler
代码就能看出来的、对迭代稳定的内容。两边不重复。

## Persona–World 状态对账(PWSR)

**测试中的设计,不保证稳定。** World 级的写法准则,不是框架能力;只在 `minecraft` 里落地
(`src/worlds/minecraft/world.ts` 的暂态骨架与 `mc_goal` / `mc_blueprint` / `mc_map` 三张表)。

World 不持有持久的语义状态。路标、目标这类东西的持久归宿只能是 Memory,World 里那份是 bot 在
运行时从 Memory 语义解析后投影进来的可计算**暂态**。Memory 里一种表示、World 里一种表示,两者之间
没有机器可读的桥;唯一能对齐两边的是 bot 本人,它知道 Memory 里写的那个东西是路标。World 与 Memory
因此互相匿名,任何 Memory 后端都兼容。

生命周期(realm 指 World 内的隔离域,如一个存档):

1. World 的状态生命周期开始(如进入一个 realm)时暂态清空;World 经事件或工具回执告知暂态为空,
   并提供批量装载工具。
2. bot 自己从 Memory 找出对应的语义信息,调装载工具写入暂态;装载回执做世界核验,凡能对世界查证
   的逐条对账(「你登记的旧箱那格现在是空气」)。
3. 工具回执提示 bot 保持 Memory 与暂态对齐:回执后一句提示(「路标已更新为 x,y,z;要过夜请自己
   写进记忆」),或在工具描述里要求先更新 Memory 再调工具,二者等价。
4. 对齐提醒只跟随 bot 主动的语义写操作(增、删、改名、改语义)。位置、建造进度这类高频机械变化
   绝不催写 Memory。
5. World 对暂态做机械计算,以事实形式进回执(距离、包含、账单、图算法)。空间事实携带维度;方位、
   距离、包含与世界核验只在同一 realm 的同一维度内计算。

恢复不是开机仪式:何时恢复、恢复什么由 Persona 自行判断,空暂态只是回执少一层信息,不阻塞任何动作。

准入判据,三条都满足才立一张暂态表:

- **桥接语义与机械两层。** 同时是 bot 命名或裁决的语义,和 World 机械计算的输入。纯语义的 bot 自己
  记,不立表;纯机械的世界本身就是权威,直接读,箱子内容不立表。
- **低频。** 语义变更每场个位到十位数次;提醒只搭语义写操作,绝不周期投递。
- **增强非前置。** 空表不阻塞任何动作。

主客观纪律:World 基于暂态给出的一切保持事实身份,参照系归 bot。「路径进入了你标记的危险区」可以,
「系统判断这里危险」不可以。

暂态按 realm 键控命名空间,空间记录再按维度隔离;切换 realm 时旧空间保留而非删除,切回原样恢复。
World 自声明自管理(工具、回执、内存表),不需要 Core 或 Persona 的支持。

## 仓库里的

| id | 是什么 |
|---|---|
| `terminal` | 控制台里的对话通道,与 QQ 同层级的外部平台 |
| `qq` | OneBot 协议端,只监听名单里的群与私聊;起草-确认门 |
| `bilibili` | B 站直播间只读接入与本机 Overlay |
| `minecraft` | mineflayer 客户端,观察 = 结构化文本、动作 = 异步执行器;子进程 |
| `websearch` | 只有请求 / 响应工具,不产事件 |
| `console-fixture` | 控制台边界的活体验收件,不在真 bot 里激活 |

`vtuber`、`asr`、`pvz`、`canvas` 是扩展包(见 [extensions.md](extensions.md))。`bilibili` 与
`minecraft` 各有自己的 README;`src/worlds/websearch/` 最短,`src/worlds/minecraft/` 最全。

## 写一个

从 `WorldDefinition` 起:`defaults()` 定配置段,`create()` 返回实现 `World` 的实例;有面板就加
`console/client.ts`;有环境描述就加 `ENV_PROMPT.md`。测试用 `tests/helpers/fake-host.ts` 的
`FakeHost` 记录推送。放进仓库的在 `src/worlds/index.ts` 登记一行;放进仓库还是做成扩展,判据在
[CONTRIBUTING.md](../CONTRIBUTING.md)。
