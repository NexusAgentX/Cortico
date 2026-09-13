# 配置

Owner: `src/deploy.ts`, `src/core/config.ts`, `src/core/config-schema.ts`

一份部署的配置是四层深合并的结果,后一层赢,数组整体替换:

1. `CORE_DEFAULTS`(`src/core/config.ts`)、bot 包的 `defaults()`,以及本机每个 World 实现的默认段
   (仓内目录加扩展;Persona 声明过的 `enabled: true`,其余 false);
2. 包里的 `bots/<名>/worlds/<id>/config.json`,只覆盖那个 World 的段;
3. 部署根 `providers/<端点名>/config.json` 汇成 `providers` 表;部署 `config.json` 里写的
   `providers` 段被丢弃;
4. 部署 `config.json`。

合并结果是运行时共享的活对象:控制台热改先写它,再写回部署 `config.json`。写盘是读、改、
临时文件、rename、失败回滚的原子过程;文件解析失败就拒绝写回。

## 顶层键

| 键 | 默认 | 含义 |
|---|---|---|
| `displayName` | `bot` | 展示名:控制台标题、终端出方 |
| `timezone` | `Asia/Shanghai` | 时间戳与时刻表用的时区 |
| `providers` | 一条 `deepseek` 种子 | 端点表,真身在部署根 `providers/`(见 [providers.md](providers.md)) |
| `activeProvider` | `deepseek` | 当前端点 |
| `web.port` | `7777` | 控制台端口;三个参考 bot 各自改成 7777 / 7788 / 7789 |
| `paths.memory`、`paths.data` | `memory`、`data` | Memory 与运行数据目录,相对部署目录 |
| `batching` | `quietGapMs 2500`、`minBatchAgeMs 0`、`maxBatchAgeMs 15000`、`maxBatchSize 100` | 事件合批投递 |
| `context` | `keepPastThinking true`、`firstTurn false` | 发给模型前的处理;阶段预算归 Persona 的段 |
| `logging` | `file debug`、`console info`、`areas ''` | 日志门槛与按区域覆盖,热改 |
| `worlds.<id>` | 各 World 自定 | `enabled` 决定挂不挂;其余形状归 World |
| `language` | 系统区域 | 控制台默认语言 `zh` / `en`,浏览器可改(见 [console.md](console.md)) |

Persona 自己的段(如 CortiV 的 `context.maxTokens`、`rounds`、`cognition`、`tick`)由各 bot 的
`index.ts` 定义。

## 声明旋钮

每个可调项是其 owner 的 `ConfigGroup` 里一条 JSON Schema 属性,键是点分路径;控制台按
schema 渲染,没有手写表单。owner 是 `core`、`persona`、`world:<id>` 或 `provider:<kind>`。
支持的类型:integer、number、boolean、string(可 enum)、二元数组;其余降级为只读。扩展键:

| 键 | 作用 |
|---|---|
| `x-hot` | `false` 时前端标「重启生效」;Core 组每一项都是热改 |
| `x-scale`、`x-suffix` | 显示倍率与单位 |
| `x-options` | 下拉项 |
| `x-path` | 用本机路径选择器填 |
| `x-download` | 附下载动作 |

`POST /api/config` 按 schema 校验,未声明的键忽略。World 段的写回走 `WorldHost.persist`,同时
改活对象与 `config.json` 的 `worlds.<id>`;World 的密钥写部署 `.env` 并注入进程环境。
provider 组例外:端点值写 `providers/<端点名>/config.json`,`activeProvider` 写部署 `config.json`。

## 层 2 与层 3 的分界

包里放人格身份与演出选择(`minecraft.username`、`vtuber.delayedSources`);部署放本机事实
(凭证、程序路径、设备、开没开)。同一个键两边都能写,部署赢。
