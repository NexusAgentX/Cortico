/**
 * 主题工作室 —— 主题的**可变状态**：选中哪个方案、明暗挡位、本机自定义方案，
 * 以及"正在预览但还没保存"的那一份草稿。
 *
 * 三条设计要点：
 *
 * 1. **首屏那一步不需要工作室的编辑能力，但需要它的读取与应用。** 所以
 *    `applyStoredTheme(doc)` 是一个可以在内核入口第一行直接调的导出：它只做
 *    "读存档 → 刷 CSS 变量"，不依赖路由、不依赖任何已挂载的页面。晚一步应用主题
 *    的代价是首屏闪一下白底，那是用户唯一会注意到的性能问题。
 *
 * 2. **换主题要能推给已经画好的图。** 画布类组件把颜色烤进了像素里，CSS 变量一变
 *    它们不会自己重画。所以给一个订阅口 `onThemeChange(cb)`，消费方登记一次即可，
 *    不必轮询"当前主色是不是变了"。
 *
 * 3. **单例是有意的，而且只有这一个。** 主题本来就是整份文档的属性（CSS 变量挂在
 *    `documentElement` 上），做成"每个页面各持一份"就会出现两份互相覆盖的真相。
 *    所以这里有且只有一个进程级实例，状态就那三个字段；页面从 `getThemeStudio()`
 *    取用，不自己 new，也不把主题状态复制进自己的 state。
 */

import { toDisposable, type Disposable } from '../../shared/client-panel.ts';
import {
  DEFAULT_SCHEME_ID,
  THEME_MODES,
  clonePalette,
  cloneScheme,
  fallbackPalette,
  normalizePalette,
  schemeSwatches,
  type ThemeAppearance,
  type ThemeMode,
  type ThemePalette,
  type ThemeScheme,
} from './registry.ts';
import { applyPalette } from './palette.ts';
import {
  browserThemeStorage,
  builtinSchemes,
  readStoredTheme,
  writeStoredTheme,
  type StoredTheme,
  type ThemeStorageLike,
} from './storage.ts';
import { S } from './strings.ts';

/** 方案的元信息（不含调色板本身）。 */
export interface ThemeSchemeInfo {
  id: string;
  name: string;
  note: string;
  builtin: boolean;
  custom: boolean;
}

/** 方案卡：元信息 + 一条四格色带。 */
export interface ThemeSchemeCard extends ThemeSchemeInfo {
  swatches: string[];
}

export interface ThemeSnapshot {
  selectedId: string;
  /** 用户选的挡位（可能是 `system`） */
  mode: ThemeMode;
  /** 解析之后真正生效的明暗 */
  appearance: ThemeAppearance;
  scheme: ThemeSchemeInfo;
  schemes: ThemeSchemeCard[];
  /** 当前生效的调色板；预览期间是那份草稿。 */
  palette: ThemePalette;
}

export interface ThemeChange {
  readonly snapshot: ThemeSnapshot;
  /**
   * 这次变化是不是"预览"。编辑器逐次拖动取色器会推出一长串 `preview: true`——
   * 重画代价高的订阅方（画布图表）可以只认 `false` 那些，编辑器自己的实时预览
   * 不该逼着后台每张图跟着重画三十次。
   */
  readonly preview: boolean;
}

export type ThemeChangeListener = (change: ThemeChange) => void;

/** `matchMedia('(prefers-color-scheme: dark)')` 的最小面。 */
export interface MediaQueryLike {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

export interface ThemeStudioDeps {
  doc: Document;
  /** 不给则取 `doc.defaultView.localStorage`；显式给 `null` = 只在内存里活一轮。 */
  storage?: ThemeStorageLike | null;
  /** 不给则取 `doc.defaultView.matchMedia(...)`；显式给 `null` = 系统挡位当浅色。 */
  media?: MediaQueryLike | null;
  /** 订阅方回调里抛的错落这儿。默认吞掉——一张图重画失败不该拖垮换肤本身。 */
  onError?(err: unknown): void;
}

/** 系统深色偏好。拿不到（老浏览器、假文档）就是 `null`，一律当浅色。 */
function systemDarkQuery(doc: Document): MediaQueryLike | null {
  try {
    return doc.defaultView?.matchMedia('(prefers-color-scheme: dark)') ?? null;
  } catch {
    return null;
  }
}

export class ThemeStudio {
  private readonly doc: Document;
  private readonly storage: ThemeStorageLike | null;
  private readonly media: MediaQueryLike | null;
  private readonly onError: (err: unknown) => void;
  private readonly listeners = new Set<ThemeChangeListener>();
  private state: StoredTheme;
  private previewPalette: ThemePalette | null = null;
  private closed = false;

