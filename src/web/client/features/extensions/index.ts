/**
 * 「扩展」页 —— `extensions/` 下的 npm 包:装了哪些、npm 上还有哪些、装卸与重启。
 *
 * 框架知道的只有这么多:
 *
 * ```
 * 有一批包;每个处于 loaded / failed / pending-restart / removed / idle 之一;
 * 装卸只改磁盘,加载要重启进程。
 * ```
 *
 * 包名、描述、 World id 全部来自服务端,这一页不认识任何一个。
 *
 * 三类扩展(World、LLM Provider、bot 包)共用这一页,靠 `kind` 分组;读不出 manifest 的包
 * 没有 kind,单独一组并把原因摆出来。bot 包一个进程只跑一个:被这份部署引用的那个是
 * loaded,其余是 idle。
 *
 * | 动作 | 端点                        | 语义                                              |
 * | ---- | --------------------------- | ------------------------------------------------- |
 * | 清单 | `GET /api/extensions`          | 启动时的加载结果对照此刻磁盘                        |
 * | 搜索 | `GET /api/extensions/search`   | npm registry 上带该类关键字的包(`?kind=`)          |
 * | 安装 | `POST /api/extensions/install` | `{ name, version? }` 或 `{ path }`;完成后待重启    |
 * | 卸载 | `POST /api/extensions/uninstall` | `{ name }`;本进程里仍在跑,重启后消失            |
 * | 重启 | `POST /api/run/restart`     | 落重启标志 + 规范关机;启动器循环把进程拉起来        |
 */

import { get, post } from '../../core/api.ts';
import { pageIntro } from '../../ui/page.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';

/** 扩展类别。与 `ExtensionKind` 同形;这一页只用它分组与选关键字。 */
export type ExtensionKindView = 'world' | 'provider' | 'bot';

/** 与 `src/web/server.ts` 的 `ExtensionInfo` 同形。 */
export interface ExtensionView {
  name: string;
  spec: string;
  version: string | null;
  description?: string;
  kind?: ExtensionKindView;
  api?: number;
  consoleClient: boolean;
  console?: 'none' | 'served' | 'missing';
  loaded: boolean;
  reason?: string;
  worldId?: string;
  label?: string;
  state: 'loaded' | 'failed' | 'pending-restart' | 'removed' | 'idle';
}

/** 与 `ExtensionSearchHit` 同形。 */
export interface SearchHitView {
  name: string;
  version: string;
  description: string;
  date?: string;
  publisher?: string;
  downloads: number;
  links: { npm?: string; repository?: string; homepage?: string };
  installed: boolean;
  kind?: ExtensionKindView;
}

interface PowerReport {
  ok?: boolean;
  localComplete?: boolean;
  result?: string;
  error?: string;
  steps?: Array<{ label: string; ok: boolean; elapsedMs: number; detail?: string }>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}

/**
 * 手动安装框里的一行:含路径分隔符或以 `.` 开头的当本机目录,其余按 `name[@version]`
 * 拆(作用域包的第一个 `@` 是名字的一部分)。
 */
export function parseInstallInput(raw: string): { name: string; version?: string } | { path: string } | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith('.') || text.includes('/') && !text.startsWith('@') || text.includes('\\') || /^[A-Za-z]:/.test(text)) {
    return { path: text };
  }
  const at = text.indexOf('@', 1);
  if (at < 0) return { name: text };
  return { name: text.slice(0, at), version: text.slice(at + 1) };
}

const STATE_LABEL: Record<ExtensionView['state'], string> = {
  loaded: '已加载',
  failed: '加载失败',
  'pending-restart': '待重启',
  removed: '已卸载,待重启',
  idle: '已装,本部署未用',
};

const KIND_LABEL: Record<ExtensionKindView, string> = {
  world: 'World',
  provider: 'LLM Provider',
  bot: 'Bot',
};

/** 卡片副标题里 id 前面的那个词。 */
const KIND_NOUN: Record<ExtensionKindView, string> = {
  world: 'World',
  provider: 'provider',
  bot: 'bot',
};

