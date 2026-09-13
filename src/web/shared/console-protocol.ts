/**
 * Console Page Protocol —— 控制台与"贡献控制台表面的那一方"之间的唯一契约。
 *
 * **一个贡献方 = 控制台导航上的一页(page)。** 这个词是刻意选的:仓库里 `Provider`
 * 曾同时指 LLM 供应端点(`LLMProviderEntry`)和这里的控制台数据面,两个毫不相干的
 * 东西共用一个名字。现在 `Provider` 只留给前者;控制台这一侧一律叫 page。
 * LLM 端点仍是**其中一类** page(`llm:<模块>`),与 `world:` / `persona:` 并列。
 *
 * 这份文件是**边界权威**。归属判据只有一句:凡是需要知道"这个 bot 是怎样的"
 * 才成立的表面,都不属于框架。可机械执行的问法是「明天出现 world-discord /
 * Persona-X,这段代码要改吗」——要改就不属于 Web Core。两条硬规则：
 *
 * 1. **不出现任何具体一页的名字。** 没有 World 名、没有 bot 名,连举例也不用——
 *    本文件里的示例一律是占位名(world:chat / persona:demo)。协议只认识 page /
 *    panel / badge / config / prompt / storage / link / invoke / asset 这几个词。
 *    为某一个现有页添加专用概念 = 协议失败。这条规则由
 *    tests/web/architecture.test.ts 的 Guard B 常驻执行。
 * 2. **不引入宿主依赖。** 本文件同时被 Node 服务端与浏览器端 import，所以既不碰
 *    DOM 也不碰 node:*。类型 import 仅限 `src/core/` 的纯结构类型。
 *
 * 声明侧（`ConsolePageContribution`）与线上侧（`ConsoleManifest`）**故意不是
 * 同一组类型**：声明侧带本地绝对路径与可执行的 `invoke`，这两样都不能上线。
 *
 * 线上字段与 URL 里仍写着 `providers`：那是**线协议形状**，改动它要连同
 * `pnpm build:web` 一起走,不属于这次纯改名。
 */

import type { ConfigGroup, StoragePart } from '../../core/types.ts';

/** 线协议版本。前端拿到不认识的版本时拒绝渲染，而不是猜。 */
export const CONSOLE_PROTOCOL_VERSION = 1;

/**
 * 界面语言随每个请求走:HTTP 请求带这个头,WebSocket 握手带这个查询参数(浏览器的
 * WebSocket 构造器带不了头)。值是 `zh` / `en`;缺席或不认识时服务端用部署默认语言。
 */
export const CONSOLE_LANGUAGE_HEADER = 'x-cortico-language';
export const CONSOLE_LANGUAGE_QUERY = 'language';

/**
 * 一页的类别。
 *
 * - `worlds`      —— 一个 World 带来的控制面
 * - `llm`     —— 一个 LLM 供应模块带来的控制面(这里,也只有这里,`Provider` 指端点)
 * - `persona` —— bot / 人格侧带来的控制面（经 `ConsoleContribution.consolePages`）
 * - `framework` —— **保留**：框架自身的表面不走这套协议，它就是控制台本体。
 *   这个成员存在只是为了让"框架不是一页"这件事在类型上说得出口。
 */
export type ConsolePageKind = 'framework' | 'world' | 'persona' | 'llm';

/** 能真正贡献一页的类别（框架除外）。 */
export type ContributingKind = Exclude<ConsolePageKind, 'framework'>;

// ---------------------------------------------------------------------------
// 1. 命名空间规则
// ---------------------------------------------------------------------------

/**
 * Page ID 形如 `world:chat` / `persona:demo` / `llm:grok`。
 *
 * **Page ID 提供 namespace；Panel ID 只在一页内唯一。** 旧的全局扁平
 * panel id（`chat-gate` / `sensor-align` 这种把 World 名写进 id 里的做法）就此作废：
 * 它把"哪个 World 的"编进了字符串，于是中央前端必须持一张全局表才能路由。
 */
