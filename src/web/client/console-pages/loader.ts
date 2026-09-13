/**
 * 控制台页扩展加载器 —— 新架构在浏览器这一侧的核心。
 *
 * 流程：
 * ```
 * manifest.client.js  →  dynamic import()  →  校验导出  →  取 panel  →  mount(ctx)
 * ```
 *
 * 四条硬约束：
 *
 * 1. **懒加载。** 只有真的进了某一页的面板才 import 它的 bundle。停在
 *    live 页不该把所有页的代码都拉下来。
 * 2. **失败隔离。** 一个 bundle 404 了、语法错了、default export 不是扩展——
 *    都只影响它自己那一格，其余页与框架照常。
 * 3. **URL 只来自 manifest。** 加载器**不拼路径**。贡献方给不出路径，服务端
 *    只答构建产物里有的 key，这里再对拿到的 URL 过一次闸——三道都在。
 * 4. **不缓存失败。** 加载失败常常是"还没 build"或临时 404，缓存住会让用户必须
 *    刷整页才能重试。所以只对**进行中**的请求去重。
 *
 *    但要说清楚这条到哪儿为止：**浏览器自己的 module map 会把 fetch 失败的 URL
 *    记住并持久失败**，同一个 URL 再 `import()` 一次不会真的重发请求。所以
 *    "重来能成功"实际靠的是**产物带内容 hash**——重新 build 之后 manifest 给出的
 *    是一个新 URL，绕开了那条死记录。加载器这一层不缓存失败是必要条件，不是充分条件。
 */

import {
  isConsoleClientBundle,
  type ConsoleClientBundle,
  type ConsolePanel,
} from '../../shared/client-panel.ts';
import { isSafeAssetUrl, type ConsoleAssetEntry } from '../../shared/console-protocol.ts';
import { S } from './strings.ts';

/**
 * `<link rel=stylesheet>` 的最小形状。`dataset` 的值带 `undefined` 是为了直接接住
 * DOM 的 `DOMStringMap`——写死成 `Record<string,string>` 的话真 `HTMLLinkElement`
 * 反而塞不进来。
 */
export interface StyleLink {
  rel: string;
  href: string;
  dataset: { [key: string]: string | undefined };
}

export interface LoaderDeps {
  /**
   * 注入而不是直接写 `import(url)`：测试要能喂假模块，
   * 而 `import()` 的 specifier 一旦是字面量就没法拦。
   */
  importModule(url: string): Promise<unknown>;
  /** 注入 `<link rel=stylesheet>` 的宿主（一般是 document.head）。 */
  styleHost: { appendChild(node: unknown): void };
  createLink(): StyleLink;
  log?(message: string, detail?: Record<string, unknown>): void;
}

export class PanelBundleError extends Error {
  readonly pageId: string;
  constructor(pageId: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'PanelBundleError';
    this.pageId = pageId;
    if (cause !== undefined) this.cause = cause;
  }
}

export class ConsolePageLoader {
  private readonly deps: LoaderDeps;
  private readonly loaded = new Map<string, ConsoleClientBundle>();
  private readonly inFlight = new Map<string, Promise<ConsoleClientBundle>>();
  private readonly styled = new Set<string>();

  constructor(deps: LoaderDeps) {
    this.deps = deps;
  }

  /** 已加载的扩展集合，供核对懒加载行为。 */
  get loadedPages(): string[] {
    return [...this.loaded.keys()];
  }

  async load(pageId: string, asset: ConsoleAssetEntry | undefined): Promise<ConsoleClientBundle> {
    const cached = this.loaded.get(pageId);
    if (cached) return cached;

    const pending = this.inFlight.get(pageId);
    if (pending) return pending;

    const task = this.loadOnce(pageId, asset);
    this.inFlight.set(pageId, task);
    try {
      const bundle = await task;
      this.loaded.set(pageId, bundle);
      return bundle;
    } finally {
      // 成功与否都要摘掉:失败不缓存,下次可以重来。
      this.inFlight.delete(pageId);
    }
  }

  private async loadOnce(
    pageId: string,
    asset: ConsoleAssetEntry | undefined,
  ): Promise<ConsoleClientBundle> {
    if (!asset) {
      throw new PanelBundleError(pageId, S.noBundle(pageId));
    }
    if (!isSafeAssetUrl(asset.js)) {
      throw new PanelBundleError(pageId, S.badBundleUrl(pageId));
    }
    let mod: unknown;
    try {
      mod = await this.deps.importModule(asset.js);
    } catch (err) {
      throw new PanelBundleError(pageId, S.bundleLoadFailed(pageId, String(err)), err);
    }

    const candidate = (mod as { default?: unknown } | null)?.default;
    if (!isConsoleClientBundle(candidate)) {
      throw new PanelBundleError(pageId, S.badDefaultExport(pageId));
    }
    // 样式在 js 装成之后再注入:装不上的页不该在页面里留下一个 404 的 link。
    this.injectStyle(pageId, asset);
    return candidate;
  }

  /**
   * 面板样式跟着 bundle 走。同一页只注入一次；样式表**不随面板卸载移除**
   * ——移除会让同一页的其他面板闪一下，而多留一张 CSS 没有代价。
   */
  private injectStyle(pageId: string, asset: ConsoleAssetEntry): void {
    if (!asset.css || this.styled.has(pageId)) return;
    if (!isSafeAssetUrl(asset.css)) {
      this.deps.log?.(`「${pageId}」的样式地址不合法，已跳过`, { href: String(asset.css) });
      return;
    }
    this.styled.add(pageId);
    const link = this.deps.createLink();
    link.rel = 'stylesheet';
    link.href = asset.css;
    link.dataset.provider = pageId;
    this.deps.styleHost.appendChild(link);
  }

  /**
   * 取某个面板的扩展实现。
   * 声明了面板但扩展里没有对应键 → 明确报错，而不是渲染一片空白让人猜。
   */
  async resolvePanel(
    pageId: string,
    panelId: string,
    asset: ConsoleAssetEntry | undefined,
  ): Promise<ConsolePanel> {
    const bundle = await this.load(pageId, asset);
    const panel = bundle.panels[panelId];
    // 判据用 `in` 而不是真值:`panels: { x: null }` 是"键在、实现坏了",若掉进
    // 下面那支就会印出自相矛盾的话——"没有面板 x。它提供的是: x"。
    if (!(panelId in bundle.panels)) {
      const known = Object.keys(bundle.panels).join(' / ') || S.none;
      throw new PanelBundleError(pageId, S.noSuchBundlePanel(pageId, panelId, known));
    }
    // 键在、但不是个能 mount 的东西(含 null/undefined):分开措辞。说成"没有这个
    // 面板"会把人引去查声明和拼写,而真相是这一项写坏了。
    if (!panel || typeof panel.mount !== 'function') {
      throw new PanelBundleError(pageId, S.badPanelImpl(pageId, panelId));
    }
    return panel;
  }
}