  /** 系统挡位下跟着系统走。方法引用存下来，`dispose()` 才摘得掉。 */
  private readonly onMediaChange = (): void => {
    if (this.state.mode === 'system') this.apply();
  };

  constructor(deps: ThemeStudioDeps) {
    this.doc = deps.doc;
    this.storage = deps.storage === undefined ? browserThemeStorage(deps.doc) : deps.storage;
    this.media = deps.media === undefined ? systemDarkQuery(deps.doc) : deps.media;
    this.onError = deps.onError ?? ((): void => {});
    this.state = readStoredTheme(this.storage);
    this.media?.addEventListener('change', this.onMediaChange);
  }

  // ── 读 ──────────────────────────────────────────────────────────────

  /** 内置在前、自定义在后。每次现算，调用方拿到的是副本。 */
  schemes(): ThemeScheme[] {
    return [...builtinSchemes(), ...this.state.custom.map((s) => ({ ...cloneScheme(s), custom: true }))];
  }

  /** 当前方案。存档指向的 id 不存在（方案被别的标签页删了）就退回第一个。 */
  currentScheme(): ThemeScheme {
    const all = this.schemes();
    return all.find((s) => s.id === this.state.selectedId) ?? all[0];
  }

  get appearance(): ThemeAppearance {
    if (this.state.mode !== 'system') return this.state.mode;
    return this.media?.matches ? 'dark' : 'light';
  }

  get mode(): ThemeMode {
    return this.state.mode;
  }

  snapshot(): ThemeSnapshot {
    const scheme = this.currentScheme();
    const appearance = this.appearance;
    return {
      selectedId: scheme.id,
      mode: this.state.mode,
      appearance,
      scheme: info(scheme),
      schemes: this.schemes().map((item) => ({ ...info(item), swatches: schemeSwatches(item, appearance) })),
      palette: clonePalette(this.previewPalette ?? scheme.palettes[appearance]),
    };
  }

  // ── 写 ──────────────────────────────────────────────────────────────

  /**
   * 把存档里的选择刷到文档上。**首屏那一次传 `notify: false`**——那时候还没有任何
   * 订阅者，广播一条"主题变了"只会让第一个订阅方以为自己错过了什么。
   */
  apply(notify = true): void {
    this.previewPalette = null;
    const scheme = this.currentScheme();
    // 选中的方案没了（别的标签页删的）→ 把纠正结果落回存档，别每次开页都纠一遍
    if (scheme.id !== this.state.selectedId) {
      this.state.selectedId = scheme.id;
      this.persist();
    }
    const appearance = this.appearance;
    applyPalette(
      this.doc,
      normalizePalette(scheme.palettes[appearance], fallbackPalette(appearance)),
      { appearance, schemeId: scheme.id },
    );
    if (notify) this.emit(false);
  }

  select(id: string): boolean {
    if (!this.schemes().some((s) => s.id === id)) return false;
    this.state.selectedId = id;
    this.persist();
    this.apply();
    return true;
  }

  setMode(mode: ThemeMode): boolean {
    if (!THEME_MODES.includes(mode)) return false;
    this.state.mode = mode;
    this.persist();
    this.apply();
    return true;
  }

  /** 试色：刷到文档但**不写存档**。离开这一页或调 `resetPreview()` 就没了。 */
  preview(palette: ThemePalette): void {
    const scheme = this.currentScheme();
    const appearance = this.appearance;
    this.previewPalette = normalizePalette(palette, scheme.palettes[appearance]);
    applyPalette(this.doc, this.previewPalette, { appearance, schemeId: scheme.id });
    this.emit(true);
  }

  resetPreview(): void {
    this.apply();
  }

  /**
   * 另存为新的自定义方案并切过去。
   *
   * **只覆盖当前明暗变体**，另一半从源方案原样拷过来：用户在浅色下调完色，黑夜
   * 变体不该跟着变成一份浅色配色的暗抄本。
   */
  saveAs(name: string | null | undefined, palette: ThemePalette): string {
    const source = this.currentScheme();
    const appearance = this.appearance;
    const copy: ThemeScheme = {
      id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: String(name ?? '').trim().slice(0, 40) || S.copyOf(source.name),
      note: S.customNote,
      palettes: cloneScheme(source).palettes,
      custom: true,
    };
    copy.palettes[appearance] = normalizePalette(palette, source.palettes[appearance]);
    this.state.custom.push(copy);
    this.state.selectedId = copy.id;
    this.persist();
    this.apply();
    return copy.id;
  }

