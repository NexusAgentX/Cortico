/**
 * Console Page Registry —— 服务端把"各方贡献的控制台表面"收成一份 manifest 的地方。
 *
 * 一个贡献方 = 控制台导航上的一页(page)。`Provider` 一词只留给 LLM 供应端点,
 * 见 `shared/console-protocol.ts` 顶注。
 *
 * 这是中央聚合边界，但**它不认识任何具体的一页**：收什么、叫什么、有几个，
 * 全由装配层（`src/bot.ts`）决定并以 `ConsolePageSource` 的形式交进来。
 * 本文件里不允许出现任何 World id 分支——出现了就说明中央知识又长回来了。
 *
 * 三件职责：
 * 1. 收集与隔离：逐个 source 取贡献，**一个炸了不影响其余**。
 * 2. 校验：id 命名空间、panel 唯一性；有问题的一页整个丢掉并记日志，
 *    而不是让半个坏 manifest 上线。
 * 3. 解析：panel 调用面 → 那一页的 `invoke`、panel 流式面 → 那一页的 `stream`；
 *    asset key → 构建产物 URL。
 */

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Logger } from '../core/types.ts';
import { extensionAssetUrl, type ExtensionConsoleAsset } from '../extensions/manifest.ts';
import {
  CONSOLE_PROTOCOL_VERSION,
  assetKeyForPage,
  isSafeAssetUrl,
  sanitizeLamps,
  toPageManifest,
  validateContributions,
  type ConsoleAssetEntry,
  type ConsoleAssetManifest,
  type ConsoleLamp,
  type ConsoleManifest,
  type ConsolePageContribution,
  type ConsoleStream,
} from './shared/console-protocol.ts';

/**
 * 一页的来源。装配层为每个 World / 每个 bot 的控制面造一个。
 *
 * `contribute()` 每次组装 manifest 都会被调用（`badges` 是活数据），所以它应当
 * 便宜。返回 null = 这一轮不露面（比如 World 临时不可用）。
 */
export interface ConsolePageSource {
  /** 仅用于出错时说清"是谁炸了"；正式 id 以 `contribute()` 返回的为准 */
  id: string;
  contribute():
    | ConsolePageContribution
    | null
    | Promise<ConsolePageContribution | null>;
}

/**
 * 一页的浏览器资源表。两个来源:仓库自带的页来自 `dist/web/asset-manifest.json`,
 * 扩展带来的页来自它自己包里的预构建产物。同一个 key 撞上时**仓库内的页赢**——
 * 扩展换不掉自带面板。
 *
 * **这是 asset 安全模型的执行点。** 一页只有一个 key（就是它的 id），两个来源的
 * URL 都要过 `isSafeAssetUrl`:dist 的 manifest 被人手改坏、扩展的包名或版本号带上
 * 奇怪字符,都放不出能跳出 `/assets/` 的路径。扩展那一侧的 URL 由服务端按
 * `extensionAssetUrl` 分配,扩展自己给不出路径。
 */
export class ConsoleAssets {
  private readonly distDir: string;
  private readonly log: Logger;
  private manifest: ConsoleAssetManifest = {
    protocolVersion: CONSOLE_PROTOCOL_VERSION,
    core: null,
    providers: {},
  };
  /** 扩展产物表。加载完就定死,`reload()` 只重读 dist。 */
  private readonly extensionPages: Record<string, ConsoleAssetEntry>;

  constructor(distDir: string, log: Logger, extensionAssets: readonly ExtensionConsoleAsset[] = []) {
    this.distDir = distDir;
    this.log = log;
    this.extensionPages = this.indexExtensionAssets(extensionAssets);
    this.reload();
  }

