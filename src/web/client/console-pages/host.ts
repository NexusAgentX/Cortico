/**
 * Console Page Host 根据 manifest 渲染导航与面板，并管理挂载和卸载；不依赖具体页的名称。扩展加载、mount 或面板解析失败仅将对应面板替换为错误卡，不影响其他页与框架。
 */

import {
  CONSOLE_PROTOCOL_VERSION,
  type ConsoleManifest,
  type ConsolePageManifest,
} from '../../shared/console-protocol.ts';
import type { ConsoleMemo, ConsolePanel, Disposable } from '../../shared/client-panel.ts';
import { post } from '../core/api.ts';
import { Lifecycle } from '../core/lifecycle.ts';
import type { Router } from '../core/router.ts';
import type { SocketLike } from '../core/stream.ts';
import { createConsoleUi } from '../ui/index.ts';
import { lampRow } from '../ui/lamp.ts';
import { createConfigView } from '../features/config/view.ts';
import { createPromptsView } from '../features/prompts/view.ts';
import { resolveConsoleLinkHref } from '../theme/handoff.ts';
import type { BuiltinPanels } from './builtins.ts';
import { createPanelContext, namespacedMemo } from './context.ts';
import { ConsolePageLoader } from './loader.ts';
import { S } from './strings.ts';

/**
 * 路由第一段。framework 的页面用别的段，互不侵占。
 *
 * 名字与取值都仍是 `provider`:那是控制台的 URL 形状(线协议),与自带前端的构建
 * 产物同步,不随这次的类型改名一起动。
 */
export const PROVIDER_ROUTE = 'provider';
/**
 * 框架自带的两个通用页签。`~` 开头，所以与合法 panel id（`[a-z0-9-]`）
 * 永远撞不上——贡献方想抢也抢不到这两段。
 *
 * 它们**由框架渲染、按那一页的声明填内容**：前缀源来自 `promptDocs`，
 * 参数来自 `config`。两者都是声明式的东西，贡献方不必为它们写一行浏览器代码。
 */
const PROVIDER_PROMPTS_ROUTE = '~prompts';
const PROVIDER_CONFIG_ROUTE = '~config';

/**
 * 迭代前确认真是数组。
 *
 * `badges: 'nope'` 这种**可迭代的垃圾**比不可迭代的更糟:`for...of` 一个字符串
 * 不会抛,只会逐字符跑一遍,画出四枚写着 `undefined undefined` 的药丸。
 * 服务端已经挡了这些形状,但那不是这里可以塌的理由。
 */
function asArray<T>(v: readonly T[] | undefined): readonly T[] {
  return Array.isArray(v) ? v : [];
}

export interface ConsolePageHostDeps {
  doc: Document;
  /** 页面内容渲染到这里。host 自己清空/重建它。 */
  root: HTMLElement;
  /** 浮层宿主，页面级容器；绝不能是 `root`。 */
  overlayHost: HTMLElement;
  loader: ConsolePageLoader;
  /** 内核自带的面板实现，键即 `panel.builtin`。 */
  builtins: BuiltinPanels;
  router: Router;
  fetchManifest(): Promise<ConsoleManifest>;
  memo: ConsoleMemo;
  createSocket(url: string): SocketLike;
  wsUrl(path: string): string;
  onError(err: unknown): void;
  /**
   * 面板页签指向的路由。缺省是 `#/provider/<id>/<panel>`;嵌在别的框架页里的宿主
   * 给自己那一页的前缀,页签切换才不会跳出那一页。
   */
  route?(pageId: string, panelId: string): readonly string[];
}

interface MountedPanel {
  pageId: string;
  panelId: string;
  lifecycle: Lifecycle;
}

/**
 * 页头与面板槽是**两个容器**。
 *
 * 它们必须分开,否则 `ctx.refresh()` 会连面板一起铲掉——而那个方法存在的全部意义
 * 正是"刷新徽标但不重挂面板"。合成一个容器时这个 bug 只在真浏览器里看得见:
 * 单元测试断言的是"徽标更新了",而它确实更新了。
 */
interface Panes {
  chrome: HTMLElement;
  slot: HTMLElement;
}

