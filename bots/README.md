# bots/

Owner: `src/paths.ts`, `src/deploy.ts`, `src/bot.ts`

每个子目录是一个 **bot 代码包**:Persona代码、建议配置、装配、以及提示词与
演出资产。**这里没有任何一份部署**——config.json、密钥、她的记忆、运行数据都在
部署根(默认 `deployments/`,位置由 `CORTICO_HOME` 决定,见仓库根 `.env.example`)。

一份部署用 `deployment.json` 声明它引用哪个包,所以同一个包可以有多份部署
(`deployments/cortiv/` 与 `deployments/cortiv-测试/` 都可以 `{ "bot": "cortiv" }`)。
启动器列的是部署,不是包。

```bash
pnpm start <名字>     # 或者双击 start.bat，从菜单里选
pnpm start --list     # 列出可启动的
```

## 包里有什么(全部进版本控制)

| | |
|---|---|
| `index.ts` | `BotDefinition`:Persona怎么造、声明哪些渠道(`declares`)、层2 建议配置、控制台增量。**唯一**知道"这是哪个包"的文件。World 实现不在这里列:仓内目录与扩展由启动器并成一张表;哪些真挂上由部署的 `config.json` 里 `worlds.<id>.enabled` 决定,控制台可热激活 / 停用 / 重启。 |
| `persona/` | Persona 代码。 |
| `vtuber-pack/` | 挂 `cortico-world-vtuber` 的包才有:演出词表、曲线与参数集,人格资产。目录在,World 就用它;`worlds.vtuber.packDir` 可指到别处;都没有用 World 自带的范例包。 |
| `worlds/<id>/ENV_PROMPT.md` | 这个人格对某个 World 环境提示词模板的覆盖(**层 2**,整份替换,占位符照常插值)。文件不在就用 World 自带的 `src/worlds/<id>/ENV_PROMPT.md`。 |

## 部署里有什么(全部不进版本控制)

在 `<CORTICO_HOME>/<部署名>/` 下:

| | |
|---|---|
| `deployment.json` | 这份部署引用哪个包:`{ "bot": "cortiv" }`。 |
| `config.json` | 层 3 部署配置:换一台机器就要改的东西 + 操作者的选择。 |
| `.env` | 这份部署的 World 密钥。provider 的密钥不在这里,在部署根的 `providers/<端点名>/` 下。 |
| `memory/`（或 `workspace/`） | Memory 内容,带独立 git 历史。目录名由 Persona 的 `paths.memory` 决定。 |
| `worlds/<id>/ENV_PROMPT.md` | **层 3**:部署者自己微调的那一份,压过包里的层 2。控制台上改环境提示词只写这里,包里那份不动;「恢复默认」即删掉它,回落层 2。 |
| `prompts/` | Persona文本的部署侧那份:`ORIENTATION.md` 存在即压过包里的自述;`FIRST_TURN_{USER,THINKING,REPLY}.md` 是合成首轮对话(风格锚),**只有这一层**,包里不带,开关 `context.firstTurn` 默认关。 |
| `vtuber-pack/` | 层 3 演出包覆盖(可选)。 |
| `avatar.png` / `voices/` | 头像与参考声线,部署者持有的素材。 |
| `data/` | 事件库、session、用量流水、Core 状态。判据:**删掉之后还能不能起来**——能才放这里。 |

三样东西(提示词、 World 配置、演出包)都是同一套三层:**逐层深合并,同名文件整份替换,后一层赢**。

## 现有的

三个 bot,三个独立的Persona类:

| 目录 / 启动 id | 类 | bot 名 | 是什么 |
|---|---|---|---|
| `corti-soulmate` | `CortiSoulmate` | Yukima | 演化型人格伙伴。分层记忆、潜意识三路、QQ 起草-确认门、提案与宪法。默认端口 7777。 |
| `cormini` | `Cormini` | 可缇mini | 最小完整实现。工作区即记忆、宪法即前缀、一个 session、只有终端。默认端口 7788。 |
| `cortiv` | `CortiV` | 可缇Corti | AI VTuber 实时系统。继承 Cormini,内建直播 memory(观众档案首见唤起/交接并行梦);终端、VTuber、B站直播间与 Minecraft。默认端口 7789。 |

## 加一个新的

两条路,按分叉深浅选:

- **继承**:像 `cortiv` 那样 `class CortiV extends Cormini`,把差异写成**独立类的行为**
  (覆写时机钩子/前缀段/交接策略)。不要给基类加构造开关——变体是类,不是参数组合。
- **复制**:要改记忆结构、session 形态这类骨架时,复制 `cormini` 整个目录再改 `persona/`。

两条路都要改掉 `index.ts` 里的 `id` 与 `web.port` 建议值,并给它建一份部署
(部署根下新开一个目录,写 `deployment.json` 指向这个包)。控制台不需要你写——
`createBot` 从 Core 派生框架级的那一整套,你只在 `console` 里补它派生不出来的东西。
