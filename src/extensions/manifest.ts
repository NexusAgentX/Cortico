/**
 * 扩展 manifest —— 一个 npm 包的 package.json 里那块 `cortico`。
 *
 * 三类扩展(World、LLM provider、bot 包)共用**一份**声明,靠 `kind` 判别;三类真正的分叉
 * (默认导出的形状校验、注入点、id 命名空间、控制台页前缀)都在加载器里按 kind 选路,
 * 不在这里。字段几乎一样却拆成几套 schema,只会让第三方作者和我们各维护一份。
 *
 *   {
 *     "name": "cortico-world-vtuber",
 *     "type": "module",
 *     "keywords": ["cortico-world"],
 *     "cortico": {
 *       "kind": "world",
 *       "api": 1,
 *       "consoleClient": "dist/console.js",
 *       "consoleStyle": "dist/console.css"
 *     }
 *   }
 *
 * - `kind`:`world`、`provider` 或 `bot`,必填。没有 `cortico` 块的包直接拒载并写明原因——
 *   不再靠鸭子类型猜默认导出是什么。
 * - `api`:扩展契约版本,一个整数。`WorldDefinition` / `ProviderModule` / `BotDefinition`
 *   (连同它可达的 `BotParts`、`Persona`、`LoadedConfig`)/ `ConsolePanelContext` 任一
 *   不兼容变更就把 {@link EXTENSION_API_VERSION} 加一;不合的
 *   扩展不加载,扩展页说明哪一边旧。它**不是** `CONSOLE_PROTOCOL_VERSION`:那个守的是
 *   本仓库源码与 dist 产物的错位,给第三方两个版本号只会添乱。
 * - `consoleClient` / `consoleStyle`:预构建好的浏览器端产物,包内相对路径。服务端
 *   自己分配 URL(`/assets/extensions/<包>/<版本>/<文件名>`),扩展给不出路径——asset 的
 *   安全边界与仓库内的页一致。
 * - `"type": "module"` 是硬要求:CommonJS 包经 require 会拿到框架源码的**另一份副本**,
 *   `instanceof` 与模块级状态(日志锚点、注册表)全部失效。
 *
 * 这份文件只做解析与校验,不碰文件系统;加载器与 `pnpm check:extension` 共用它。
 */

/** 扩展契约版本。见文件顶注何时加一。 */
export const EXTENSION_API_VERSION = 3;

export type ExtensionKind = 'world' | 'provider' | 'bot';
export const EXTENSION_KINDS: readonly ExtensionKind[] = ['world', 'provider', 'bot'];

/** npm 上按类发现用的关键字。 */
export const EXTENSION_KEYWORDS: Readonly<Record<ExtensionKind, string>> = {
  world: 'cortico-world',
  provider: 'cortico-provider',
  bot: 'cortico-bot',
};

/**
 * 扩展在运行时 import 框架用的包名前缀:`cortico/world.ts`、`cortico/core/util.ts`…
 * 路径就是 `src/` 下的相对路径。解析由 `./runtime.ts` 注册的模块钩子完成;将来框架
 * 发布到 npm 后,同一个写法由 package.json 的 `exports` 接管,扩展一行不改。
 */
export const FRAMEWORK_SPECIFIER = 'cortico';

export interface ExtensionManifest {
  kind: ExtensionKind;
  api: number;
  /** 包内相对路径,`.js` / `.mjs`。 */
  consoleClient?: string;
  /** 包内相对路径,`.css`。要有 `consoleClient` 才有意义。 */
  consoleStyle?: string;
}

/** package.json 里我们会看的字段。 */
export interface ExtensionPackageJson {
  name?: string;
  version?: string;
  description?: string;
  type?: string;
  main?: string;
  module?: string;
  exports?: unknown;
  keywords?: string[];
  dependencies?: Record<string, string>;
  cortico?: unknown;
}

export type ExtensionManifestResult =
  | { ok: true; manifest: ExtensionManifest; warnings: string[] }
  | { ok: false; reasons: string[]; warnings: string[] };

/**
 * 包内相对文件路径:不绝对、不带盘符、不含 `..` 段、不以分隔符开头。
 * 反斜杠不收——package.json 是跨平台发布的,写法只认 `/`。
 */
