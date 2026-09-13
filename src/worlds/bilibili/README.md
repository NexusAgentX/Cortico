# worlds/bilibili

Owner: `src/worlds/bilibili/definition.ts`

B 站直播间协议只读接入。观众的弹幕、礼物、醒目留言、上舰、进场与人流读数从这里进事件流；
同一 World 提供本机透明 Overlay。唯一工具 `bilibili_set_announcement` 只写本机 Agent 公告栏，
不会向 B 站账号发送弹幕或执行平台操作。

「重要观众」是上下文投递优先级，不是人物价值标签：机器层只判断谁优先占用直播间上下文，
档案写什么仍由语义记忆决定，失去优先资格也不删档。准入账本、高能榜双闸门、三泳道投影与
受限档案唤起都在 [`audience-admission.ts`](audience-admission.ts)，水位与预算参数在
[`world.ts`](world.ts) 的配置段。设计预算是十倍互动流量下单批负荷不超过近期绝对峰值约 30%。

## 分层

| 文件 | 职责 |
|---|---|
| [`wire.ts`](wire.ts) | 16 字节帧头的编解码;`op=5` 且 protover 2/3 时包体是压缩过的另一串完整包,解析是递归的 |
| [`client.ts`](client.ts) | 握手四步 + wss 长连 + 30s 心跳 + 退避重连 |
| [`normalize.ts`](normalize.ts) | 原始 cmd → 归一化产物(事件 / 计数 / 读数 / 不推)。纯函数 |
| [`protobuf.ts`](protobuf.ts) | 极简 protobuf 线格式读取器。只拆字段号 + wire type,读不动一律 null |
| [`gift-frame.ts`](gift-frame.ts) | `SEND_GIFT_V2` 的 pb blob → V1 字段形状。两种帧共用下游 |
| [`coalescing-buffer.ts`](coalescing-buffer.ts) | 相同弹幕与常规礼物进入事件总线前的固定窗归并 |
| [`audience-admission.ts`](audience-admission.ts) | UID 准入账本、高能榜滞回、批负荷双闸门与三泳道投影 |
| [`world.ts`](world.ts) | 投递分档、人流聚合、公告工具、控制台数据面与 Overlay 接线 |
| [`overlay/`](overlay/) | 设计模型、用户组匹配、原始事件投影、素材、公告持久化、loopback HTTP/SSE、运行页与独立编辑器 |
| [`console/`](console/) | 直播间入站诊断 `log`；Overlay 编辑入口由 World 链接提供 |

零新依赖:帧压缩用 `node:zlib` 的 brotli/zlib,签名用 `node:crypto` 的 md5,长连用已有的 `ws`;
protobuf 也是自己拆的——官方没有公开 `.proto`,装一份完整实现也没有 schema 可喂。

## 走的是 web 协议,不是开放平台

官方开放平台(`live-open.biliapi.com`)要开发者入驻(密钥邮件发放 3-5 个工作日)、项目审核,
主播侧还要先领过一次玩法才有身份码;它给的观众标识是 `open_id` 假名。web 协议不需要任何申请,
给的是真实 uid,代价是非官方、字段会漂、有风控。当前选后者。

## 送礼帧:V1 与 V2 并存

2026-09-10 19:50 起,平台把送礼推送换成了 `SEND_GIFT_V2`:`data` 里只剩 `dmscore` 和一个
base64 的 protobuf blob(`data.pb`),V1 的 `giftName` / `num` / `coin_type` / `total_coin` /
`uname` / `sender_uinfo` 一个都不再下发。当晚 19:50—20:57 的 25 笔付费礼物(含一笔 ¥50 的
「亲密之旅」)因此全被读成"不是 gold"、记进免费礼物计数,一条事件都没成。