  private indexExtensionAssets(assets: readonly ExtensionConsoleAsset[]): Record<string, ConsoleAssetEntry> {
    const out: Record<string, ConsoleAssetEntry> = Object.create(null) as Record<string, ConsoleAssetEntry>;
    for (const a of assets) {
      const js = extensionAssetUrl(a.packageName, a.version, basename(a.jsFile));
      if (!isSafeAssetUrl(js)) {
        this.log.error(`扩展产物被拒: ${a.packageName} 的 js 分配不出合法的 /assets/ 路径`, { value: js });
        continue;
      }
      const entry: ConsoleAssetEntry = { js };
      if (a.cssFile !== undefined) {
        const css = extensionAssetUrl(a.packageName, a.version, basename(a.cssFile));
        if (isSafeAssetUrl(css)) {
          entry.css = css;
        } else {
          this.log.error(`扩展产物的 css 被拒: ${a.packageName}`, { value: css });
        }
      }
      out[assetKeyForPage(a.pageId)] = entry;
    }
    return out;
  }

  /** 重读构建产物。没构建过 = 空表，不是错误（控制台照常起，只是没有扩展）。 */
  reload(): void {
    const file = join(this.distDir, 'asset-manifest.json');
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      this.manifest = { protocolVersion: CONSOLE_PROTOCOL_VERSION, core: null, providers: {} };
      return;
    }
    let parsed: ConsoleAssetManifest;
    try {
      parsed = JSON.parse(raw) as ConsoleAssetManifest;
    } catch (err) {
      this.log.error('asset-manifest.json 解析失败,浏览器扩展全部不可用', { error: String(err) });
      this.manifest = { protocolVersion: CONSOLE_PROTOCOL_VERSION, core: null, providers: {} };
      return;
    }

    // 产物的协议版本要比对。旧协议的 dist 被静默当成当前产物,表现是一堆
    // "扩展加载失败"而看不出根因。
    if (parsed.protocolVersion !== CONSOLE_PROTOCOL_VERSION) {
      this.log.error(
        `asset-manifest.json 的协议版本是 ${String(parsed.protocolVersion)},`
        + `本进程认的是 ${CONSOLE_PROTOCOL_VERSION}——请重跑 pnpm build:web。扩展全部不加载。`,
      );
      this.manifest = { protocolVersion: CONSOLE_PROTOCOL_VERSION, core: null, providers: {} };
      return;
    }

    // 无原型对象:page id 虽然过了正则、够不着 `__proto__` 这类键,但查表本身
    // 不该有"继承来的答案"——那是一类不该存在的可能性,不是一道要靠上游拦的闸。
    const pages: Record<string, ConsoleAssetEntry> = Object.create(null) as Record<string, ConsoleAssetEntry>;
    for (const [key, entry] of Object.entries(parsed.providers ?? {})) {
      if (!isSafeAssetUrl(entry?.js)) {
        this.log.error(`asset 条目被拒: ${key} 的 js 不是合法的 /assets/ 路径`, {
          value: String(entry?.js),
        });
        continue;
      }
      const safe: ConsoleAssetEntry = { js: entry.js };
      if (entry.css !== undefined) {
        if (isSafeAssetUrl(entry.css)) {
          safe.css = entry.css;
        } else {
          this.log.error(`asset 条目的 css 被拒: ${key}`, { value: String(entry.css) });
        }
      }
      pages[key] = safe;
    }
    const core = isSafeAssetUrl(parsed.core) ? parsed.core : null;
    if (parsed.core && !core) {
      this.log.error('asset-manifest.json 的 core 不是合法的 /assets/ 路径,已忽略', {
        value: String(parsed.core),
      });
    }
    this.manifest = { protocolVersion: CONSOLE_PROTOCOL_VERSION, core, providers: pages };
  }

  /** 内核入口 URL；尚未构建时 null。 */
  core(): string | null {
    return this.manifest.core;
  }

  /**
   * 某一页的浏览器资源。**只按 key 查两张表**（dist 先、扩展后），查不到就是没有——
   * 不拼路径、不回退、不猜。
   */
  forPage(pageId: string): ConsoleAssetEntry | undefined {
    const key = assetKeyForPage(pageId);
    return this.manifest.providers[key] ?? this.extensionPages[key];
  }
}

