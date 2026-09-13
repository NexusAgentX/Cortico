# src/extensions

Owner: `src/extensions/manifest.ts`, `src/extensions/runtime.ts`, `src/extensions/dry-mount.ts`, `src/extensions.ts`

扩展是装在 `extensions/` 下的 npm 包,给框架补一个 World、一个 provider 或一个 bot。
三类共用一份 manifest 与一条装载线;按 `kind` 分叉的只有默认导出的形状校验、id 命名空间
和控制台页前缀。`dry-mount.ts` 把装载之后、`start()` 之前那段在假部署里做一遍
(World `create()` / `tools()` / `console()`,provider `create()`,bot `build()`),只给
`pnpm check:extension` 用。

## manifest

包的 `package.json` 里一块 `cortico`:

```jsonc
{
  "name": "cortico-world-vtuber",
  "type": "module",                       // 硬要求:CommonJS 包会拿到框架源码的第二份副本
  "keywords": ["cortico-world"],          // npm 搜索按类关键字:cortico-world / cortico-provider / cortico-bot
  "cortico": {
    "kind": "world",                      // world | provider | bot
    "api": 3,                             // 扩展契约版本,与 EXTENSION_API_VERSION 相等才装
    "consoleClient": "dist/console.js",   // 可选:预构建的面板 bundle,包内相对路径
    "consoleStyle": "dist/console.css"    // 可选:随 bundle 注入的样式
  }
}
```

`parseExtensionManifest(pkg)` 只做解析与校验,不碰文件系统;装载器与
`pnpm check:extension <dir>` 共用它。`api` 与框架不等时不装,扩展页说明哪一边旧。
`WorldDefinition`、`ProviderModule`、`BotDefinition`(连同 `BotParts`、`Persona`、`LoadedConfig`)
或 `ConsolePanelContext` 任一不兼容变更就把 `EXTENSION_API_VERSION` 加一。

## 装载

`loadExtensions(repoRoot)` 读 `extensions/package.json` 的 dependencies,逐个从
`extensions/node_modules/<包>/` import 入口(`exports` → `module` → `main` → `index.js`),
按 `kind` 校验默认导出:

| kind | 默认导出 | 命名空间 | 控制台页 |
|---|---|---|---|
| `world` | `WorldDefinition`(`id` / `label` / `defaults()` / `create()`) | 与内建 World 共用 | `world:<id>` |
| `provider` | `ProviderModule`(`id` / `title` / `reasoningTiers` / `serviceTiers` / `create()`) | 与内建 provider 共用 | `llm:<id>` |
| `bot` | `BotDefinition`(`id` / `defaults()` / `build()`) | 不得与仓内 `bots/` 目录同名 | `persona:<id>` |

与内建同 id 的不装;两个扩展同 id 时先到的赢。加载失败只影响那一格,`ExtensionRecord.reason`
写明原因。

bot 包不在这条循环里 import:`deployment.json` 的 `bot` 字段指向哪个包,启动器就先经
`locateBotPackage()`(仓内 `bots/<名>/` 赢,其次 `extensions/` 下同名且 `kind: "bot"` 的包)与
`importBotDefinition()` 只 import 那一个,再把它作为 `activeBot` 交给 `loadExtensions()` 对账:
同名记录记 loaded,其余 bot 包记 `idle`。`ExtensionSet.bot` 说明这份部署的 bot 来自扩展包,
`createBot` 据此把包内的提示词模板设为只读(框架从不往包目录写:pnpm 把包文件硬链接进 store)。结果 `ExtensionSet` 里 `worlds` 由启动器接在仓内目录(`src/worlds/index.ts`)之后,整张表经
`withWorlds()` 交给 bot 定义(声明过的渠道 `enabled: true`),`providers` 交给 `registerProviderModules()`,`consoleAssets` 交给控制台。

新装或卸掉的包要重启进程:ESM 模块缓存不支持运行中换代码。

## 扩展怎么 import 框架

扩展写 `import { nowIso } from 'cortico/core/util.ts'`:`cortico/<路径>` 就是 `src/<路径>`。
`runtime.ts` 用 `module.registerHooks` 把这个前缀映到框架源码,再交给链上下一个解析器,
所以扩展与框架拿到同一份模块实例。fork 出去的子进程用 `childExecArgv()` 带上同一个钩子。

浏览器侧(面板 bundle)对 `cortico/*` 只允许 `import type`;bundle 里要用的运行时值由包自带。

## 控制台那一面

`ExtensionManager` 提供扩展页的数据面:`list()` 把启动时的加载结果对照此刻磁盘
(`loaded` / `failed` / `pending-restart` / `removed`),`search()` 按关键字查 npm registry,
`install()` / `uninstall()` 经 `corepack pnpm add|remove --ignore-workspace` 改 `extensions/`。
装卸串行。面板 bundle 的 URL 由服务端分配:`/assets/extensions/<包>/<版本>/<文件>`,只发
manifest 里声明的那两个文件。