现在两种帧都吃:[`gift-frame.ts`](gift-frame.ts) 把 pb 解出来按 V1 的名字摆好,下游一个字段名
都不用改;V1 字段还在就原样走 V1。现网已经不再下发 V1,这条路留着是为了回放
`bilibili-raw-samples.jsonl` 里 09-09 之前那批 V1 真帧,以及测试夹具里同样形状的礼物。
字段号没有官方 schema,全部对自 `bilibili-raw-samples.jsonl` 里的真帧,
回归钉在 [`tests/worlds/bilibili/gift-v2-frames.ts`](../../tests/worlds/bilibili/gift-v2-frames.ts)
(真帧布局、身份项换成假值)。

**读取失败不能降级为计数。** 只有明确读出 `coin_type` 且不是 gold 时才计为免费礼物；读取失败仍生成事件，正文省略金额并告警。

握手四步(全在 `client.ts`):

1. `x/frontend/finger/spi` 取 `buvid3`——2025-06-27 起 `getDanmuInfo` 要求它非空
2. `x/web-interface/nav` 取 WBI 密钥与自己的 uid(未登录也返回,只是 `code=-101`)
3. `Room/get_info` 把短号换成真实房间号(认证包只认真实号)
4. `getDanmuInfo`(WBI 签名)拿弹幕服务器列表与 token

## 登录凭证决定能不能认人

`worlds.bilibili.sessdata`(浏览器登录后的 SESSDATA cookie;和房间号一样放部署配置里,
`<部署根>/<部署名>/config.json`,整片不进版本控制)。**没有它照样收得到弹幕**,但服务端会把
观众 uid 抹成 0、昵称打码成 `老***`。同一房间同一时刻起两条连接的对照实测:

```
带登录态  弹幕 5 条,带 uid 5,uid=0 0     0s uid=12345678   挥手说再见呀呀
匿名      弹幕 5 条,带 uid 0,uid=0 5     0s uid=0          挥***
```

`uid=0` 时本 World**不给 `senderKey`**——宁可缺这一项,也不拿打码昵称冒充稳定键(会碰撞)。

cookie 约一个月过期,而且**静默失效**:不报错,只是悄悄变回匿名的样子。所以控制台的「身份」
徽标盯着最近 20 条弹幕,全都没有 uid 就显示「脱敏中(登录凭证可能已过期)」。

登录态以服务端自报的 `LiveStatus.selfUid` 为准，值为 0 表示匿名。已配置 `sessdata` 但仍为匿名时，每次接入至多记录一次 **error**。

## B 站链埋点

这条链一整场 25 条 info、0 warn 0 error,而当天 93 条异常(跨人归并消音 5 例 / 原始归档
永久蒸发 82 条)全程零日志。现在三处出声:

- **归并折叠**:`info 直播间归并折叠`,按分钟汇总(`folds` / `sourceItems` / `windowMs`),
  收尾时把不满一分钟的那一段也落下来。折叠是常态,逐条落会刷屏。
- **准入筛除**:`warn 直播间准入筛除`,逐批一条,报本批筛掉几条、候选几条、限流态、
  本场累计。被筛掉的那几条她永远看不到。
- **账本落盘失败**:`warn B站观众准入账本落盘失败`(既有,经 `onPersistError` 走)。

三条都只报数,不作判断。

## 投递分档

两根轴:何时唤醒 × 何时成文。

| 事件 | 唤醒 | 说明 |
|---|---|---|
| `bilibili.superchat` | flush | 付费且限时展示,等不起 |
| `bilibili.guard` | flush | 上舰 |
| `bilibili.gift` | flush / debounce | 金额 ≥ `worlds.bilibili.giftFlushYuan` 走 flush,低于它先过短窗归并再排常规合批 |
| `bilibili.guard-renew` | debounce | 续费 |
| `bilibili.danmaku` | debounce | 弹幕 |
| `bilibili.enter-guard` | debounce | 舰长进场(普通进场只计数) |
| `bilibili.block` | debounce | 观众被禁言 |
| `bilibili.room` | flush / debounce | 开播、下播、全员禁言走 flush;标题变更 debounce |
| `bilibili.feed` | flush / debounce | 弹幕接入中断超过 60 秒成文一次(flush),恢复时补一条带中断时长(debounce);60 秒内的抖动不推 |
| `bilibili.warning` | flush | 超管警告与切断。**只告诉她,不替她收嘴**——要不要停由她自己调 `vtuber_interrupt` |
| `bilibili.superchat-del` | piggyback | |
| `bilibili.audience` | piggyback + **投递成文** | 人流读数 |