export interface ConsolePageRegistryDeps {
  /** 当前全部页来源。每次取 manifest 都重新问一遍(World 会挂载/卸载)。 */
  sources(): ConsolePageSource[];
  /** 框架级表面的挂载情况，原样进 manifest.framework.capabilities */
  capabilities(): Record<string, boolean>;
  assets: ConsoleAssets;
  log: Logger;
}

/**
 * 面板解析失败的原因。`invoke` 与 `stream` 共用这三态:两条通道的解析路径
 * 一模一样(找那一页 → 查 panel 声明 → 看那个面在不在),失败语义自然也一样。
 * 服务端据此选 404/503,或选 WS 的关闭 code。
 */
export type InvokeFailure =
  | { kind: 'no-provider'; message: string }
  | { kind: 'no-panel'; message: string }
  | { kind: 'no-surface'; message: string }
  | { kind: 'method-not-allowed'; message: string };

export class ConsolePageRegistry {
  private readonly deps: ConsolePageRegistryDeps;

  constructor(deps: ConsolePageRegistryDeps) {
    this.deps = deps;
  }

  /**
   * 逐个 source 取贡献。**隔离在这里**：一个 source 抛错只丢它自己，
   * 其余照常进 manifest。
   */
  private async collect(): Promise<ConsolePageContribution[]> {
    const sources = this.safeSources();
    const out: ConsolePageContribution[] = [];
    for (const src of sources) {
      try {
        const c = await src.contribute();
        if (c) out.push(c);
      } catch (err) {
        this.deps.log.error(`provider 贡献失败,已跳过: ${src.id}`, { error: String(err) });
      }
    }
    return out;
  }

  private safeSources(): ConsolePageSource[] {
    try {
      return this.deps.sources() ?? [];
    } catch (err) {
      this.deps.log.error('provider 来源枚举失败', { error: String(err) });
      return [];
    }
  }

  /**
   * 组装 manifest。校验不通过的页**整个丢掉**并记一条日志——
   * 半页坏的上线，前端会以一种很难查的方式坏掉。
   */
  async manifest(): Promise<ConsoleManifest> {
    const collected = await this.collect();
    const problems = validateContributions(collected);
    const rejected = new Set<string>();
    for (const p of problems) {
      this.deps.log.error(`provider 声明不合法,已丢弃: ${p.message}`, { provider: p.pageId });
      rejected.add(p.pageId);
    }

    const pages = collected
      .filter((c) => !rejected.has(c.id))
      .map((c) => {
        const entry = toPageManifest(c, this.deps.assets.forPage(c.id));
        // toPageManifest 会丢掉不安全的 href(javascript: 一类)。丢一条就得
        // 说一声——静默消失的链接是最难查的那种"面板少了个按钮"。
        const dropped = (c.links?.length ?? 0) - (entry.links?.length ?? 0);
        if (dropped > 0) {
          this.deps.log.error(`provider ${c.id} 有 ${dropped} 条链接的 href 不安全,已丢弃`, {
            hrefs: (c.links ?? []).map((l) => String(l?.href)),
          });
        }
        // 面板同理:`builtin` 名写歪的那一块会被整块丢掉,不说一声就是"页上少了一格"。
        const droppedPanels = (c.panels?.length ?? 0) - (entry.panels?.length ?? 0);
        if (droppedPanels > 0) {
          this.deps.log.error(`provider ${c.id} 有 ${droppedPanels} 块面板的 builtin 名不合法,已丢弃`, {
            builtins: (c.panels ?? []).map((p) => String(p?.builtin)),
          });
        }
        return entry;
      });

    let capabilities: Record<string, boolean>;
    try {
      capabilities = this.deps.capabilities() ?? {};
    } catch (err) {
      this.deps.log.error('capabilities 计算失败', { error: String(err) });
      capabilities = {};
    }

    return {
      protocolVersion: CONSOLE_PROTOCOL_VERSION,
      providers: pages,
      framework: { capabilities },
    };
  }

