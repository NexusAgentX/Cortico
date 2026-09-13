# cortico-world-example

Owner: `src/definition.ts`

最小完整的 World:挂载时投一条 `example.started` 事件,提供 `example_echo` 工具,一段环境提示词,
一个热改的旋钮 `worlds.example.greeting`。它验证的是接线:事件进时间线、工具可调用、旋钮在控制台
可改且回执随之变。

| 文件 | 内容 |
|---|---|
| `src/definition.ts` | `WorldDefinition`:id、label、默认配置段、`create()` |
| `src/config.ts` | 配置段类型、默认值、控制台配置组 |
| `src/world.ts` | `World` 实现:事件、工具、`console()` 声明 |
| `src/ENV_PROMPT.md` | 环境提示词模板;`{{example.greeting}}` 由 `envPromptVars()` 报值 |
| `tests/` | 干装载、事件、工具回执;`helpers/fake-host.ts` 是记录推送的假宿主 |

改名清单:包名、`id: 'example'`、`EXAMPLE` / `Example` / `example_` 前缀、事件 `type` 的 `example.`
段、配置键 `worlds.example.*`、promptDoc key。规矩见 [docs/worlds.md](../../../docs/worlds.md)。