const PAGE_ID_RE = /^(world|persona|llm):[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Panel ID 只需在自己这一页内唯一，所以不带任何前缀。 */
const PANEL_ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export interface ParsedPageId {
  kind: ContributingKind;
  /** 冒号后的部分：`world:chat` → `chat` */
  name: string;
}

/** 合法则返回拆解结果，否则 null。调用方负责报错措辞。 */
export function parsePageId(id: string): ParsedPageId | null {
  if (!PAGE_ID_RE.test(id)) return null;
  const idx = id.indexOf(':');
  return { kind: id.slice(0, idx) as ContributingKind, name: id.slice(idx + 1) };
}

export function isPanelId(id: string): boolean {
  return PANEL_ID_RE.test(id);
}

/**
 * 内置面板名:控制台核心自带的那批面板实现,在内核里的键。
 *
 * 与 panel id 用的是不同的字符集(必须字母开头):它不是路由段也不是目录名,而是
 * 内核代码里的一个标识符,数字开头的键在那一侧没有意义。
 */
const BUILTIN_PANEL_RE = /^[a-z][a-z0-9-]*$/;

export function isBuiltinPanel(name: unknown): name is string {
  return typeof name === 'string' && BUILTIN_PANEL_RE.test(name);
}

/**
 * 由目录约定推出 page id —— 构建脚本与服务端注册表**必须**用同一个函数，
 * 否则两边各推一次就会悄悄漂移。
 *
 * ```
 * src/worlds/terminal/console/client.ts → world:terminal
 * bots/demo/console/client.ts    → persona:demo
 * ```
 */
export function pageIdFor(kind: ContributingKind, name: string): string {
  return `${kind}:${name}`;
}

// ---------------------------------------------------------------------------
// 2. Asset 安全模型
// ---------------------------------------------------------------------------

/**
 * **贡献方永远不提供路径。**
 *
 * 它只有一个 asset key，而这个 key 就是它自己的 page id——所以协议里根本没有
 * 一个字段可以让贡献方塞进 `../../foo.js`、`C:\foo.js`、`file://…` 或
 * `http://evil/…`。构建产物 `dist/web/asset-manifest.json` 是 key → URL 的唯一映射，
 * 服务端只答 manifest 里有的 key，其余一律当作"这一页没有扩展"。
 *
 * 这个函数是恒等映射。它存在的意义是把这条规则变成一处可 grep 的事实，而不是
 * 散落在注册表与构建脚本里的两句巧合。
 */
export function assetKeyForPage(pageId: string): string {
  return pageId;
}

/** 构建产物里一页的浏览器资源。值是 URL 路径，不是文件系统路径。 */
export interface ConsoleAssetEntry {
  js: string;
  css?: string;
}

export interface ConsoleAssetManifest {
  protocolVersion: typeof CONSOLE_PROTOCOL_VERSION;
  /** 内核入口；尚未构建时为 null */
  core: string | null;
  /** key = page id。字段名是线协议形状,与 `pnpm build:web` 的产物同步,故未改名。 */
  providers: Record<string, ConsoleAssetEntry>;
}

/** 静态资源 URL 的唯一合法前缀。服务端把它映射到 `dist/web/`。 */
export const CONSOLE_ASSET_PREFIX = '/assets/';

/**
 * 出网前的最后一道闸：即使 manifest 被人手改坏，也不放行能跳出 `/assets/` 的值。
 *
 * **用白名单字符集，不用黑名单。** 黑名单天然漏——先前的版本只挡字面 `..`，
 * 于是 `/assets/%2e%2e/%2e%2e/etc/passwd`、`/assets/..%2f..%2fx`、
 * `/assets/x\n.js`（换行进响应头就是头注入面）全都放行。构建产物的文件名由
 * 我们自己生成，字符集本来就窄，所以直接只认这个窄集：
 *
 * ```
 * 字母数字 . _ - /
 * ```
 *
 * `%` 不在集合里，编码回溯自然无从谈起；控制字符、反斜杠、协议、协议相对
 * 写法（`//host/x`）、查询串一并出局。查询串被拒是有意的——产物带内容 hash，
 * 不需要 cache-buster。
 */
const ASSET_URL_RE = /^\/assets\/[A-Za-z0-9._/-]+$/;

export function isSafeAssetUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !ASSET_URL_RE.test(url)) return false;
  if (url.includes('//')) return false;
  return !url.split('/').includes('..');
}