**人流读数为什么不逐条给**:进场、点赞、免费礼物、看过、在线、人气、粉丝数这些东西
**只有读数没有发生时刻**,它唯一确定的时刻是被看见的那一刻。所以它们累加在 World 里,
用 `pushDeferred` 布置一条待成文事件,搭下一班车,正文在**发车刻**才渲染——带出去的
永远是那一刻的新鲜数,而不是布置时的陈旧快照。同时最多布置一条,安静期不会堆一叠。

不推的 cmd(运营挂件、连麦玩法、全站广播、她自己的语音转写等)列在 `normalize.ts` 的
`IGNORED` 里。**列出来是为了让没见过的 cmd 能在控制台的计数里被认出来**——没进白名单也没进
黑名单的,会以原始 cmd 名出现在那张表上。

## 相同消息归并

弹幕与低于插队门槛的付费礼物在写事件库和总线前经过固定窗。窗口默认 300ms，从池内首件
起算且不因后续消息续期；累计到 64 条立即冲刷。任何不能归并的事件与 `flush` 都是顺序屏障：
先按各组首件的到达顺序冲刷旧池，再立即写入该事件。停机同样先冲刷并取消定时器。

弹幕以「稳定 UID + 去掉首尾空白后的正文」逐字匹配，大小写、内部空白和 Unicode 形式均不改写；**不同观众发同一句话不合并**。礼物只合并礼物流中连续出现的同一稳定 UID、同一礼物名和单价，累计笔数、件数与金额；另一位送礼人或另一种礼物结束该连续段，普通弹幕不打断礼物段。无稳定 UID 的礼物逐笔投递，不凭昵称猜身份。匿名接入时弹幕没有稳定身份键，按正文合并。
单件仍使用原正文、昵称和 `senderKey`；两件以上写成 `[弹幕×N|昵称] 正文`；礼物写成 `[礼物×N笔 ¥合计|昵称] 礼物×总件数`，保留送礼人姓名与组级 `senderKey`。昵称必须进入归并正文，因为私有 `meta` 不渲染给 agent。
参与者的稳定 `senderKey`、昵称与原始条数保留在组级私有 `meta`，供人物档案逐人召回和后续观众记忆迁移使用。Overlay 与控制台日志在原始消息到达时逐条更新，不等待归并窗。

默认值来自 08-25、08-26 两场事件账本的回放。独立 1s 窗对完全相同弹幕的压缩率分别为
0.27% / 1.15%。按稳定 UID、同款同价和礼物流连续段重算，两场礼物压缩率分别落在
20.65%–26.58% / 21.19%–31.60%；按实际只归并低于 ¥1 的礼物、并以全部礼物为分母，区间为
19.31%–23.90% / 20.07%–29.37%。账本时间戳只有整秒精度，区间下界只合并同记录秒，上界还纳入
相邻记录秒，因此只证明同秒突发值得归并，不代表 300ms 的精确收益。窗口取
300ms 是延迟预算，新增上限不超过当前 15–25s 最长合批时标的 2%。近期可归并流峰值为
15 条/秒，按 10 倍折算为 150 条/秒，300ms 内约 45 条；64 条硬上限留出约 42% 余量。
逐笔免费礼物没有进入这份事件账本，但运行时会结束当前礼物连续段，因此真实收益可能更低。
控制台 `log.state.coalescing` 给出输入、输出、已折叠数、冲刷次数、容量冲刷次数与当前池深，供
后续按真实毫秒级观测调参。可热改 `worlds.bilibili.coalesceWindowMs` 与
`worlds.bilibili.coalesceMaxItems`；窗口设为 0 时逐条出池。

