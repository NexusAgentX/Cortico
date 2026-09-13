/**
 * 调色板 → CSS 变量 —— 主题唯一真正写 DOM 的一步。
 *
 * 写的是 `documentElement` 的内联样式（`--paper` 一族）与两个 `data-` 标记，
 * 外加 `<meta name="theme-color">`。**只有这一处**：任何面板想换色都是改调色板，
 * 而不是自己往某个节点上刷颜色——否则"当前是什么颜色"就有了第二个真相来源。
 *
 * 为什么允许碰 `documentElement`：CSS 变量是按继承往下走的，挂在别处就覆盖不到
 * 全站。这不是"绕过 root 往外写 DOM"，这就是主题本身的职责边界。`document.body`
 * 仍然不碰。
 */

import {
  THEME_TOKENS,
  type ThemeAppearance,
  type ThemePalette,
} from './registry.ts';

export interface ApplyPaletteOptions {
  /** 解析之后的明暗，落到 `data-color-mode` 与 `color-scheme`（表单控件、滚动条随之变）。 */
  appearance: ThemeAppearance;
  /** 当前方案 id，落到 `data-theme-scheme`；给 CSS 留一个"某方案单独微调"的口子。 */
  schemeId?: string;
}

/**
 * 调色板 → `[CSS 变量名, 值]` 列表，**按词表顺序**、只含词表里的键。
 *
 * 单独导出是因为这是整套主题里唯一容易悄悄错的映射（少个 `--`、把野键刷上去），
 * 而它一旦写进 `applyPalette` 里面就只能靠看真浏览器来验。
 */
export function paletteVars(palette: ThemePalette): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const token of THEME_TOKENS) {
    const value = palette[token.key];
    if (typeof value === 'string' && value !== '') out.push(['--' + token.key, value]);
  }
  return out;
}

/**
 * `<meta name="theme-color">` —— 移动端浏览器的地址栏底色。
 * 没有就建一个；页面里已有（`index.html` 静态写的那一个）就改它的 `content`。
 */
function applyThemeColorMeta(doc: Document, color: string | undefined): void {
  const head = doc.head;
  if (!head || !color) return;
  let meta = doc.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
  if (!meta) {
    meta = doc.createElement('meta');
    meta.name = 'theme-color';
    head.appendChild(meta);
  }
  meta.content = color;
}

/** 把一份调色板刷到文档根上。**同步、幂等**，重复调用只是把同样的值再写一遍。 */
export function applyPalette(
  doc: Document,
  palette: ThemePalette,
  opts: ApplyPaletteOptions,
): void {
  const root = doc.documentElement;
  if (!root) return;
  for (const [name, value] of paletteVars(palette)) root.style.setProperty(name, value);
  root.dataset.colorMode = opts.appearance;
  if (opts.schemeId) root.dataset.themeScheme = opts.schemeId;
  root.style.colorScheme = opts.appearance;
  applyThemeColorMeta(doc, palette.paper);
}

/**
 * 读一个语义色的当前实际值（`getComputedStyle`）。
 *
 * 画布类组件（成本图表）没法用 CSS 变量，只能拿到具体颜色再往 canvas 里写，
 * 所以给它们留这一个读口。**读不出合法颜色时退回 `--ink-dim`**：图表宁可画成一片
 * 灰，也不该因为一个空字符串而整张图消失。
 */
export function readThemeColor(doc: Document, key: string): string {
  const root = doc.documentElement;
  const view = doc.defaultView;
  if (!root || !view) return '';
  const read = (k: string): string => view.getComputedStyle(root).getPropertyValue('--' + k).trim();
  const value = read(key);
  return /^#[0-9a-f]{6}$/i.test(value) ? value : read('ink-dim');
}

// ---------------------------------------------------------------------------
// 颜色换算
// ---------------------------------------------------------------------------

export interface Hsl {
  /** 0–360 */
  h: number;
  /** 0–100 */
  s: number;
  /** 0–100 */
  l: number;
}

/**
 * `#rrggbb` / `#rgb` → HSL。
 *
 * 色彩换算的家安在主题这一层，是因为需要它的都是**主题色的派生**：一族堆叠柱要
 * 从同一个语义色分出深浅，靠的就是拿它的 HSL 再挪明度。各自实现一份的话，同一个
 * 系列色在两张图上会分出不一样的深浅。
 */
export function hexToHsl(hex: string): Hsl {
  let x = String(hex).replace('#', '');
  if (x.length === 3) x = x.split('').map((c) => c + c).join('');
  const r = parseInt(x.slice(0, 2), 16) / 255;
  const g = parseInt(x.slice(2, 4), 16) / 255;
  const b = parseInt(x.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

/** HSL → `hsl(210,12%,40%)`。三个分量都取整——CSS 不需要那么多小数。 */
export function hslCss(hsl: Hsl): string {
  return `hsl(${Math.round(hsl.h)},${Math.round(hsl.s)}%,${Math.round(hsl.l)}%)`;
}

/** 夹到区间。深浅派生时防止某一族滑到纯黑或纯白（那时候颜色就没有区分度了）。 */
export function clampNumber(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}