/**
 * `ConsoleLink.href` 的闸门。
 *
 * asset 那条路被堵得很干净，但 `links.href` 是**同一类**"贡献方给路径"的口子:
 * 控制台把它原样渲染成打开按钮,于是 `javascript:` 直通就是控制台里的 XSS——
 * 而 href 常常来自 World 配置(用户填的地址),不是纯代码常量。
 *
 * 分三类处理，判据是**会不会在控制台自己的页面源里执行脚本**：
 *
 * - 放行 `http:` / `https:` / 以单个 `/` 开头的同源相对路径。
 * - **永久拦截执行类协议**（见 `EXECUTING_SCHEMES`）。`javascript:` 在控制台自己的
 *   源里跑，而控制台没有身份认证、能回滚人格、能清空存储——拿到脚本执行等于拿到全部。
 * - 其余自定义应用协议（`vscode:` / `obs:` 这类）放行：浏览器不执行它们，而是把 URL
 *   交给操作系统去拉起本地程序。风险跑到浏览器外面去了，由部署环境自己管。
 *
 * 协议相对写法（`//host`）按同源相对路径解释会跑到外站，拒。
 */
const EXECUTING_SCHEMES = new Set([
  'javascript:', 'data:', 'vbscript:', 'blob:', 'filesystem:',
]);