export function isSafeRelativeFile(p: unknown): p is string {
  if (typeof p !== 'string' || p === '') return false;
  if (p.includes('\\') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  return !p.split('/').some((seg) => seg === '..' || seg === '');
}

export function parseExtensionManifest(pkg: ExtensionPackageJson): ExtensionManifestResult {
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (pkg.type !== 'module') {
    reasons.push('package.json 需要 "type": "module":CommonJS 包会拿到框架源码的另一份副本,instanceof 与模块级状态全部失效。');
  }

  const block = pkg.cortico;
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    reasons.push('package.json 缺少 cortico 块(至少要 kind 与 api)。');
    return { ok: false, reasons, warnings };
  }
  const m = block as Record<string, unknown>;

  const kind = m.kind;
  const kindOk = typeof kind === 'string' && (EXTENSION_KINDS as readonly string[]).includes(kind);
  if (!kindOk) {
    reasons.push(`cortico.kind 必须是 ${EXTENSION_KINDS.map((k) => `"${k}"`).join(' 或 ')},现在是 ${JSON.stringify(kind)}。`);
  }

  const api = m.api;
  if (typeof api !== 'number' || !Number.isInteger(api) || api < 1) {
    reasons.push(`cortico.api 必须是正整数(当前框架契约 v${EXTENSION_API_VERSION}),现在是 ${JSON.stringify(api)}。`);
  } else if (api < EXTENSION_API_VERSION) {
    reasons.push(`扩展按契约 v${api} 编写,本框架是 v${EXTENSION_API_VERSION}:扩展需要升级。`);
  } else if (api > EXTENSION_API_VERSION) {
    reasons.push(`扩展要求契约 v${api},本框架只到 v${EXTENSION_API_VERSION}:框架需要升级。`);
  }

  const client = m.consoleClient;
  if (client !== undefined) {
    if (!isSafeRelativeFile(client)) {
      reasons.push(`cortico.consoleClient 必须是包内相对路径(不含 ..、不以 / 开头、只用 /),现在是 ${JSON.stringify(client)}。`);
    } else if (!/\.m?js$/.test(client)) {
      reasons.push('cortico.consoleClient 必须指向预构建好的 .js / .mjs;浏览器不跑 TypeScript。');
    }
  }
  const style = m.consoleStyle;
  if (style !== undefined) {
    if (client === undefined) {
      reasons.push('cortico.consoleStyle 要与 consoleClient 一起给:样式随面板 bundle 注入。');
    } else if (!isSafeRelativeFile(style)) {
      reasons.push(`cortico.consoleStyle 必须是包内相对路径,现在是 ${JSON.stringify(style)}。`);
    } else if (!/\.css$/.test(style)) {
      reasons.push('cortico.consoleStyle 必须指向 .css。');
    }
  }

  if (kindOk) {
    const keyword = EXTENSION_KEYWORDS[kind as ExtensionKind];
    if (!(pkg.keywords ?? []).includes(keyword)) {
      warnings.push(`keywords 里没有 "${keyword}":发布到 npm 后控制台的搜索找不到它(本地安装不受影响)。`);
    }
  }

  if (reasons.length) return { ok: false, reasons, warnings };
  return {
    ok: true,
    warnings,
    manifest: {
      kind: kind as ExtensionKind,
      api: api as number,
      ...(typeof client === 'string' ? { consoleClient: client } : {}),
      ...(typeof style === 'string' ? { consoleStyle: style } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// 浏览器端产物:服务端分配 URL
// ---------------------------------------------------------------------------

/**
 * 一个已加载扩展的浏览器端产物。`pageId` 就是 asset key(`world:<id>` / `llm:<id>` / `persona:<id>`),
 * 控制台按它找到文件;`version` 进 URL,换版本即换 URL,绕开浏览器 module map 里
 * 对旧地址的死记录。文件路径是绝对路径,服务端只发这两个文件,不挂整个目录。
 */
export interface ExtensionConsoleAsset {
  pageId: string;
  packageName: string;
  version: string;
  jsFile: string;
  cssFile?: string;
}

/** 进 URL 的一段:只留 `isSafeAssetUrl` 放行的字符,其余(`@` `/` `+` `~`…)换成 `-` / `__`。 */
export function extensionAssetSegment(raw: string): string {
  return raw.replace(/^@/, '').replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '-');
}

export const EXTENSION_ASSET_PREFIX = '/assets/extensions/';

/** `/assets/extensions/<包>/<版本>/<文件名>`。 */
export function extensionAssetUrl(packageName: string, version: string, fileName: string): string {
  return `${EXTENSION_ASSET_PREFIX}${extensionAssetSegment(packageName)}/${extensionAssetSegment(version)}/${extensionAssetSegment(fileName)}`;
}
