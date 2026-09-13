# Cortico

基于事件流的 Agent Harness:给自主响应、持续运行、混合输入与实时场景的人格 Bot 用。它不是
问答式聊天 Bot 框架,不预设人格或记忆方案,也不是 coding agent。是什么、为什么这样设计,读
[PHILOSOPHY.md](PHILOSOPHY.md)。

四层:**Core** 持有 session、事件流与模型调用的生命周期,不拥有任何语义;**Persona** 定义一类
Bot 的语义与对 Memory 的解释;**Memory** 是 Bot 内部状态的唯一权威载体;**World** 是与一个外部
环境之间的唯一边界。一个 **Bot** 选一个 Persona、声明一组 World。

- [快速开始](#快速开始)
- [部署](#部署) · [配置](#配置) · [Provider](#provider) · [控制台](#控制台)
- [Session](#session) · [Run 与日志](#run-与日志)
- [Persona 与 Bot](#persona-与-bot) · [World](#world) · [扩展](#扩展)
- [环境变量](#环境变量) · [Windows](#windows) · [开发](#开发)
- [仓库地图](#仓库地图) · [命令](#命令)

## 快速开始

Node 22+。

```bash
corepack pnpm install
```

建一份部署,指向参考 bot `cormini`(最小完整实现,只有终端对话):

```bash
mkdir -p deployments/mybot && echo '{ "bot": "cormini" }' > deployments/mybot/deployment.json
```

开箱的端点是 DeepSeek 的 `openai-responses-compat` 种子,只缺密钥:

```bash
mkdir -p deployments/providers/deepseek && echo "DEEPSEEK_API_KEY=你的key" > deployments/providers/deepseek/.env
```

别的端点在控制台「语言模型」页建。然后:

```bash
pnpm start mybot
```

控制台在 `http://127.0.0.1:7788/`。

上面那条是原语。给操作员的那一层是 `./start.sh`(Windows 上双击 `start.bat`):它把依赖与
控制台产物补齐、列出部署让你选、起进程并在按下「重启」后把它拉回来。

## 部署

一份部署是一个目录:`deployment.json` 指向代码包,`config.json` 压过包的默认值,`.env` 放 World
的密钥,`memory/` 是 Memory,`data/` 是运行数据。部署根由 `CORTICO_HOME` 定,默认
`deployments/`,整片不进版本控制;端点表 `providers/` 与各部署平级。[docs/deployment.md](docs/deployment.md)

## 配置

四层深合并:框架默认与 bot 默认 ← 包里的 `worlds/<id>/config.json` ← 端点表 ← 部署
`config.json`。每个旋钮是其 owner 的 `ConfigGroup` 里一条 JSON Schema 属性,控制台按声明渲染、
热改并原子写回。[docs/configuration.md](docs/configuration.md)

## Provider

模型端点的方言。内建 `openai-responses-compat`(原生 Responses API)与 `llamacpp`(本机
llama-server,可下载托管),其余是扩展。端点是全局事实:
`providers/<端点名>/` 一个端点一个目录,模型、采样、密钥、价目都在那里;Persona 看不见模型。
[docs/providers.md](docs/providers.md)

## 控制台

每份部署一个本机 Web 控制台:终端、运行诊断、用量、语言模型、World 总览、扩展、设置。World、
Persona、provider 各自贡献自己的页,框架按声明渲染,新增一个 World 不改 `src/web/**` 一个字节。
[docs/console.md](docs/console.md)

## Session

一个 session 是一次独立的模型对话,由 Persona 声明,恰好一个接收事件投递。Core 只守一条物理线
`hardTokens`,交接策略与阶段预算归 Persona。[docs/sessions.md](docs/sessions.md)

## Run 与日志

一次进程存活是一个 run,`data/runs/<run>/` 装事件、日志、上下文记录与工具流水,每条日志带
session / 轮 / 调用 / 工具 / 事件锚点。`pnpm logq` 查。[docs/runs.md](docs/runs.md)

## Persona 与 Bot

Persona 契约是一组按机械时机命名的钩子,Core 只通知时机、自己不写一个字。Bot 是
`bots/<名>/index.ts` 里的一份装配定义。三个参考 bot:`corti-soulmate`、`cormini`、`cortiv`。
[docs/personas.md](docs/personas.md)

## World

`World` 把环境变化投成事件、把外部行为声明成工具、给前缀一段环境描述;`WorldHost` 给它事件库、
投递档位与代想句柄。内建 terminal、qq、bilibili、minecraft、websearch。
[docs/worlds.md](docs/worlds.md)

## 扩展

npm 包,补一个 World、provider 或 bot。装在 `extensions/` 下,控制台可搜可装,重启生效。
`cortico-world-vtuber`、`cortico-world-asr`、`cortico-world-pvz`、`cortico-world-canvas`、
`cortico-provider-grok` 都是扩展。
[docs/extensions.md](docs/extensions.md)

## 环境变量

`CORTICO_HOME`、`CORTICO_BOT`、`CORTICO_LOG`、`CORTICO_LANGUAGE`、`CORTICO_START_PAUSED`、
`CORTICO_OPEN_BROWSER`、`CORTICO_SUPERVISED`,以及密钥的三处 `.env`。
[docs/environment-variables.md](docs/environment-variables.md)

## Windows

平台分支所在,已知的坑。[docs/windows.md](docs/windows.md)

## 开发

命令、两份 tsconfig、测试布局、目录。[docs/development.md](docs/development.md);规则在
[AGENTS.md](AGENTS.md),贡献流程在 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 仓库地图

| 路径 | 内容 | 参考 |
|---|---|---|
| `bin/cortico.mjs` | 操作员那一层的启动器(纯 JS,零依赖) | [docs/deployment.md](docs/deployment.md) |
| `src/core/` | Core | [src/core/README.md](src/core/README.md) |
| `src/bot.ts`、`src/world.ts`、`src/deploy.ts`、`src/paths.ts`、`src/launcher.ts` | 装配、部署、启动 | [docs/deployment.md](docs/deployment.md) |
| `src/providers/`、`src/protocol/open-responses/` | 模型端点与线协议 | [src/providers/README.md](src/providers/README.md) |
| `src/web/` | 控制台 | [src/web/README.md](src/web/README.md) |
| `src/extensions/` | 扩展装载 | [src/extensions/README.md](src/extensions/README.md) |
| `src/worlds/<id>/` | 内建 World,各有 README | [docs/worlds.md](docs/worlds.md) |
| `bots/<名>/` | bot 包 | [bots/README.md](bots/README.md) |
| `scripts/` | 构建、日志查询、审计、迁移 | [docs/development.md](docs/development.md) |
| `tests/` | 测试 | [docs/development.md](docs/development.md) |

## 命令

| 命令 | 作用 |
|---|---|
| `pnpm start <部署名>` | 起一份部署 |
| `pnpm bots` | 列出可起的部署 |
| `pnpm test` | 全量测试 |
| `pnpm run typecheck` / `pnpm typecheck:web` | Node 侧 / 浏览器侧类型检查 |
| `pnpm build:web` | 控制台产物 |
| `pnpm dev:console` | 假数据控制台 |
| `pnpm logq` | 查运行日志 |
| `pnpm check:extension <目录>` | 校验扩展包 |
| `pnpm audit:release` | 发布审计 |

MIT。
