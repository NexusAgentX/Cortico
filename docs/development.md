# 开发

Owner: `package.json`, `vitest.config.ts`, `tsconfig.json`, `tsconfig.web.json`

Node 22+,pnpm 11(经 corepack 钉版本)。规则在 [AGENTS.md](../AGENTS.md),贡献流程在
[CONTRIBUTING.md](../CONTRIBUTING.md)。

## 命令

| 命令 | 作用 |
|---|---|
| `pnpm start <部署名>` | 起一份部署;`pnpm bots` 列出可起的 |
| `pnpm test` / `pnpm test:watch` | vitest;`pnpm exec vitest run <路径>` 跑一部分 |
| `pnpm run typecheck` | Node 侧 `tsc --noEmit` |
| `pnpm typecheck:web` | 浏览器侧,`tsconfig.web.json` |
| `pnpm build:web` | 控制台产物:esbuild 分包 + Tailwind,写 `dist/web/` |
| `pnpm dev:console` | 假数据起控制台,`http://127.0.0.1:8848/`;不连真实 API,不起 Core |
| `pnpm logq` | 查运行日志(见 [runs.md](runs.md)) |
| `pnpm check:extension <目录>` | 校验一个扩展包 |
| `pnpm audit:release` | 发布审计:部署资源、明文凭证、异常大文件 |

提交前 `pnpm test` 与 `pnpm run typecheck` 都绿;改了浏览器代码再加 `pnpm typecheck:web` 与
`pnpm build:web`。bot 进程活着时别 `build:web`。验证改动不起真 bot:用测试、`dev:console` 或
`scratch/` 下的脚本。

## 两份 tsconfig

Node 侧与浏览器侧的 lib 互斥:`tsconfig.json` 排掉 `src/web/client/**`、`src/web/shared/**`、
各 `console/**` 与 jsdom 测试;`tsconfig.web.json` 换上 DOM、去掉 `@types/node`,`include` 必须
逐条对上根配置的 `exclude`,`exclude` 必须显式清空,否则会静默变成检查零个文件且退出 0。
被 Node 侧 import 到的共享文件两边都查。

## 测试

`vitest.config.ts`:`pool: forks`,两个 worker,超时 20 秒,`CORTICO_LANGUAGE=zh`(断言中文
文案,与机器区域无关)。

| 目录 | 覆盖 |
|---|---|
| `tests/*.test.ts` | 部署分层、装配、扩展、路径、发布审计、环境提示词契约、状态灯契约、架构边界 |
| `tests/core/` | 总线、主循环、fork、事件库、附件、成本、上下文;`fixture-*.ts` 是脚本化的模型 |
| `tests/web/` | 控制台:协议、内核、各框架页、面板 bundle、零 diff 验收 |
| `tests/worlds/<id>/` | 各 World |
| `tests/corti-soulmate/`、`tests/cormini/`、`tests/cortiv/` | 三个 Persona |
| `tests/integration/` | 整机:启动即暂停、QQ 起草确认、彩排 |
| `tests/helpers/` | `fake-host.ts`(World 的假宿主)、`mock-napcat.ts`(假 OneBot 协议端) |

只有模型是脚本化的;git 仓库、端口、事件库都是真的。测试不出网。

## 目录

| 路径 | 内容 |
|---|---|
| `bin/cortico.mjs` | 操作员那一层的启动器。纯 JS 零依赖:它要在 `node_modules` 存在之前就跑得起来 |
| `src/core/` | Core(见 [src/core/README.md](../src/core/README.md)) |
| `src/bot.ts`、`src/world.ts`、`src/deploy.ts`、`src/paths.ts`、`src/launcher.ts` | 装配、部署与启动 |
| `src/providers/`、`src/protocol/open-responses/` | 模型端点与线协议 |
| `src/web/` | 控制台 |
| `src/extensions/`、`src/extensions.ts` | 扩展装载 |
| `src/worlds/<id>/` | 内建 World |
| `bots/<名>/` | bot 包 |
| `scripts/` | `build-web`、`dev-console`、`logq`、`extension-check`、`release-audit`、`migrate-rename`、`generate-open-responses` |
| `scratch/`、`deprecated/`、`deployments/`、`extensions/` | 都不进版本控制 |

## 文档

`docs/` 每页与每份代码单元的 README 首行写 owner。改 owner 的提交改页。没有代码 owner 的文字
不进 `docs/`。