  /** 覆盖当前自定义方案。选中的是内置方案时返回 `false`（内置不可写）。 */
  saveCurrent(name: string | null | undefined, palette: ThemePalette): boolean {
    const scheme = this.state.custom.find((s) => s.id === this.state.selectedId);
    if (!scheme) return false;
    const appearance = this.appearance;
    scheme.name = String(name ?? '').trim().slice(0, 40) || scheme.name;
    scheme.palettes[appearance] = normalizePalette(palette, scheme.palettes[appearance]);
    this.persist();
    this.apply();
    return true;
  }

  /** 删掉当前自定义方案并切回默认方案。选中内置方案时返回 `false`。 */
  removeCurrent(): boolean {
    const before = this.state.custom.length;
    this.state.custom = this.state.custom.filter((s) => s.id !== this.state.selectedId);
    if (this.state.custom.length === before) return false;
    this.state.selectedId = DEFAULT_SCHEME_ID;
    this.persist();
    this.apply();
    return true;
  }

  // ── 订阅 ────────────────────────────────────────────────────────────

  /**
   * 订阅主题变化。返回的 `Disposable` 一 `dispose()` 就退订——页面把它交给自己的
   * `lifecycle` 即可，不必记得在卸载时手动摘。
   *
   * 重复登记同一个函数只算一次（`Set` 语义）；回调里再登记/退订不影响本轮派发。
   */
  onChange(listener: ThemeChangeListener): Disposable {
    this.listeners.add(listener);
    return toDisposable(() => {
      this.listeners.delete(listener);
    });
  }

  /** 摘掉系统深色监听并清空订阅。进程级实例通常活到页面关闭，测试与热重载用。 */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.media?.removeEventListener('change', this.onMediaChange);
    this.listeners.clear();
  }

  private persist(): void {
    writeStoredTheme(this.storage, this.state);
  }

  /** 逐个派发，**一个订阅方抛错不挡住其余的**——那是"清理代码里再坏一次"的形状。 */
  private emit(preview: boolean): void {
    if (this.listeners.size === 0) return;
    const change: ThemeChange = { snapshot: this.snapshot(), preview };
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (err) {
        this.onError(err);
      }
    }
  }
}

function info(scheme: ThemeScheme): ThemeSchemeInfo {
  return {
    id: scheme.id,
    name: scheme.name,
    note: scheme.note,
    builtin: !!scheme.builtin,
    custom: !!scheme.custom,
  };
}

// ---------------------------------------------------------------------------
// 进程级实例
// ---------------------------------------------------------------------------

let shared: ThemeStudio | null = null;

/**
 * 取（必要时新建）那个唯一的实例。
 *
 * `deps` 只在**第一次**（真正新建的那次）生效；之后再传会被忽略，因为半路换存储
 * 后端或换文档只会让两份状态对不上。测试要换一套 deps，先 `disposeThemeStudio()`。
 */
export function getThemeStudio(deps?: Partial<ThemeStudioDeps>): ThemeStudio {
  if (shared) return shared;
  const doc = deps?.doc ?? (typeof document === 'undefined' ? null : document);
  if (!doc) throw new Error('主题需要一个 Document');
  shared = new ThemeStudio({ ...deps, doc });
  return shared;
}

/**
 * **首屏第一件事**：读存档、把颜色刷到 `documentElement`。
 *
 * 同步执行、不发任何请求、不等任何路由，所以内核入口可以在第一行直接调它。
 * 返回当前快照（想据此做点别的判断时用），不需要就丢掉。
 */
export function applyStoredTheme(
  doc?: Document,
  deps?: Omit<Partial<ThemeStudioDeps>, 'doc'>,
): ThemeSnapshot {
  const studio = getThemeStudio(doc ? { ...deps, doc } : deps);
  studio.apply(false);
  return studio.snapshot();
}

/** 丢掉进程级实例（测试与热重载）。生产代码里没有它的用处。 */
export function disposeThemeStudio(): void {
  shared?.dispose();
  shared = null;
}