## 重要观众与实时限流

长期准入只使用稳定 UID，三个入口取 OR：舰长正证据保留 35 天；单条 SC 不低于 ¥30 或 30 天累计不低于 ¥50；30 天内有一场直播达到 25 个去重活跃分钟，所需分钟数与场次数可按 bot 配置。SC 与互动资格命中后保留 30 天。
账本位于 `data/bilibili-audience/ledger.json`，只存 UID、时间、金额、活跃分钟与公平债务，不存昵称、弹幕或礼物正文；在归并和抽样前更新。脏账本每 30 秒至多快照一次，停机强制落盘；运行期失败时报警并保留脏状态，下一次更新重试。

高能榜是实时拥挤代理，不标成精确在线人数。达到 200 立即进入拥挤态，连续 120 秒
不高于 170 才退出；旧信号最多保持拥挤态 300 秒，明确下播或切换直播代次时立即清零。只有拥挤态与同批候选超过
114 行或 1,061 估算 token **同时成立**才开始筛选。近期高能榜最大值为 153，因此
当前流量严格全量通过。

筛选批先全量保留平台警告、开关播、SC、上舰/续费与高额礼物，再给重要观众最多
50% 常规预算的跨批公平席位，剩余容量对普通观众按持久私有盐确定性抽样。任一参与者
已准入的合并组整组进重要泳道。原始事件全部以 `archive-only` 保留供历史查询，只有选中投影
进入 Agent 上下文。控制台显示最新高能榜、拥挤/限流状态、重要观众数和累计拦下量。

## Overlay

World 在 `127.0.0.1` 启动独立页面：`GET /overlay` 是 OBS browser source，`GET /editor`
是编辑器，`GET /stream` 是同源 SSE 数据面，`GET /assets/<id>` 提供上传素材。端口默认 7795，
被占用时最多顺延 5 个并打 `warn`（顺延本身就是"上一个实例没退干净"最早的旁证，不该只落 info）。
编辑接口只接受浏览器携带的同源 `Origin` 与 JSON 请求，并限制请求体大小；
服务不发送 wildcard CORS。设计和公告分别使用修订号做冲突检测，素材、设计与公告写入共用串行队列，
避免保存过程中删除素材或后完成的旧请求覆盖新状态。

组件类型：

- 横向或纵向弹幕机，准入可选弹幕、礼物、弹幕+礼物；用户名与内容可分别限制显示字数，礼物包含免费礼物、付费礼物、SC 与舰队事件。
- 横向或纵向滚动公告、固定公告、Agent 公告；多行滚动公告可设置每行停留时间和行间切换时长，滚动内容在运动方向的两端渐隐。
- HTTPS/HTTP 外部图片或上传图片，支持 contain/cover/fill。

组件可带独立标题。标题占据上、右、下或左侧边带，支持起点、居中、终点对齐，并拥有独立的
字体、字号、字重、RGBA 颜色与描边。Agent 公告更新时按 Unicode 字符逐字显示并保留输入光标；
弹幕机 Mock 会持续混合注入弹幕和礼物，组件工作区的 Mock 测试只写入预览运行器，不改设计、
真实公告或直播事件流。

内置样式为天蓝色、海军蓝、白色与极简，全部默认尖角。自定义样式可分别配置用户名和正文的
字体、字号、字重、RGBA 颜色与描边。Nine-slice 将源图四条切线与输出边框宽度分开保存；
编辑器可在源图上拖动切线，并用可缩放的实际组件预览验证拉伸、平铺和中心填充。