  /**
   * 只取灯。与 `manifest()` 走同一批 source，但**不校验、不解析 asset、不投影面板**——
   * 这条路是给秒级轮询用的，跑的每一步都得对得起那个频率。
   *
   * 声明不合法的页在这里不会被丢掉（校验属于 manifest 那条路）：id 拼错的
   * 页本来就没有一行导航能挂灯，多报一颗没人读的灯不构成问题。
   */
  async lamps(): Promise<Record<string, ConsoleLamp[]>> {
    const out: Record<string, ConsoleLamp[]> = {};
    for (const c of await this.collect()) {
      const lamps = sanitizeLamps(c.lamps);
      if (lamps.length) out[c.id] = lamps;
    }
    return out;
  }

  /** 按 id 找当前的贡献。找不到返回 null。 */
  private async find(pageId: string): Promise<ConsolePageContribution | null> {
    for (const src of this.safeSources()) {
      let c: ConsolePageContribution | null;
      try {
        c = await src.contribute();
      } catch (err) {
        this.deps.log.error(`provider 贡献失败: ${src.id}`, { error: String(err) });
        continue;
      }
      if (c && c.id === pageId) return c;
    }
    return null;
  }

  /**
   * 定位一个面板：那一页在不在、这个 panel 声明过没有。到"那个面在不在"为止的
   * 判断两条通道共享；面本身由调用方各自取（`invoke` / `stream`）。
   */
  private async resolvePanel(
    pageId: string,
    panelId: string,
  ): Promise<
    | { ok: true; contribution: ConsolePageContribution; panel: NonNullable<ConsolePageContribution['panels']>[number] }
    | { ok: false; failure: InvokeFailure }
  > {
    const c = await this.find(pageId);
    if (!c) {
      return { ok: false, failure: { kind: 'no-provider', message: `没有这个 provider: ${pageId}` } };
    }
    const panel = (c.panels ?? []).find((p) => p.id === panelId);
    if (!panel) {
      return {
        ok: false,
        failure: { kind: 'no-panel', message: `provider ${pageId} 没有声明面板: ${panelId}` },
      };
    }
    return { ok: true, contribution: c, panel };
  }

  /**
   * 一次面板调用。语义、参数校验、结果形状全归那一页——这里只做解析与转交。
   *
   * 抛出的错误由调用方（server.ts）翻成 500；解析失败走返回值里的
   * `InvokeFailure`，因为那不是那一页的错。
   */
  async invoke(
    pageId: string,
    panelId: string,
    method: string,
    args: unknown[],
    transport: 'get' | 'post' = 'post',
  ): Promise<{ ok: true; value: unknown } | { ok: false; failure: InvokeFailure }> {
    const found = await this.resolvePanel(pageId, panelId);
    if (!found.ok) return found;
    if (transport === 'get' && found.panel.getMethods && !found.panel.getMethods.includes(method)) {
      return {
        ok: false,
        failure: { kind: 'method-not-allowed', message: `面板 ${panelId} 的方法 ${method} 只允许 POST` },
      };
    }
    const c = found.contribution;
    if (!c.invoke) {
      return {
        ok: false,
        failure: { kind: 'no-surface', message: `provider ${pageId} 没有面板数据面` },
      };
    }
    return { ok: true, value: await c.invoke(panelId, method, args) };
  }

  /**
   * 解析一条流式通道。与 `invoke` 同构：这里只负责"找到谁来接这条连接"，
   * 接上之后的一切（帧格式、心跳、清理）全归那一页。
   *
   * 返回的是**还没调用**的 `open`——真 socket 的包装归服务端，注册表不认识 ws。
   * `open` 由那一页的代码组成，抛错要由调用方接住并只关这一条连接。
   */
  async resolveStream(
    pageId: string,
    panelId: string,
  ): Promise<
    | { ok: true; open: (socket: ConsoleStream) => void }
    | { ok: false; failure: InvokeFailure }
  > {
    const found = await this.resolvePanel(pageId, panelId);
    if (!found.ok) return found;
    const c = found.contribution;
    const stream = c.stream;
    if (!stream) {
      return {
        ok: false,
        failure: { kind: 'no-surface', message: `provider ${pageId} 没有流式面` },
      };
    }
    return { ok: true, open: (socket) => stream.call(c, panelId, socket) };
  }
}
