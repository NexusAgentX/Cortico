# src/web

Owner: `src/web/server.ts`, `src/web/shared/console-protocol.ts`, `src/web/shared/client-panel.ts`

控制台的服务端、线协议与浏览器内核。它不持有任何一页的内容:页由 Core 派生(框架页)或由
World / Persona / provider 贡献,服务端只做聚合、校验与分发。

## 目录

| 路径 | 管什么 |
|---|---|
| `server.ts` | `WebApp`:Express + WebSocket,`/api/*` 路由,静态产物,首页注入 |
| `console-pages.ts` | `ConsolePageRegistry` / `ConsoleAssets`:页与产物的聚合,读 `dist/web/asset-manifest.json` |
| `path-picker.ts` | 本机路径选择器(按平台分派) |
| `shared/console-protocol.ts` | 线协议:页 id、manifest 形状、路由常量、安全闸。服务端与浏览器都 import |
| `shared/client-panel.ts` | 面板契约:`ConsolePanelContext`、`ConsoleUi`、`ConsolePanel`。只有浏览器 import |
| `client/core/` | 内核:`api`、`router`、`lifecycle`、`stream`、`websocket`、`language` |
| `client/console-pages/` | 贡献页的宿主:`host`(渲染 chrome、挂面板)、`loader`(加载面板 bundle)、`context`(造 `ctx`)、`builtins`(框架提供的内建面板,如 `llm-settings`) |
| `client/features/` | 框架自己的页,每页一个 `FrameworkFeature` |
| `client/ui/` | `ConsoleUi` 原语的实现与图标 |
| `client/shell/`、`client/theme/` | 外壳与主题 |
| `public/` | `index.html` 与 Tailwind 入口 |

## 协议

`ConsolePageKind = 'framework' | 'world' | 'persona' | 'llm'`;页 id `world:<id>` /
`persona:<id>` / `llm:<id>`,`pageIdFor()` 是唯一的构造口,构建脚本与服务端共用。面板 id 只在页内
唯一。`CONSOLE_PROTOCOL_VERSION` 守源码与 `dist/` 产物的错位:manifest 版本不符则一页都不加载。

贡献方的 `ConsolePageContribution` 经 `toPageManifest()` 降维成线上的 `ConsolePageManifest`:
`invoke`、`promptDocs.path`、`config.schema`、`storage` 不出线,`links` 与 `builtin` 消毒。
资产 URL 只放行白名单字符集;`links` 拦 `javascript:` 与 `data:`。灯最多 7 颗。

路由常量:`/api/console/manifest`、`/api/console/lamps`、面板数据面
`/api/console/providers/<page>/panels/<panel>/<method>`(GET 走 query JSON 数组,POST 64 MiB),
面板流 `/ws/providers/<page>/panels/<panel>`。历史原因线协议里贡献页仍叫 `providers`。

## 服务端

`WebApp` 只绑 `127.0.0.1`,端口被占顺延最多五次。WebSocket 用 `noServer` 手工分派,只认
`/ws/debug`、`/ws/sessions` 与面板流路径,跨站 Origin 在 upgrade 时断开。静态产物只暴露
`dist/web` 一条(`/assets`),首页认最后一个 `</body>` 注入带 hash 的内核入口。扩展的面板 bundle
另走 `/assets/extensions/<包>/<版本>/<文件>`,只发 manifest 声明的两个文件。

依赖倒置:`WebAppDeps` 由 `createBot()` 组装(事件库、session、run 控制、配置、存储、
`consolePageSources`、`extensions`),服务端不 import Core。

## 浏览器内核

`main.ts` 持有框架页表 `FEATURES`(`live`、`core`、`usage`、`provider`、`world`、
`extensions`、`prompts`、`config`、`storage`、`appearance`、`settings`);这张表不违反「内核不持
贡献方清单」:贡献页由 manifest 驱动。`provider` 是保留路由段,归 `ConsolePageHost`。

`ConsolePageHost` 渲染页的 chrome(徽标、灯、配置组、提示词文档)并挂面板;
`ConsolePageLoader` 按页 id 从 `asset-manifest` 找 bundle,`import()` 一次缓存,校验默认导出是
`{ panels }`,面板缺 `mount` 就给错误卡。卸载顺序:abort → dispose → 清空 root;之后轮询、RAF、
observer、监听、挂起的 fetch 与音频都停。

`ConsoleUi` 返回真实 DOM,不收 HTML 字符串;绑定面板 `signal`,abort 时关 toast /
confirm / drawer,待决 confirm 回 `false`。

## 构建

`scripts/build-web.ts` 发现入口:`src/web/client/main.ts`、`src/worlds/*/console/client.ts`
→ `world:<name>`、`src/providers/*/console/client.ts` → `llm:<name>`、`bots/*/console/client.ts`
→ `persona:<name>`;esbuild 分包、esm、`[dir]/[name]-[hash]`,写 `asset-manifest.json`。
Tailwind 单独出 `styles.css`。浏览器代码由 `tsconfig.web.json` 检查(`pnpm typecheck:web`)。