export class ConsolePageHost {
  private readonly deps: ConsolePageHostDeps;
  private snapshot: ConsoleManifest | null = null;
  private mounted: MountedPanel | null = null;
  private panes: Panes | null = null;
  /**
   * 挂载代号。异步 mount 期间用户可能已经走了；回来时对不上号就整个丢弃，
   * 免得把一个已经不该存在的面板贴进 DOM。
   */
  private generation = 0;
  private readonly navListeners = new Set<() => void>();

  constructor(deps: ConsolePageHostDeps) {
    this.deps = deps;
  }

  get pages(): ConsolePageManifest[] {
    // 线上字段仍叫 `providers`(线协议形状,与构建产物同步),本地一律叫 page。
    return this.snapshot?.providers ?? [];
  }

  /** 取一次 manifest。失败时保留上一份（一次网络抖动不该让导航整个消失）。 */
  async load(): Promise<void> {
    try {
      const next = await this.deps.fetchManifest();
      /**
       * 版本不认识就**拒绝渲染**，不猜。
       *
       * 协议注释里写着这一条，但先前没有任何执行点——服务端换了协议、前端还是
       * 旧 bundle 时，会按旧形状去读新结构，错得既安静又难查。宁可空导航加一条
       * 明确的错。
       */
      if (next && next.protocolVersion !== CONSOLE_PROTOCOL_VERSION) {
        throw new Error(S.protocolMismatch(String(next.protocolVersion), String(CONSOLE_PROTOCOL_VERSION)));
      }
      this.snapshot = next;
    } catch (err) {
      this.deps.onError(err);
      if (!this.snapshot) {
        this.snapshot = {
          protocolVersion: CONSOLE_PROTOCOL_VERSION,
          providers: [],
          framework: { capabilities: {} },
        };
      }
    }
    this.emitNav();
  }

  /** 重取 manifest 并刷新导航与当前页头，**不重挂面板**。 */
  async refresh(): Promise<void> {
    await this.load();
    const cur = this.mounted;
    if (cur) this.renderChrome(cur.pageId, cur.panelId);
  }

  onNavChange(cb: () => void): Disposable {
    this.navListeners.add(cb);
    return { dispose: () => this.navListeners.delete(cb) };
  }

  private emitNav(): void {
    for (const cb of [...this.navListeners]) {
      try {
        cb();
      } catch (err) {
        this.deps.onError(err);
      }
    }
  }

  find(pageId: string): ConsolePageManifest | undefined {
    return this.pages.find((p) => p.id === pageId);
  }

  private routeOf(pageId: string, panelId: string): readonly string[] {
    return this.deps.route ? this.deps.route(pageId, panelId) : [PROVIDER_ROUTE, pageId, panelId];
  }

  /** 卸载当前面板：abort → dispose → 清空 root。顺序见 client-panel.ts 的说明。 */
  unmount(): void {
    const cur = this.mounted;
    this.mounted = null;
    this.panes = null;
    this.generation++;
    if (cur) cur.lifecycle.dispose();
    this.deps.root.replaceChildren();
  }

  /** 建（或复用）页头与面板槽两个容器。 */
  private ensurePanes(): Panes {
    if (this.panes) return this.panes;
    const doc = this.deps.doc;
    const chrome = doc.createElement('div');
    chrome.className = 'providerchrome';
    const slot = doc.createElement('div');
    slot.className = 'panelslot';
    this.deps.root.replaceChildren(chrome, slot);
    this.panes = { chrome, slot };
    return this.panes;
  }

  /**
   * 显示指定页的面板，省略 panelId 时选择第一个面板。每次调用先卸载上一面板，以重建完整生命周期。
   * 页头渲染、面板解析及 mount 均处于异常隔离范围，失败时显示该面板的错误卡，不使 show() 的错误扩散为路由空白。
   */
  async show(pageId: string, panelId?: string): Promise<void> {
    try {
      await this.showInner(pageId, panelId);
    } catch (err) {
      this.deps.onError(err);
      try {
        this.renderError(S.pageFailed(pageId), err instanceof Error ? err.message : String(err));
      } catch { /* 连错误卡都画不出来:那是 ui 层的事,不再往上抛 */ }
    }
  }

