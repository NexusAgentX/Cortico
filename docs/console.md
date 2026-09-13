# 控制台

Owner: `src/web/server.ts`, `src/web/shared/console-protocol.ts`, `src/web/client/main.ts`, `src/web/client/core/language.ts`, `src/web/client/features/settings/general.ts`

每份部署起一个本机 Web 控制台:`http://127.0.0.1:<web.port>/`,端口被占时顺延(最多五次)。
只绑 `127.0.0.1`;WebSocket 升级时跨站 Origin 直接断开。

## 页

框架自己的页:

| 路由 | 页 | 内容 |
|---|---|---|
| `live` | 终端 | 与 bot 对话、时间线、上下文圈、fork |
| `core` | 运行诊断 | run、session、事件、运行日志、工具 |
| `usage` | 用量·成本 | 按 session、按天的 token 与费用 |
| `provider` | 语言模型 | 端点表(见 [providers.md](providers.md)) |
| `world` | World 总览 | 每个 World 一张卡:激活、停用、重启、灯与徽标 |
| `extensions` | 扩展 | 装卸与 npm 搜索(见 [extensions.md](extensions.md)) |
| `config` / `prompts` / `storage` / `appearance` / `settings` | 设置里的次级页 | 运行参数、提示词文档、存储清单、外观、语言 |

World、Persona 与 provider 各自贡献自己的页,页 id `world:<id>` / `persona:<id>` /
`llm:<id>`。页里有几个面板、面板叫什么、有哪些配置组与提示词文档,都由贡献方声明;
框架按声明渲染,`src/web/**` 不因新增一个 World 或 Persona 改一个字节
(`tests/web/acceptance-zero-diff.test.ts` 用真 esbuild、真服务器验证这条)。

## 一页里有什么

贡献方给的是一份 `ConsolePageContribution`:`lamps`(左栏那排状态点,最多 7 颗,由贡献方
自报)、`badges`、`panels`、`links`、`config`(配置组,控制台按 schema 渲染)、
`promptDocs`(可编辑的提示词文档,如环境提示词)、`storage`(存储清单)、`invoke`(面板的
数据面方法)、`stream`(面板的推送通道)。World 经 `World.console()` 声明,Persona 经
`Persona.console()`,两者形状对称。

有面板就要有面板 bundle:`src/worlds/<id>/console/client.ts`(Persona 是
`bots/<名>/console/client.ts`)默认导出 `{ panels: { <id>: { mount(ctx) } } }`,
`pnpm build:web` 自动发现并打包;扩展包自己 build,manifest 里声明产物路径。

面板拿到的 `ctx`(`src/web/shared/client-panel.ts`)是它与外界的唯一接口:`invoke` /
`invokeBinary` 调本面板的数据面,`stream` 订阅推送,`interval` / `timeout` / `frame` / `own`
登记的资源在卸载时自动释放,`memo` 是按页面板隔离的局部持久化,`guardLeave` 拦离开,
`pickPath` 打开本机路径选择器,`setConfig` 写配置组,`ui` 是原语集(`sheet`、`table`、
`log`、`toast`、`confirm`、`drawer`、`promptInput`…)。面板不碰 `document.body`,不直连
`/api/`,不用裸定时器。

## 运行控制

| 端点 | 行为 |
|---|---|
| `POST /api/run/pause` | 暂停:事件照常落库排队,不投递唤醒 |
| `POST /api/run/resume` | 继续:积压一次性投递 |
| `POST /api/run/shutdown` | 分步关机,请求挂到仪式跑完 |
| `POST /api/run/restart` | 落 `data/.restart-request` 再关机;有启动循环(`CORTICO_SUPERVISED`)才会回来 |

## 语言

界面语言是浏览器的属性,`zh` / `en`。默认值进程起来时读一次:`config.json` 的 `language` >
`CORTICO_LANGUAGE` > 系统区域(非中文即英文),写进 `<html lang>`。设置 → 通用的「简体中文 /
English」把选择存在当前浏览器里,刷新页面生效,不重启 bot。

之后每个请求自带语言(HTTP 头 `x-cortico-language`,WebSocket 握手查询串 `language`),服务端给
控制台的文案都按它现取:`World.console(language)`、`Persona.console(language)`、provider 的配置组、
回执、校验报错、关机账。面板经 `ctx.language` 读到同一个值。贡献方自己决定带不带第二套文案,
没有的那种给中文。

发给模型的文本不看它:World 自带的环境提示词模板、工具回执、事件正文固定英文;Persona 的文本
是作者写成什么语言就是什么语言。

中文界面里 Core、Persona、Memory、World 是专名,不翻译。

## 开发

`pnpm dev:console` 用假数据起一个控制台(端口 8848,`CORTICO_DEV_MINIMAL=1` 只挂终端 World),
不连任何真实平台。改了 `src/web/client/`、`src/web/shared/` 或任何 `console/client.ts` 都要
`pnpm build:web`;bot 进程活着时别跑它,运行中的控制台正在发那份产物。库内部结构见
[src/web/README.md](../src/web/README.md)。
