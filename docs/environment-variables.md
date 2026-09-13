# 环境变量

Owner: `src/paths.ts`, `src/launcher.ts`, `src/core/secrets.ts`

| 变量 | 读取处 | 作用 |
|---|---|---|
| `CORTICO_HOME` | `src/paths.ts` | 部署根。也可写在仓库根 `.env`;相对路径按主仓库根解析 |
| `CORTICO_BOT` | `src/launcher.ts` | `pnpm start` 不给名字时的部署名 |
| `CORTICO_LOG` | `src/launcher.ts` | 日志落盘门槛,次于 `--log-level=`,高于 `config.json` |
| `CORTICO_START_PAUSED` | `src/launcher.ts` | `1` / `true`:启动即暂停 |
| `CORTICO_OPEN_BROWSER` | `src/launcher.ts` | `1` / `true`:起来后打开控制台 |
| `CORTICO_SUPERVISED` | `src/boot.ts` | 由 `bin/cortico.mjs` 设置;控制台据此把「重启进程」标成会回来,子进程也据此才往 IPC 通道发消息 |
| `CORTICO_LANGUAGE` | `src/core/language.ts` | 控制台默认语言,次于 `config.json` 的 `language` |
| 任意密钥名 | `src/core/secrets.ts` | 进程环境里有就用它,否则读对应 `.env` |

密钥按持有者分三处,读法都是「进程环境优先,否则读文件一次」:

| 文件 | 放什么 |
|---|---|
| 仓库根 `.env` | 只放 `CORTICO_HOME`。密钥写在这里读不到 |
| `<部署>/.env` | World 的密钥:`SESSDATA`、`BRAVE_API_KEY`、`OPENROUTER_API_KEY`、`VTS_AUTH_TOKEN`… |
| `<部署根>/providers/<端点名>/.env` | 该端点的密钥,名字由端点条目的 `secret` 字段定 |

`.env` 一行一个 `NAME=value`,值不能含空格。控制台写密钥只写不读回。

进程自己设给子进程的:`COREPACK_ENABLE_DOWNLOAD_PROMPT=0`(装扩展时)、
`CORTICO_PICKER_*`(本机路径选择器)。开发脚本:`CORTICO_DEV_MINIMAL=1` 让 `pnpm dev:console` 只挂终端 World,`CORTICO_PORT` 改它的端口
(默认 8848)。