  private async showInner(pageId: string, panelId?: string): Promise<void> {
    this.unmount();
    const gen = this.generation;

    const page = this.find(pageId);
    if (!page) {
      this.renderError(S.noPage(pageId), S.noPageHint);
      return;
    }
    const panels = asArray(page.panels);
    const prompts = asArray(page.prompts);
    const configGroups = this.configGroupsOf(page);
    const wanted = panelId ?? panels[0]?.id
      ?? (configGroups.length ? PROVIDER_CONFIG_ROUTE : undefined)
      ?? (prompts.length ? PROVIDER_PROMPTS_ROUTE : undefined);
    if (wanted === PROVIDER_CONFIG_ROUTE && configGroups.length) {
      this.renderChrome(pageId, PROVIDER_CONFIG_ROUTE);
      await this.showConfig(pageId, configGroups, gen);
      return;
    }
    if (wanted === PROVIDER_PROMPTS_ROUTE && prompts.length) {
      this.renderChrome(pageId, PROVIDER_PROMPTS_ROUTE);
      await this.showPrompts(pageId, prompts.map((doc) => doc.key), gen);
      return;
    }
    const panel = wanted ? panels.find((p) => p.id === wanted) : undefined;
    if (!panel) {
      this.renderChrome(pageId, wanted);
      if (panels.length === 0 && prompts.length === 0 && configGroups.length === 0) {
        this.appendNote(S.noPanels(page.label));
      } else {
        this.renderError(
          S.noSuchPanel(page.label, wanted ?? ''),
          S.provides([
            ...panels.map((p) => p.id),
            ...(configGroups.length ? [PROVIDER_CONFIG_ROUTE] : []),
            ...(prompts.length ? [PROVIDER_PROMPTS_ROUTE] : []),
          ].join(' / ')),
        );
      }
      return;
    }

    this.renderChrome(pageId, panel.id);
    const { slot } = this.ensurePanes();

    const lifecycle = new Lifecycle(this.deps.onError);
    this.mounted = { pageId, panelId: panel.id, lifecycle };

    try {
      const impl = panel.builtin !== undefined
        ? this.builtinPanel(panel.builtin)
        : await this.deps.loader.resolvePanel(pageId, panel.id, page.client);
      if (gen !== this.generation) return; // 等 import 的工夫用户已经走了

      const ctx = createPanelContext({
        pageId,
        panelId: panel.id,
        root: slot,
        lifecycle,
        overlayHost: this.deps.overlayHost,
        refresh: () => this.refresh(),
        addLeaveGuard: (fn) => this.deps.router.addLeaveGuard(fn),
        memo: namespacedMemo(this.deps.memo, pageId, panel.id),
        createSocket: this.deps.createSocket,
        wsUrl: this.deps.wsUrl,
        onError: this.deps.onError,
        doc: this.deps.doc,
      });

      const out = await impl.mount(ctx);
      if (gen !== this.generation) {
        // mount 期间被卸载了:它自己返回的 Disposable 还没人管,补一刀。
        if (out && typeof out.dispose === 'function') out.dispose();
        return;
      }
      if (out && typeof out.dispose === 'function') lifecycle.own(out);
    } catch (err) {
      if (gen !== this.generation) return;
      this.deps.onError(err);
      lifecycle.dispose();
      slot.replaceChildren();
      this.renderErrorInto(
        slot,
        S.panelFailed(panel.title),
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * 取一块内核自带的面板。声明了一个内核不认识的名字 → 明确报错,由 `showInner`
   * 的 catch 收成这一格的错误卡:同一页的其他面板与整个框架不受影响。
   *
   * 内置面板整条路不碰 loader,所以一页的面板全是内置时,它没有浏览器产物也正常。
   */
  private builtinPanel(name: string): ConsolePanel {
    const builtins = this.deps.builtins;
    const impl = builtins[name];
    if (!impl) throw new Error(S.noBuiltinPanel(name, Object.keys(builtins).join(' / ') || S.none));
    return impl;
  }

  /**
   * 这一页认领的、**并且这个部署真的答得出来**的配置组。
   *
   * 参数页整个架在 `/api/config` 上，那个表面没挂的部署（`capabilities.config`
   * 为 false）里，这颗页签只会通向一张 503 的错误卡——那不是界面，是把服务端的
   * 状态码当界面用。没挂就不出现，与外壳对框架页的处置同一条规矩。
   */
  private configGroupsOf(page: ConsolePageManifest): readonly string[] {
    if (this.snapshot?.framework?.capabilities?.config === false) return [];
    return asArray(page.configGroups);
  }

  /**
   * 这一页认领的那几组旋钮，由框架通用渲染在它自己这一页上。
   *
   * manifest 只给 id（归属），schema 与当前值仍从 `/api/config` 取——那是唯一
   * 的配置口子，这里没有第二条数据面。`showOwner: false`：整页都是同一个
   * owner，再给每组印一枚"谁的"标签是废话。
   */
  private async showConfig(pageId: string, groupIds: readonly string[], gen: number): Promise<void> {
    const { slot } = this.ensurePanes();
    const lifecycle = new Lifecycle(this.deps.onError);
    this.mounted = { pageId, panelId: PROVIDER_CONFIG_ROUTE, lifecycle };
    const ui = createConsoleUi({
      memo: namespacedMemo(this.deps.memo, pageId, PROVIDER_CONFIG_ROUTE),
      overlayHost: this.deps.overlayHost,
      signal: lifecycle.signal,
      doc: this.deps.doc,
    });
    const wanted = new Set(groupIds);
    const view = createConfigView({
      ui,
      lifecycle,
      signal: lifecycle.signal,
      filter: (group) => wanted.has(group.id),
      showOwner: false,
      emptyText: S.configEmpty,
    });
    const sheet = ui.sheet({
      title: S.configTitle,
      en: 'config',
      desc: S.configDesc,
    });
    sheet.body.appendChild(view.el);
    slot.appendChild(sheet.el);
    await view.load();
    if (gen !== this.generation) lifecycle.dispose();
  }

  /** 这一页声明的提示词模板仍由框架通用编辑器承载，扩展无需重复文件读写 UI。 */
  private async showPrompts(pageId: string, keys: readonly string[], gen: number): Promise<void> {
    const { slot } = this.ensurePanes();
    const lifecycle = new Lifecycle(this.deps.onError);
    this.mounted = { pageId, panelId: PROVIDER_PROMPTS_ROUTE, lifecycle };
    const ui = createConsoleUi({
      memo: namespacedMemo(this.deps.memo, pageId, PROVIDER_PROMPTS_ROUTE),
      overlayHost: this.deps.overlayHost,
      signal: lifecycle.signal,
      doc: this.deps.doc,
    });
    const view = createPromptsView({
      ui,
      lifecycle,
      signal: lifecycle.signal,
      addLeaveGuard: (fn) => this.deps.router.addLeaveGuard(fn),
      onError: this.deps.onError,
      keys,
    });
    slot.appendChild(view.el);
    await view.load();
    if (gen !== this.generation) lifecycle.dispose();
  }

  // -------------------------------------------------------------------------
  // 页头与错误卡。都只吃 manifest 的通用字段。
  // -------------------------------------------------------------------------

  private ui(): ReturnType<typeof createConsoleUi> {
    // 页头是 host 自己的 DOM，生命周期跟 host 走，不绑任何面板。
    return createConsoleUi({
      memo: this.deps.memo,
      overlayHost: this.deps.overlayHost,
      signal: new AbortController().signal,
      doc: this.deps.doc,
    });
  }

  private renderChrome(pageId: string, activePanel?: string): void {
    const page = this.find(pageId);
    const { chrome } = this.ensurePanes();
    chrome.replaceChildren();
    if (!page) return;

    const ui = this.ui();
    const head = ui.h('header', 'featureintro providerintro');
    const title = ui.h('h1', 'pagetitle', page.label);
    // 未装配的页由框架点灰灯:那是框架自己知道的装配事实,不必等它自报
    // (它根本没在跑,报不出来)。
    title.appendChild(lampRow(
      this.deps.doc,
      page.availability === 'active'
        ? page.lamps ?? []
        : [{ label: S.assembly, state: 'offline', hint: page.availability === 'missing' ? S.notInstalled : S.notActivated }],
    ));
    head.append(title, ui.h('p', 'pagedesc', page.id));
    const bar = ui.rowbar();

    for (const badge of asArray(page.badges)) {
      bar.appendChild(ui.pill(`${badge.label} ${badge.value}`, badge.tone));
    }
    if (page.availability !== 'active') {
      bar.appendChild(ui.pill(page.availability === 'missing' ? S.notInstalled : S.notActivated, 'off'));
    }
    if (page.agentVisible === false) bar.appendChild(ui.pill(S.hidden, 'off'));
    /**
     * 前缀漂移是那一页**声明**的，落地重载却是**框架**的动作——所以这里必须是
     * 一颗能点的按钮，不是一颗标签。
     *
     * 扩展那边**故意没有** `reloadPrefix()`：能用声明式表达的就不该出现在命令式
     * 接口里。但只声明不给出口，操作者就卡住了（拨完开关，看着"前缀待重载"四个字
     * 没处可点）。两头都要有：那一页报事实，框架给动作。
     */
    if (page.prefixDrifted) {
      bar.appendChild(ui.button(S.reloadPrefix, {
        size: 'sm',
        onClick: () => { void this.reloadPrefix(ui); },
      }));
    }
    bar.appendChild(ui.h('span', 'grow'));

    for (const link of asArray(page.links)) {
      const open = ui.button(link.label || S.open, {
        variant: 'primary',
        size: 'sm',
        onClick: () => {
          this.deps.doc.defaultView?.open(
            resolveConsoleLinkHref(this.deps.doc, link),
            '_blank',
            'noopener',
          );
        },
      });
      bar.appendChild(open);
    }
    head.appendChild(bar);
    if (page.reason) head.appendChild(ui.msgline(page.reason, true));
    chrome.appendChild(head);

    const panels = asArray(page.panels);
    const prompts = asArray(page.prompts);
    const configGroups = this.configGroupsOf(page);
    if (panels.length + (configGroups.length ? 1 : 0) + (prompts.length ? 1 : 0) > 1) {
      const tabs = ui.rowbar();
      const go = (panelId: string): void => this.deps.router.navigate(this.routeOf(page.id, panelId));
      for (const p of panels) {
        const btn = ui.button(p.title || p.id, {
          size: 'sm',
          variant: p.id === activePanel ? 'primary' : 'plain',
          onClick: () => go(p.id),
        });
        tabs.appendChild(btn);
      }
      if (configGroups.length) {
        tabs.appendChild(ui.button(S.configTab, {
          size: 'sm',
          variant: activePanel === PROVIDER_CONFIG_ROUTE ? 'primary' : 'plain',
          onClick: () => go(PROVIDER_CONFIG_ROUTE),
        }));
      }
      if (prompts.length) {
        tabs.appendChild(ui.button(prompts.length === 1 ? prompts[0]!.title : S.promptsTab, {
          size: 'sm',
          variant: activePanel === PROVIDER_PROMPTS_ROUTE ? 'primary' : 'plain',
          onClick: () => go(PROVIDER_PROMPTS_ROUTE),
        }));
      }
      chrome.appendChild(tabs);
    }
  }

  /**
   * 重载当前 session 的 system 前缀。每次重载丢一次缓存前缀，所以由操作者点，
   * 框架不偷偷替他做。完事后重取 manifest——漂移标记该消失了。
   */
  private async reloadPrefix(ui: ReturnType<typeof createConsoleUi>): Promise<void> {
    const ok = await ui.confirm({
      title: S.reloadTitle,
      body: S.reloadBody,
    });
    if (!ok) return;
    try {
      const out = await post<{ result?: string }>('/api/session/reload-prefix');
      ui.toast(out?.result || S.prefixReloaded, 'ok');
      await this.refresh();
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err), 'bad');
    }
  }

  private appendNote(text: string): void {
    this.ensurePanes().slot.appendChild(this.ui().placeholder(text));
  }

  private renderError(title: string, detail: string): void {
    this.renderErrorInto(this.ensurePanes().slot, title, detail);
  }

  private renderErrorInto(target: HTMLElement, title: string, detail: string): void {
    const ui = this.ui();
    const card = ui.sheet({ title, en: 'panel error' });
    card.body.appendChild(ui.msgline(detail, true));
    target.appendChild(card.el);
  }
}