/** npm 上按类发现用的关键字。与 `src/extensions/manifest.ts` 的 `EXTENSION_KEYWORDS` 对齐。 */
const KIND_KEYWORD: Record<ExtensionKindView, string> = {
  world: 'cortico-world',
  provider: 'cortico-provider',
  bot: 'cortico-bot',
};

/** 已安装清单的分组。`kind` 为 null 的一组收所有读不出 manifest 的包。 */
const GROUPS: ReadonlyArray<{ kind: ExtensionKindView | null; title: string; desc: string }> = [
  { kind: 'world', title: KIND_LABEL.world, desc: '接进外部世界的一路,激活后出现在「World」里。' },
  { kind: 'provider', title: KIND_LABEL.provider, desc: '一种模型端点方言,在「语言模型」页里选用。' },
  { kind: 'bot', title: KIND_LABEL.bot, desc: '一个 bot 代码包:Persona 与装配。部署的 deployment.json 里 bot 字段填包名即启用;一个进程只跑一个。' },
  { kind: null, title: '未识别', desc: 'package.json 里的 cortico 块缺席或不合契约,框架不知道该往哪挂。' },
];

export function mountExtensions(ctx: FeatureContext): void {
  const { ui, root } = ctx;
  const view = root.ownerDocument?.defaultView ?? null;
  const canRestart = ctx.capabilities.restart === true;
  const supervised = ctx.capabilities.supervised === true;

  const intro = pageIntro(ui, '扩展', '从 npm 安装第三方 World、LLM Provider 与 bot 包。装卸只改磁盘,重启进程后生效。');

  // -------------------------------------------------------------------------
  // 已安装
  // -------------------------------------------------------------------------

  const installedSheet = ui.sheet({
    title: '已安装',
    en: 'extensions/',
    desc: '每个包一张卡,按类别分组。状态对照的是本进程启动时的加载结果与此刻的磁盘:'
      + '装了没加载、卸了还在跑的都标「待重启」。',
  });
  const sumBar = ui.rowbar();
  const msg = ui.msgline();
  const refreshBtn = ui.button('↻ 刷新', { size: 'sm', onClick: () => void load() });
  const restartBtn = ui.button('重启进程', {
    size: 'sm',
    variant: 'primary',
    onClick: (ev) => void restartProcess(ev.currentTarget as HTMLButtonElement),
  });
  installedSheet.body.append(sumBar, msg);
  /** 分组容器:每组一条 section 标题 + 一张 `.iogrid`。 */
  const installedGroups = ui.h('div');

  function setMsg(text: string, bad?: boolean): void {
    msg.textContent = text;
    msg.className = 'msgline' + (bad ? ' bad' : '');
  }

  /**
   * 重启 = 落标志 + 规范关机。没有启动器循环时它就是一次关机,确认框上说清楚。
   * `confirmed` = 调用方已经问过一遍(装完那一问),不再重复。
   */
  async function restartProcess(btn?: HTMLButtonElement, confirmed = false): Promise<void> {
    if (!canRestart) return;
    if (!confirmed) {
      const ok = await ui.confirm({
        title: supervised ? '重启进程?' : '⚠ 没有启动器循环',
        body: supervised
          ? '按次序收尾并退出,启动器随即重新拉起。回来是暂停态,去控制台点「继续」上线。最长约半分钟。'
          : '这个进程不是启动器起的:退出后不会自动回来,需要手动重新启动。仍要继续?',
        danger: !supervised,
      });
      if (!ok || ctx.signal.aborted) return;
    }
    const lock = btn ? ui.disable(btn) : null;
    const hold = ui.toast('正在按次序收尾…别关窗口。');
    try {
      const out = await post<PowerReport>('/api/run/restart', undefined, { signal: ctx.signal });
      if (ctx.signal.aborted) return;
      if (out?.error) throw new Error(out.error);
      const lines = (out?.steps ?? []).map((s) =>
        `${s.ok ? '✓' : '✗'} ${s.label} · ${(s.elapsedMs / 1000).toFixed(1)}s${s.ok ? '' : ` — ${s.detail ?? '未完成'}`}`);
      void ui.confirm({
        title: supervised ? '已退出,等待启动器拉起' : '已退出',
        body: [out?.result ?? '已收尾。', '', ...lines].join('\n'),
      });
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      // 连接在收尾途中断掉是预期之一:进程退出得比回执快。
      ui.toast(`没拿到收尾回执(${errText(err)});进程可能已经退出。`, 'bad');
    } finally {
      hold.dispose();
      lock?.dispose();
    }
  }

  async function uninstall(p: ExtensionView, btn: HTMLButtonElement): Promise<void> {
    const ok = await ui.confirm({
      title: `卸载「${p.label || p.name}」?`,
      body: `从 extensions/ 里移除 ${p.name}。它在本进程里仍在运行,重启后消失。`,
      danger: true,
    });
    if (!ok || ctx.signal.aborted) return;
    const lock = ui.disable(btn);
    const hold = ui.toast('正在卸载…');
    try {
      const out = await post<{ result?: string }>('/api/extensions/uninstall', { name: p.name }, { signal: ctx.signal });
      if (ctx.signal.aborted) return;
      setMsg(out?.result?.split('\n')[0] || '已卸载');
      await load();
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      setMsg('卸载失败: ' + errText(err), true);
    } finally {
      hold.dispose();
      lock.dispose();
    }
  }

  /** 装完问一句要不要顺手重启;答"否"也留在清单里标「待重启」。 */
  async function install(target: { name: string; version?: string } | { path: string }, btn?: HTMLButtonElement): Promise<void> {
    const lock = btn ? ui.disable(btn) : null;
    const hold = ui.toast('正在安装…pnpm 在跑,可能要一分钟。');
    let result = '';
    try {
      const out = await post<{ result?: string }>('/api/extensions/install', target, { signal: ctx.signal });
      if (ctx.signal.aborted) return;
      result = out?.result ?? '已安装';
      setMsg(result.split('\n')[0]);
      await load();
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      setMsg('安装失败: ' + errText(err), true);
      return;
    } finally {
      hold.dispose();
      lock?.dispose();
    }
    if (!canRestart) return;
    const go = await ui.confirm({
      title: '已安装,现在重启进程加载它?',
      body: result + '\n\n' + (supervised
        ? '重启会按次序收尾并由启动器重新拉起,回来是暂停态。'
        : '⚠ 没有检测到启动器循环:重启等于关机,之后要手动启动。'),
      danger: !supervised,
    });
    if (!go || ctx.signal.aborted) return;
    await restartProcess(undefined, true);
  }

  function extensionCard(p: ExtensionView): HTMLElement {
    const en = `${p.name}@${p.version ?? '?'}${p.worldId && p.kind ? ` · ${KIND_NOUN[p.kind]} ${p.worldId}` : ''}`;
    const card = ui.sheet({ title: p.label || p.name, en });
    card.el.classList.add('iocard');
    if (p.state !== 'loaded') card.el.classList.add('iocard-inactive');
    const bar = ui.rowbar();
    bar.append(ui.pill(STATE_LABEL[p.state], p.state === 'loaded' ? 'on' : 'off'));
    if (p.kind) bar.appendChild(ui.pill(KIND_LABEL[p.kind]));
    if (p.api !== undefined) bar.appendChild(ui.chip(`v${p.api}`));
    if (p.console === 'served') bar.appendChild(ui.pill('自定义面板已加载', 'on'));
    card.body.appendChild(bar);
    if (p.description) card.body.appendChild(ui.msgline(p.description));
    if (p.reason) card.body.appendChild(ui.msgline(p.reason, true));
    if (p.state === 'pending-restart') card.body.appendChild(ui.msgline('装好了,重启进程后加载。'));
    if (p.state === 'removed') card.body.appendChild(ui.msgline('已从磁盘卸掉,本进程里仍在运行;重启后消失。'));
    if (p.state === 'idle') card.body.appendChild(ui.msgline('这份部署的 deployment.json 没有引用它,没有加载。'));
    if (p.console === 'missing') {
      card.body.appendChild(ui.msgline('声明了浏览器端产物但文件不在:到扩展目录里 build 一次,再重启。', true));
    }
    if (p.state !== 'removed') {
      const actions = ui.actions();
      actions.appendChild(ui.button('卸载', {
        size: 'sm',
        variant: 'danger',
        onClick: (ev) => void uninstall(p, ev.currentTarget as HTMLButtonElement),
      }));
      card.body.appendChild(actions);
    }
    return card.el;
  }

  function renderInstalled(extensions: readonly ExtensionView[], dir: string): void {
    sumBar.replaceChildren();
    installedGroups.replaceChildren();
    const loaded = extensions.filter((p) => p.state === 'loaded').length;
    const pending = extensions.filter((p) => p.state === 'pending-restart' || p.state === 'removed').length;
    const failed = extensions.filter((p) => p.state === 'failed').length;
    sumBar.appendChild(ui.pill(`已加载 ${loaded}`, 'on'));
    if (pending > 0) sumBar.appendChild(ui.pill(`待重启 ${pending}`, 'off'));
    if (failed > 0) sumBar.appendChild(ui.pill(`加载失败 ${failed}`, 'off'));
    sumBar.appendChild(ui.chip(dir));
    sumBar.append(ui.h('span', 'grow'), refreshBtn);
    if (canRestart) sumBar.appendChild(restartBtn);
    if (extensions.length === 0) {
      installedGroups.appendChild(ui.placeholder('还没装任何扩展'));
      return;
    }
    for (const g of GROUPS) {
      const mine = extensions.filter((p) => (p.kind ?? null) === g.kind);
      if (mine.length === 0) continue;
      const grid = ui.h('div', 'iogrid');
      for (const p of mine) grid.appendChild(extensionCard(p));
      installedGroups.append(ui.section(g.title, g.desc), grid);
    }
  }

  async function load(): Promise<void> {
    try {
      const data = await get<{ dir?: string; extensions?: ExtensionView[] }>('/api/extensions', { signal: ctx.signal });
      if (ctx.signal.aborted) return;
      renderInstalled(Array.isArray(data?.extensions) ? data.extensions : [], data?.dir ?? '');
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      installedGroups.replaceChildren(ui.placeholder('扩展清单加载失败: ' + errText(err)));
    }
  }

  // -------------------------------------------------------------------------
  // 搜索 npm
  // -------------------------------------------------------------------------

  const searchSheet = ui.sheet({
    title: '从 npm 安装',
    en: 'npm registry',
    desc: '扩展在进程内运行,拥有与框架相同的文件与网络权限——安装前看一眼仓库与作者。',
  });
  let searchKind: ExtensionKindView = 'world';
  const searchBar = ui.rowbar();
  const kindSeg = ui.segmented(
    [
      { value: 'world', label: KIND_LABEL.world },
      { value: 'provider', label: KIND_LABEL.provider },
      { value: 'bot', label: KIND_LABEL.bot },
    ],
    {
      size: 'sm',
      value: searchKind,
      onSelect: (v) => {
        searchKind = v as ExtensionKindView;
        paintKeyword();
        // 换了类就换了关键字,上一类的命中留在屏幕上会被当成这一类的结果
        resultGrid.replaceChildren();
        searchMsg.textContent = '';
      },
    },
  );
  const searchInput = ui.input({ type: 'search', placeholder: '关键字;留空列出全部' });
  const searchBtn = ui.button('搜索', { size: 'sm', variant: 'primary', onClick: () => void search() });
  searchInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') void search(); }, { signal: ctx.signal });
  searchBar.append(kindSeg.el, searchInput, searchBtn);
  const keywordLine = ui.msgline();
  function paintKeyword(): void {
    keywordLine.textContent = `列出 npm 上带 ${KIND_KEYWORD[searchKind]} 关键字的包。`;
  }
  paintKeyword();
  const searchMsg = ui.msgline();
  const resultGrid = ui.h('div', 'iogrid');
  searchSheet.body.append(searchBar, keywordLine, searchMsg, resultGrid);

  function openLink(href: string): void {
    view?.open(href, '_blank', 'noopener');
  }

  function hitCard(h: SearchHitView): HTMLElement {
    const card = ui.sheet({ title: h.name, en: `${h.version} · 月下载 ${h.downloads}${h.publisher ? ` · ${h.publisher}` : ''}` });
    card.el.classList.add('iocard');
    if (h.kind) {
      const bar = ui.rowbar();
      bar.appendChild(ui.pill(KIND_LABEL[h.kind]));
      card.body.appendChild(bar);
    }
    if (h.description) card.body.appendChild(ui.msgline(h.description));
    const actions = ui.actions();
    const links: Array<[string, string | undefined]> = [['npm', h.links.npm], ['仓库', h.links.repository], ['主页', h.links.homepage]];
    for (const [label, href] of links) {
      if (href) actions.appendChild(ui.button(label, { size: 'sm', onClick: () => openLink(href) }));
    }
    const installBtn = ui.button(h.installed ? '已安装' : '安装', {
      size: 'sm',
      variant: 'primary',
      onClick: (ev) => void install({ name: h.name, version: h.version }, ev.currentTarget as HTMLButtonElement),
    });
    installBtn.disabled = h.installed;
    actions.appendChild(installBtn);
    card.body.appendChild(actions);
    return card.el;
  }

  async function search(): Promise<void> {
    const lock = ui.disable(searchBtn);
    searchMsg.textContent = '搜索中…';
    searchMsg.className = 'msgline';
    try {
      const q = encodeURIComponent(searchInput.value.trim());
      const data = await get<{ hits?: SearchHitView[] }>(
        `/api/extensions/search?q=${q}&kind=${searchKind}`,
        { signal: ctx.signal },
      );
      if (ctx.signal.aborted) return;
      const hits = Array.isArray(data?.hits) ? data.hits : [];
      resultGrid.replaceChildren();
      searchMsg.textContent = hits.length === 0 ? '没有匹配的包' : `${hits.length} 个包`;
      for (const h of hits) resultGrid.appendChild(hitCard(h));
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      searchMsg.textContent = '搜索失败: ' + errText(err);
      searchMsg.className = 'msgline bad';
    } finally {
      lock.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 手动安装
  // -------------------------------------------------------------------------

  const manualSheet = ui.sheet({
    title: '手动安装',
    en: 'name@version · ./path',
    desc: '包名(可带 @版本)或本机一个含 package.json 的目录。本机目录以链接方式装入,改源码后重启即生效——给自己写 World 的人用。',
  });
  const manualBar = ui.rowbar();
  const manualInput = ui.input({ cls: 'mono', placeholder: '@scope/name@1.2.0 或 ../my-module' });
  const manualBtn = ui.button('安装', {
    size: 'sm',
    variant: 'primary',
    onClick: (ev) => {
      const target = parseInstallInput(manualInput.value);
      if (!target) { setMsg('先填包名或目录', true); return; }
      void install(target, ev.currentTarget as HTMLButtonElement);
    },
  });
  manualBar.append(manualInput, manualBtn);
  manualSheet.body.append(manualBar);

  root.append(intro, installedSheet.el, installedGroups, searchSheet.el, manualSheet.el);
  installedGroups.appendChild(ui.placeholder('加载中…'));
  void load();
}

export const extensionsFeature: FrameworkFeature = {
  route: 'extensions',
  label: '扩展',
  icon: 'download',
  navGroup: '系统',
  needs: ['extensions'],
  mount: mountExtensions,
};
