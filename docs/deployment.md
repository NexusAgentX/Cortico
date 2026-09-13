# 部署

Owner: `src/paths.ts`, `src/deploy.ts`, `src/launcher.ts`

一份部署是一个目录,持有一个 bot 的配置、密钥、Memory 与运行数据,整片不进版本控制。
代码包在 `bots/<名>/`,永远在仓库里;一个包可以背好几份部署。

## 部署根

所有部署的父目录。解析链:进程环境 `CORTICO_HOME` > 仓库根 `.env` 里的 `CORTICO_HOME` >
`<主仓库根>/deployments/`。相对路径按主仓库根解析;git worktree 共享主仓库的这一份。

部署根下与各部署平级的还有三个机器级目录,一台机器一份,几份部署共用。它们没有
`deployment.json`,启动器列不出它们:

| 目录 | 是什么 |
|---|---|
| `providers/` | 端点表(见 [providers.md](providers.md)) |
| `runtimes/<id>/<版本>/` | 可执行运行时,一个版本一个目录(见 [runtimes.md](runtimes.md)) |
| `models/<owner>/` | 模型文件;owner 是 provider id 或 World id |

## 建一份

```bash
mkdir deployments/mybot
echo '{ "bot": "cormini" }' > deployments/mybot/deployment.json
pnpm start mybot
```

`deployment.json` 只有一个字段 `bot`:引用哪个代码包。仓内 `bots/<名>/` 有它就是那个,否则是
`extensions/` 下装的同名 bot 包(见 [extensions.md](extensions.md))。其余文件按需出现:

| 路径 | 是什么 |
|---|---|
| `config.json` | 这份部署的配置,压过包里的默认值(见 [configuration.md](configuration.md)) |
| `.env` | 这份部署里 World 的密钥(`SESSDATA`、`BRAVE_API_KEY`…),一行一个 `NAME=value` |
| `memory/` | Memory。目录名由 Persona 的 `paths.memory` 定(Cormini 与 CortiV 用 `workspace/`) |
| `data/` | 运行数据。判据:删掉之后还能起来 |
| `prompts/` | Persona 文本的部署侧覆盖:`ORIENTATION.md`;`FIRST_TURN_{USER,THINKING,REPLY}.md` 只有这一层 |
| `worlds/<id>/ENV_PROMPT.md` | 某个 World 环境提示词的部署侧覆盖,整份替换。控制台上改就写这里,「恢复默认」即删它 |
| `avatar.png`、`voices/` | 头像与参考声线 |

`data/` 里:`runs/index.jsonl` 与 `runs/<run>/`(见 [runs.md](runs.md))、`session-main.jsonl`
等 session 文件(见 [sessions.md](sessions.md))、`usage.jsonl`、`core-state.json`、
`timers.json`、单实例锁 `instance.lock`、重启标志 `.restart-request`。

环境提示词三层:World 自带的 `src/worlds/<id>/ENV_PROMPT.md` → 代码包的
`bots/<名>/worlds/<id>/ENV_PROMPT.md` → 部署的 `worlds/<id>/ENV_PROMPT.md`。后一层整份覆盖前一层。

## 启动

```bash
pnpm start <部署名>
```

| 参数 / 变量 | 作用 |
|---|---|
| `--list`(`pnpm bots`) | 列出部署根下每个含 `deployment.json` 的目录 |
| 不给名字 | 取 `CORTICO_BOT`;只有一份部署时可省略 |
| `--paused`、`CORTICO_START_PAUSED=1` | 启动即暂停:事件照常落库排队,去控制台点「继续」才上线 |
| `--open`、`CORTICO_OPEN_BROWSER=1` | 起来后打开控制台 |
| `--log-level=<级别>`、`CORTICO_LOG` | 日志落盘门槛,压过 `config.json` |
| `--force-second-instance` | 绕过单实例锁 |

启动前校验:`activeProvider` 必须在端点表里;它声明的 `secret` 必须能从进程环境或
`providers/<端点名>/.env` 读到。任一不满足直接退出。

`bin/cortico.mjs` 是给操作员的那一层:补依赖与控制台产物、选部署(多份时弹方向键菜单)、
设 `CORTICO_START_PAUSED=1`、`CORTICO_OPEN_BROWSER=1`、`CORTICO_SUPERVISED=1`,再 fork 出
进程并监管它。`start.bat` 与 `start.sh` 只是它的壳。控制台的「重启进程」靠它回来;
裸 `pnpm start` 起的进程没有它,重启等于关机。

**只有子进程明说要重启才重起。** 两条证据任一成立:IPC 消息,或 `data/.restart-request`
(给「消息发出前被硬杀」兜底)。崩溃、非零退出、被信号打死一律不重起——那是需要人看一眼的
事,悄悄拉回来只会让同一个故障刷屏并盖掉第一现场。

## 关机

SIGINT / SIGTERM / SIGHUP(Windows 另加 SIGBREAK)走分步关机,外层期限 35 秒;未捕获异常
也走同一仪式。Windows 上关窗口只给约 5 秒,来不及存盘,完整关机从控制台点。

## 多份部署

同一个包起两份:两个目录各有 `deployment.json` 指同一个 `bot`,各自的 `config.json` 给不同
`web.port`。单实例锁按 `data/` 目录隔离,互不影响。

## 迁移

磁盘布局改名时仓库附迁移脚本,`tsx scripts/migrate-rename.ts` 只列计划,`--apply` 才动:
`config.json` 先备份再原子替换,事件库、session 与游标不碰。