/** 控制字符(含换行/回车/制表)。用码点构造,免得源码里真嵌进控制字符。 */
const CONTROL_CHARS_RE = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`);

export function isSafeLinkHref(href: unknown): href is string {
  if (typeof href !== 'string' || href === '') return false;
  // 控制字符(含换行)一律拒:它们只在注入场景里出现
  if (CONTROL_CHARS_RE.test(href)) return false;
  if (href.startsWith('//')) return false;
  if (href.startsWith('/')) return true;
  try {
    return !EXECUTING_SCHEMES.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 3. 声明侧：贡献方交给框架的东西
// ---------------------------------------------------------------------------

/** 状态徽标。控制台原样显示，不解释语义。 */
export interface ConsoleBadge {
  label: string;
  value: string | number;
  tone?: 'on' | 'off' | 'plain';
}

/**
 * 一条链路的状态灯。四态，贡献方自报；控制台只按 `state` 上色，不从徽标反推。
 *
 * 与 `src/core/types.ts` 的 `WorldLamp` **同形**（那边写着四态各自的判据）。
 * 两边各写一份的理由与 `WorldStreamSocket` 相同：这份文件被浏览器 import，
 * 不能反向依赖 core。
 */
export interface ConsoleLamp {
  /** 这是哪条链路。导航上没有它的位置，只进悬停说明。 */
  label: string;
  state: 'online' | 'loading' | 'error' | 'offline';
  /** 悬停时的一句细节。不占版面，只进 title。 */
  hint?: string;
}

const LAMP_STATES: readonly ConsoleLamp['state'][] = ['online', 'loading', 'error', 'offline'];

/**
 * 一页最多点几颗灯。与 `src/core/types.ts` 的 `MODULE_LAMP_MAX` 同值——
 * 数是版面给的（左栏一行放得下这么多颗 6px 的点），所以由渲染这一侧定。
 */
export const LAMP_MAX = 7;

/**
 * 上线前的灯消毒：`state` 不是那四个字面量之一、或没有 `label`，这一颗丢掉；
 * 超过 `LAMP_MAX` 的截掉。
 *
 * 前端拿 `state` 拼 CSS class，所以一个写歪的值（`'green'`、`'ok'`）会渲染成一颗
 * 永远不亮的灰灯——那比没有灯更糟：它看起来在报"这条链路关着"。宁可不画。
 * `label` 是那颗点唯一的自我说明（导航上只有悬停能读到它），没有就等于一颗
 * 说不出自己是谁的灯。
 */
export function sanitizeLamps(value: unknown): ConsoleLamp[] {
  if (!Array.isArray(value)) return [];
  const out: ConsoleLamp[] = [];
  for (const raw of value) {
    if (out.length >= LAMP_MAX) break;
    const lamp = raw as ConsoleLamp | null;
    if (!lamp || !LAMP_STATES.includes(lamp.state)) continue;
    if (typeof lamp.label !== 'string' || lamp.label === '') continue;
    const one: ConsoleLamp = { label: lamp.label, state: lamp.state };
    if (typeof lamp.hint === 'string' && lamp.hint !== '') one.hint = lamp.hint;
    out.push(one);
  }
  return out;
}

/** 贡献方自带的独立页面入口。控制台不解析路径语义；主题交接只在显式请求时发生。 */
export interface ConsoleLink {
  label: string;
  href: string;
  /** 打开时把控制台当前的已解析主题作为一次性快照放进 URL fragment。 */
  inheritTheme?: boolean;
}

/**
 * 一个专用面板的声明。
 *
 * **声明了 panel 就意味着有一份浏览器实现**——默认是这一页自己的扩展。声明式的
 * 东西（badge / config / prompt / storage / link）不是 panel，它们由控制台通用
 * 渲染，贡献方不必写一行浏览器代码。
 *
 * 判据：简单配置走 JSON Schema；复杂 UI 直接写 TS 扩展，
 * **不为它发明 JSON DSL**。
 */
export interface ConsolePanelDecl {
  /** 一页内唯一，`[a-z0-9-]`。 */
  id: string;
  title: string;
  /** 一句话说明，控制台可显示在标题旁 */
  description?: string;
  /** 允许经 HTTP GET 调用的方法；该声明只留在服务端，不进入 manifest。 */
  getMethods?: readonly string[];
  /**
   * 这块面板的实现由控制台核心提供，值是它在内核那张内置表里的名字。
   *
   * 一页的面板全是内置时，这一页不需要浏览器产物。装在仓库外的贡献方（外部
   * npm 包）拿不到框架的浏览器代码，通用面板只能走这条路。
   */
  builtin?: string;
}

/**
 * 一页自有的固定提示词源文件。`path` 是**本地绝对路径**，因此这个类型
 * 只存在于声明侧——读文件、算 revision、原子写回都由框架代办，路径不上线。
 */
export interface ConsolePromptDocDecl {
  /** 全局唯一，惯例 `worlds.<World>.<名>` / `core.<名>` */
  key: string;
  title: string;
  description: string;
  path: string;
}

/**
 * 一页交给框架的完整贡献。
 *
 * 每次组装 manifest 时重新取一遍（`badges` 是活数据），所以字段是值不是 thunk——
 * 与既有的 `World.console()` 同一个用法。
 */
export interface ConsolePageContribution {
  /** `world:chat` / `persona:demo`；`parsePageId` 校验 */
  id: string;
  kind: ContributingKind;
  /** 人类可读名，导航与卡片上显示 */
  label: string;

  /** 状态灯，一条链路一颗。不报 = 控制台不画灯（框架不替贡献方猜自己的状态）。 */
  lamps?: ConsoleLamp[];
  badges?: ConsoleBadge[];
  panels?: ConsolePanelDecl[];
  links?: ConsoleLink[];

  /** 按 JSON Schema 声明的可调项，控制台通用渲染 */
  config?: ConfigGroup[];
  /** 可编辑的固定提示词源文件 */
  promptDocs?: ConsolePromptDocDecl[];
  /** 这一页自己攒下的、可清除的存储 */
  storage?: StoragePart[];

  /**
   * 面板数据面。控制台只把 HTTP 请求翻译成一次 `(panel, method, args)` 调用——
   * 语义、参数校验、结果形状全归这一页。返回 `{ $binary: { mime, base64 } }`
   * 时按二进制响应（音频试听这类）。不声明 = 这一页的面板没有数据面。
   */
  invoke?(panel: string, method: string, args: unknown[]): Promise<unknown>;

  /**
   * 按 panel 分派的推送通道，消息语义归这一页；未声明此通道时拒绝对应 WS 握手。
   * 每条 socket 连接调用一次 stream()，同一面板的 N 条连接产生 N 次独立调用；框架不广播、不去重、不保证单实例。
   * 重连发起全新调用，不携带续播游标或重放断连期间的帧。当前协议无背压信号和二进制帧，onClose 不提供关闭原因。
   */
  stream?(panel: string, socket: ConsoleStream): void;

  /**
   * 装配态。框架对所有页一视同仁地报这三态；不适用的（persona 页）
   * 恒为 `active`。
   */
  availability?: ConsolePageAvailability;
  /** Persona定义的渠道（true），还是部署侧选配的外挂（false/缺省） */
  declared?: boolean;
  /** `missing` 时的原因，原样显示 */
  reason?: string;
  /** 当前对 agent 可见。不适用的页省略。 */
  agentVisible?: boolean;
  /** 可见性已改但 system 前缀还是旧的。不适用的页省略。 */
  prefixDrifted?: boolean;
}

/**
 * - `active`   已装配并运行
 * - `inactive` 本地有实现但这次没载入（面板仍可露出，比如激活前的接入配置）
 * - `missing`  Persona定义了、本地没有实现
 */
export type ConsolePageAvailability = 'active' | 'inactive' | 'missing';

/** 运行期校验用的取值表。 */
const AVAILABILITY: readonly ConsolePageAvailability[] = ['active', 'inactive', 'missing'];

/**
 * 一条已建立的流式连接，交给贡献方用。
 *
 * **故意不是 `ws.WebSocket`**：这份协议既被服务端也被浏览器 import，不能引宿主依赖；
 * 而且把贡献方与某个具体 WS 实现解耦之后，跑在子进程里的贡献方也能实现它
 * （高频与长阻塞的 World 本来就隔离成子进程）。服务端负责把真
 * socket 包成这个形状。
 */
export interface ConsoleStream {
  /** 推一帧。连接已关时静默丢弃，不抛。 */
  send(data: string): void;
  /** 主动关闭。`reason` 原样带给对端。 */
  close(reason?: string): void;
  /** 对端来的帧。 */
  onMessage(cb: (text: string) => void): void;
  /** 连接结束（对端关、网络断、面板 unmount 都会到这里）。 */
  onClose(cb: () => void): void;
  /** 连接是否还活着。 */
  readonly open: boolean;
}

/** 二进制返回的约定形状。 */
export interface ConsoleBinaryResult {
  $binary: { mime: string; base64: string };
}

/** 服务端内部的流式文件返回；路径不会写入 JSON 响应。 */
export interface ConsoleFileResult {
  $file: { mime: string; path: string; bytes: number; sha256: string };
}

export function isBinaryResult(v: unknown): v is ConsoleBinaryResult {
  const bin = (v as ConsoleBinaryResult | null)?.$binary;
  return !!bin && typeof bin.base64 === 'string';
}

export function isFileResult(v: unknown): v is ConsoleFileResult {
  const file = (v as ConsoleFileResult | null)?.$file;
  return !!file
    && typeof file.mime === 'string'
    && typeof file.path === 'string'
    && Number.isSafeInteger(file.bytes)
    && file.bytes >= 0
    && typeof file.sha256 === 'string'
    && /^[0-9a-f]{64}$/.test(file.sha256);
}

// ---------------------------------------------------------------------------
// 4. 线上侧：Manifest DTO
// ---------------------------------------------------------------------------

export interface ConsolePanelManifest {
  id: string;
  title: string;
  description?: string;
  /** 由内核那张内置表提供实现；缺省则去取这一页自己的扩展。 */
  builtin?: string;
}

/** 可安全上线的前缀源索引；本地路径与正文仍只走 `/api/prompts`。 */
export interface ConsolePromptManifest {
  key: string;
  title: string;
  description: string;
}

export interface ConsolePageManifest {
  id: string;
  kind: ContributingKind;
  label: string;
  availability: ConsolePageAvailability;

  lamps?: ConsoleLamp[];
  badges?: ConsoleBadge[];
  panels?: ConsolePanelManifest[];
  prompts?: ConsolePromptManifest[];
  /**
   * 这一页通过 ConsolePageContribution.config 显式认领的配置组 id；schema 和值经 /api/config 提供。
   * 归属不从 owner 推断；未认领的组显示在框架设置页。
   */
  configGroups?: string[];
  links?: ConsoleLink[];

  declared?: boolean;
  reason?: string;
  agentVisible?: boolean;
  prefixDrifted?: boolean;

  /**
   * 浏览器扩展资源。**由服务端查构建产物解析得到，贡献方不提供路径**。
   * 缺省 = 这一页没有构建出扩展；此时它声明的**非内置** panel 会渲染成一张
   * "扩展未构建"的错误卡，而不是静默消失。内置面板不经过它。
   */
  client?: ConsoleAssetEntry;
}

export interface ConsoleManifest {
  protocolVersion: typeof CONSOLE_PROTOCOL_VERSION;
  /** 每一页一条。字段名是线协议形状,与自带前端的构建产物同步,故未改名。 */
  providers: ConsolePageManifest[];
  framework: {
    /** 框架级表面挂没挂。前端据此决定不渲染哪一块，不必拿 503 当信号。 */
    capabilities: Record<string, boolean>;
  };
}

// ---------------------------------------------------------------------------
// 5. 路由
// ---------------------------------------------------------------------------

/** Manifest 端点。 */
export const CONSOLE_MANIFEST_ROUTE = '/api/console/manifest';

/**
 * 状态灯端点：`{ lamps: { '<page id>': ConsoleLamp[] } }`，只报灯。
 *
 * 灯本来就在 manifest 里（首屏那一帧靠它），这条端点存在的理由是**刷新频率**：
 * 灯要跟得上"引擎起来了没"，而 manifest 带着每一页的面板、前缀源索引与
 * 配置组归属，秒级重取一份是拿几十 KB 换四个字节的状态。
 */
export const CONSOLE_LAMPS_ROUTE = '/api/console/lamps';

/** `CONSOLE_LAMPS_ROUTE` 的响应体：page id → 它那排灯。 */
export interface ConsoleLampsResponse {
  lamps: Record<string, ConsoleLamp[]>;
}

/**
 * Panel RPC 路径。page id 含冒号，调用方**必须** `encodeURIComponent`。
 * GET 用于轮询读与 `<audio src>` 这类只能带 URL 的场合（args 经 query 传 JSON 数组）；
 * POST 用于带参调用。
 *
 * 路径里的 `providers` 段是**线协议形状**,与自带前端的构建产物同步,故未随类型改名。
 */
export function panelRoute(pageId: string, panelId: string, method: string): string {
  return `/api/console/providers/${encodeURIComponent(pageId)}`
    + `/panels/${encodeURIComponent(panelId)}`
    + `/${encodeURIComponent(method)}`;
}

/**
 * 流式通道的 WS 路径。与 `panelRoute` 同构:page + panel 定位,
 * 之后的语义全归那一页。
 */
export function panelStreamRoute(pageId: string, panelId: string): string {
  return `/ws/providers/${encodeURIComponent(pageId)}/panels/${encodeURIComponent(panelId)}`;
}

// ---------------------------------------------------------------------------
// 6. 校验
// ---------------------------------------------------------------------------

export interface ContributionProblem {
  pageId: string;
  message: string;
}

/**
 * 校验一批贡献，返回**所有**问题（不是遇到第一个就停）——注册表要能一次告诉
 * 部署者他装的东西哪儿不对。校验只看协议规则，不看语义。
 */
export function validateContributions(
  contributions: readonly ConsolePageContribution[],
): ContributionProblem[] {
  const problems: ContributionProblem[] = [];
  const seenPage = new Set<string>();

  for (const c of contributions) {
    const parsed = parsePageId(c.id);
    if (!parsed) {
      problems.push({
        pageId: c.id,
        message: `provider id 不合法「${c.id}」：应形如 world:chat / persona:demo（小写字母数字与连字符）`,
      });
      continue;
    }
    if (parsed.kind !== c.kind) {
      problems.push({
        pageId: c.id,
        message: `provider id 的前缀是 ${parsed.kind}，但 kind 声明为 ${c.kind}`,
      });
    }
    if (seenPage.has(c.id)) {
      problems.push({ pageId: c.id, message: `provider id 重复：${c.id}` });
      continue;
    }
    seenPage.add(c.id);

    if (!c.label) {
      problems.push({ pageId: c.id, message: 'label 不能为空' });
    }

    // 类型只在 TS 侧管用。JS 侧的贡献方、或来自 JSON 配置的值,能塞任意字符串
    // 给前端,所以运行期也要查一次。
    if (c.availability !== undefined && !AVAILABILITY.includes(c.availability)) {
      problems.push({
        pageId: c.id,
        message: `availability 不合法「${String(c.availability)}」：只能是 ${AVAILABILITY.join(' / ')}`,
      });
    }

    const seenPanel = new Set<string>();
    for (const p of c.panels ?? []) {
      if (!isPanelId(p.id)) {
        problems.push({
          pageId: c.id,
          message: `panel id 不合法「${p.id}」：只允许小写字母数字与连字符，且不带 provider 前缀`,
        });
        continue;
      }
      if (seenPanel.has(p.id)) {
        problems.push({ pageId: c.id, message: `panel id 在本 provider 内重复：${p.id}` });
        continue;
      }
      seenPanel.add(p.id);
      if (!p.title) {
        problems.push({ pageId: c.id, message: `panel「${p.id}」缺 title` });
      }
    }
  }
  return problems;
}

/**
 * 把声明侧的贡献投影成线上侧的 manifest 条目。
 *
 * 这个函数是**唯一**的降维口子：`invoke`、`promptDocs.path`、`config.schema`、
 * `storage` 都在这里被挡下。前缀源只上线 key、标题与说明，配置组只上线 id
 * （归属信息，用来决定这组旋钮画在哪一页），正文与 schema 仍从专用端点读取。
 * 新增字段时先问一句"它上线安全吗"，再决定加不加到这里。
 *
 * 它同时是 `links` 与 `panels.builtin` 的消毒点：不安全的 href（`isSafeLinkHref`）
 * 与写歪的内置面板名（`isBuiltinPanel`）在这里连同它所在的那一项被丢掉。
 * 放在这里而不是 `validateContributions` 里，是因为**一处写错不该让整页
 * 下线**——注册表丢一整页是给结构性错误准备的。调用方应当比对
 * 前后条数并记一条日志，让被丢掉的项可见。
 *
 * 数组一律浅拷一层：manifest 与声明侧共享引用的话，消费方一改就污染贡献方
 * 内部状态，而 `badges` 是每次重取的活数据。
 */
export function toPageManifest(
  c: ConsolePageContribution,
  client?: ConsoleAssetEntry,
): ConsolePageManifest {
  const out: ConsolePageManifest = {
    id: c.id,
    kind: c.kind,
    label: c.label,
    availability: c.availability ?? 'active',
  };
  const lamps = sanitizeLamps(c.lamps);
  if (lamps.length) out.lamps = lamps;
  if (c.badges?.length) out.badges = c.badges.map((b) => ({ ...b }));
  if (c.panels?.length) {
    const panels = c.panels
      .filter((p) => p.builtin === undefined || isBuiltinPanel(p.builtin))
      .map((p) => {
        const panel: ConsolePanelManifest = { id: p.id, title: p.title };
        if (p.description) panel.description = p.description;
        if (p.builtin !== undefined) panel.builtin = p.builtin;
        return panel;
      });
    if (panels.length) out.panels = panels;
  }
  // 只上 id:归属够用了,schema 与当前值仍只走 /api/config。
  if (c.config?.length) out.configGroups = c.config.map((g) => g.id);
  if (c.promptDocs?.length) {
    out.prompts = c.promptDocs.map((doc) => ({
      key: doc.key,
      title: doc.title,
      description: doc.description,
    }));
  }
  const links = (c.links ?? [])
    .filter((l) => isSafeLinkHref(l?.href))
    .map((l) => ({
      label: l.label,
      href: l.href,
      ...(l.inheritTheme === true ? { inheritTheme: true } : {}),
    }));
  if (links.length) out.links = links;
  if (c.declared !== undefined) out.declared = c.declared;
  if (c.reason) out.reason = c.reason;
  if (c.agentVisible !== undefined) out.agentVisible = c.agentVisible;
  if (c.prefixDrifted !== undefined) out.prefixDrifted = c.prefixDrifted;
  if (client) out.client = client;
  return out;
}