用户组规则是递归 `all`/`any` 组合。可匹配 uid、舰队等级、粉丝牌、房管、VIP/SVIP、
用户等级以及实测弹幕结构中的排名和颜色字段；最高优先级的匹配组覆写用户名与正文样式。
头像优先使用消息携带的 `sender_uinfo`/富用户信息，经典弹幕没有头像时显示昵称首字占位。

设计保存在部署配置 `worlds.bilibili.overlay.design`，由装配层的 `onOverlayConfig` 原子写回。
上传素材位于 `data/bilibili-overlay/assets/`，文件名是内容哈希；只接受经魔数确认的 PNG、JPEG、
WebP 与 GIF，单文件上限 8 MiB。Agent 公告单独原子保存到
`data/bilibili-overlay/agent-notice.json`，工具写入后以独立 SSE 事件更新公告节点，不会清空
正在滚动的弹幕。公告内容在下一次主会话前缀重建时通过 `ENV_PROMPT.md` 占位符同步； World 不会
为了每次公告写入强制重建前缀。

## 控制台

「World › bilibili」保留「直播间事件」面板，并提供「打开 Overlay 编辑器」链接。编辑器是
单独的 Web 页面，左栏包含样式、组件、布局三个工作区；它们共享同一份草稿、撤销历史和保存动作。
中央画布复用 OBS 运行渲染器做草稿预览，布局工作区在独立交互层提供拖动、八向缩放、网格与
画布/组件吸附、层级、可见性和锁定。编辑控件与选择框不会进入 `/overlay` 的 OBS 输出。
从主 Web 页面打开编辑器时，当前已解析的语义调色板通过 URL fragment 交给独立页面；编辑器
本身内置与 Web 默认一致的浅色、深色回退，因此主 Web 停止后仍能直接打开。画布背景墙的浅深
切换是本机编辑偏好，不进入设计数据。

通用配置表面负责直播间号、登录凭证、礼物插队门槛、相同消息归并窗与硬上限，以及 Overlay
启用、端口和 Agent 公告字数上限。

日志面板两秒一拍轮询 `log.state`。
状态里的 `total` 是**记过的总条数**(含被 `RECENT_CAP` 挤掉的),扩展按它的差值只补新行
——整份重铺会刷掉尾部粘滞与用户往上翻的位置。

目录名 `worlds/bilibili` 的末段必须与 World id `bilibili` 对得上:浏览器产物的 asset key 由目录名推导
(`src/worlds/<x>/console/client.ts` → `world:<x>`),而控制台按 provider id `world:bilibili` 去取它。
两边对不上时页面上出现的是"声明了面板,但没有构建出浏览器扩展"。

## 字段待校

`normalize.ts` 里这几条**没有在实测中见过**,字段形状按社区文档写的,真遇上要照原始 JSON 校一次:
`ROOM_BLOCK_MSG`(禁言)、`ROOM_SILENT_ON/OFF`、`WARNING`、`CUT_OFF`。
实测见过并对齐过的是:`DANMU_MSG`、`USER_TOAST_MSG_V2`、`INTERACT_WORD_V2`、`LIKE_INFO_V3_*`、`WATCHED_CHANGE`、
`ONLINE_RANK_COUNT`、`ROOM_REAL_TIME_MESSAGE_UPDATE`、`STOP_LIVE_ROOM_LIST`。

`INTERACT_WORD_V2` 是 protobuf(不是 JSON),分不出进场/关注/分享,一律按进场计数。

## 已知的坑

- **412 / -352 风控**:握手的 HTTP 请求打太频会中招。重连是指数退避(2s → 60s 封顶),
  别改成固定短间隔重试——重试正是触发风控的原因。
- **长连约 7 天会静默超时**(收得到心跳回执但不再来消息)。当前靠 `close` 事件重连;
  若真跑到那个时长仍静默,要另加"久无消息即重连"的判据。
- 这条路是非官方接口。字段随时可能变,`IGNORED` 之外的新 cmd 会自动出现在控制台计数里。
