# 扩展

Owner: `src/extensions.ts`, `src/extensions/manifest.ts`

扩展是一个 npm 包,给一份部署补一个 World、一个 provider 或一个 bot。仓库内建的 World 与
provider 只有参考 bot 用到的那些;接一个新平台、一种新端点方言,写成扩展装进去。

## 安装

三条路,结果一样:`extensions/package.json` 多一条依赖,重启进程后加载。

- 控制台「扩展」页:搜索 npm 上带 `cortico-world` / `cortico-provider` / `cortico-bot` 关键字的包,点安装;
  或在「手动安装」里填 `name@version`。
- 控制台「手动安装」填本机目录的绝对路径:以 link 方式装入,改源码后重启即生效。给自己写
  扩展的人用。
- 命令行,在仓库根下:

```bash
cd extensions && corepack pnpm add --ignore-workspace <包名或目录>
```

`--ignore-workspace` 不能省:少了它 pnpm 会把 `extensions/` 当成仓库工作区的一员写进根
lockfile。

装完整进程重启。扩展页上每个包一张卡:`已加载` / `加载失败`(卡上写原因)/ `待重启`。
`extensions/` 整个目录不进版本控制,是部署状态。

## 起步

`templates/extension/` 下三种 kind 各一个最小完整包,都是能直接装的真包(仓库的测试对它们做干装载)。
复制一份出来,改包名与 id,把 `tsconfig.json` 的 `paths` 与 `vitest.config.ts` 的 alias 指到你的 Cortico
checkout,`corepack pnpm install`,`pnpm test`。每个模板的 README 说它验证什么、装进实例后该看见什么。

## 写一个 World 扩展

`package.json`:

```jsonc
{
  "name": "cortico-world-discord",
  "type": "module",
  "main": "./src/index.ts",
  "keywords": ["cortico-world"],
  "cortico": { "kind": "world", "api": 3, "consoleClient": "dist/console.js", "consoleStyle": "dist/console.css" }
}
```

入口默认导出一个 `WorldDefinition`(契约见 [worlds.md](worlds.md)):

```ts
import type { WorldDefinition } from 'cortico/world.ts';
export default { id: 'discord', label: 'Discord', defaults: () => ({ ... }), create: (ctx) => new DiscordWorld(ctx) } satisfies WorldDefinition<DiscordSection>;
```

框架以 `cortico/<src 下的路径>` import:`cortico/world.ts`、`cortico/core/types.ts`、
`cortico/core/util.ts`。运行时由 `src/extensions/runtime.ts` 的模块钩子解析到框架源码本身;
开发期在包的 `tsconfig.json` 里写 `"paths": { "cortico/*": ["../BOT/src/*"] }`,vitest 里加同样
的 alias。`"type": "module"` 是硬要求。

控制台面板可选。有则 `src/console/client.ts` 默认导出 `{ panels: { <id>: { mount(ctx) } } }`,
用 esbuild 打成 `dist/console.js`(+ `.css`),路径写进 manifest;浏览器侧对 `cortico/*` 只能
`import type`。面板契约在 `src/web/shared/client-panel.ts`。

配置段归包:`worlds.<id>` 的形状由 `defaults()` 定,bot 侧只在 `declares` 里写 id;
部署 `config.json` 的同名段压过默认值。

## 写一个 provider 扩展

`"kind": "provider"`,关键字 `cortico-provider`,默认导出 `ProviderModule`(见
[providers.md](providers.md))。控制台页 id 是 `llm:<id>`,面板与 World 扩展同一套契约。

## 写一个 bot 扩展

`"kind": "bot"`,关键字 `cortico-bot`,默认导出 `BotDefinition`(见 [personas.md](personas.md)):
与仓内 `bots/<名>/` 是同一种东西,只是装在 `extensions/` 下。入口可以直接发 TS 源
(`"main": "./index.ts"`),框架经 tsx 跑它。

一份部署用它:`deployment.json` 的 `bot` 字段写包名。仓内 `bots/<同名>/` 存在时仓内赢。
一个进程只跑一个 bot,所以装了好几个 bot 包也只 import 被引用的那一个,其余在扩展页上标
「已装,本部署未用」。bot 的 `id` 不得与仓内 `bots/` 任一目录同名:控制台面板产物按
`persona:<id>` 找,撞名会拿到仓内那份。

包目录只读。`promptDocs` 里没给 `deploymentPath` 的模板在控制台里能看不能存;要让部署者改,
在声明里给出部署侧的覆盖路径(通常在 `loaded.rootDir` 下)。bot 要挂的 World 若也是扩展,
在 `declares` 里声明 id 即可,没装时是灰卡。

## 校验

```bash
pnpm check:extension <包目录>
```

不启动任何东西:读 manifest、import 入口、按 kind 核对默认导出形状、确认面板产物在,再干装载——
World 在假部署(默认配置、无密钥)下 `create()`,跑 `tools()`、`envPromptVars()`、`console()`,对照
Core 保留名与内建 World 的工具名;provider 按假端点条目 `create()`;bot 按假部署 `build()`。
装配层启动时对每个 World 定义都调 `create()`,不管启没启用,所以默认配置下构造不出来就是失败。
通过就能装。

## 契约版本

`cortico.api` 必须等于框架的 `EXTENSION_API_VERSION`(现在是 3)。`WorldDefinition`、
`ProviderModule`、`BotDefinition`(连同 `BotParts`、`Persona`、`LoadedConfig`)或
`ConsolePanelContext` 任一不兼容变更时框架把它加一,旧扩展在扩展页上标「需要升级」而不是
静默装上。它与控制台协议版本无关。

## 现成的

- `cortico-world-vtuber`:Live2D VTuber 演出(VTube Studio、流式 TTS、强制对齐、字幕 overlay)。
- `cortico-world-asr`:麦克风语音识别(RtAudio 采集、能量门限切分、FireRedASR2-AED 后端)。
- `cortico-provider-grok`:xAI Grok 端点与设备码授权。

三个都在仓库之外,是它们各自机器上的二进制运行时依赖(声卡原生模块、Python 推理环境、VTS)
不进这个仓库的原因。
