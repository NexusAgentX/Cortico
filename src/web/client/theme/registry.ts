/** 主题 token、分组、内置调色板与纯函数。存储由 storage.ts、DOM 应用由 palette.ts、可变状态由 studio.ts 提供。 */

import { S } from './strings.ts';

export type ThemeMode = 'light' | 'dark' | 'system';

/** `system` 解析之后只剩两种。CSS 变量真正落地时看的是这个。 */
export type ThemeAppearance = 'light' | 'dark';

export interface ThemeToken {
  /** 编辑器里的分组标题 */
  readonly group: string;
  /** CSS 变量名去掉 `--` 前缀，如 `paper` → `--paper` */
  readonly key: string;
  /** 编辑器里的中文标签 */
  readonly label: string;
}

/** token key → `#rrggbb`。缺格由 `normalizePalette` 用回退表补齐。 */
export type ThemePalette = Record<string, string>;

export interface ThemeScheme {
  id: string;
  name: string;
  note: string;
  /** 浅色与黑夜是**两份独立配色**，不是同一份的明暗算法推导。 */
  palettes: Record<ThemeAppearance, ThemePalette>;
  builtin?: boolean;
  custom?: boolean;
}

export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

/** 明暗模式的中文挡位名。分段选择器与提示语共用一套措辞。 */
export const THEME_MODE_LABELS: Readonly<Record<ThemeMode, string>> = {
  light: S.modeLight,
  dark: S.modeDark,
  system: S.modeSystem,
};

/** 提示语里的"当前变体"。`light`/`dark` 两个词全站只在这儿定义一次。 */
export const THEME_APPEARANCE_LABELS: Readonly<Record<ThemeAppearance, string>> = {
  light: S.appearanceLight,
  dark: S.appearanceDark,
};

const T = S.token;

export const THEME_TOKENS: readonly ThemeToken[] = [
  { group: S.groupPaper, key: 'paper', label: T.paper },
  { group: S.groupPaper, key: 'paper-2', label: T['paper-2'] },
  { group: S.groupPaper, key: 'sheet', label: T.sheet },
  { group: S.groupPaper, key: 'sheet-2', label: T['sheet-2'] },
  { group: S.groupPaper, key: 'sheet-3', label: T['sheet-3'] },
  { group: S.groupInk, key: 'ink', label: T.ink },
  { group: S.groupInk, key: 'ink-soft', label: T['ink-soft'] },
  { group: S.groupInk, key: 'ink-dim', label: T['ink-dim'] },
  { group: S.groupInk, key: 'line', label: T.line },
  { group: S.groupInk, key: 'line-2', label: T['line-2'] },
  { group: S.groupInk, key: 'line-strong', label: T['line-strong'] },
  { group: S.groupState, key: 'accent', label: T.accent },
  { group: S.groupState, key: 'accent-2', label: T['accent-2'] },
  { group: S.groupState, key: 'on-accent', label: T['on-accent'] },
  { group: S.groupState, key: 'ok', label: T.ok },
  { group: S.groupState, key: 'warn', label: T.warn },
  { group: S.groupState, key: 'danger', label: T.danger },
  { group: S.groupTimeline, key: 'ink-blue', label: T['ink-blue'] },
  { group: S.groupTimeline, key: 'violet', label: T.violet },
  { group: S.groupTimeline, key: 'agent-surface', label: T['agent-surface'] },
  { group: S.groupTimeline, key: 'world-bg', label: T['world-bg'] },
  { group: S.groupTimeline, key: 'world-ink', label: T['world-ink'] },
  { group: S.groupTimeline, key: 'bubble-bg', label: T['bubble-bg'] },
  { group: S.groupTimeline, key: 'bubble-ink', label: T['bubble-ink'] },
  { group: S.groupTimeline, key: 'tool-result', label: T['tool-result'] },
  { group: S.groupChart, key: 'chart-hit', label: T['chart-hit'] },
  { group: S.groupChart, key: 'chart-miss', label: T['chart-miss'] },
  { group: S.groupChart, key: 'chart-output', label: T['chart-output'] },
  { group: S.groupChart, key: 'chart-1', label: T['chart-1'] },
  { group: S.groupChart, key: 'chart-2', label: T['chart-2'] },
  { group: S.groupChart, key: 'chart-3', label: T['chart-3'] },
  { group: S.groupChart, key: 'chart-4', label: T['chart-4'] },
  { group: S.groupChart, key: 'chart-5', label: T['chart-5'] },
  { group: S.groupChart, key: 'chart-6', label: T['chart-6'] },
  { group: S.groupChart, key: 'chart-7', label: T['chart-7'] },
  { group: S.groupChart, key: 'chart-8', label: T['chart-8'] },
];

/** 主强调取自明暗版 Logo；正文使用加深或调亮的同色系绿色。 */
const mintLight: ThemePalette = {
  paper: '#f4f5f4', 'paper-2': '#ecedec', sheet: '#fbfbfb', 'sheet-2': '#f2f3f2', 'sheet-3': '#e8e9e8',
  ink: '#1b1a1e', 'ink-soft': '#5c5c60', 'ink-dim': '#8b8b8f', line: '#e3e4e3', 'line-2': '#d0d2d0', 'line-strong': '#aeb0ae',
  accent: '#00a870', 'accent-2': '#54b494', 'on-accent': '#082a1e', ok: '#19815e', warn: '#96743b', danger: '#b45950',
  'ink-blue': '#238268', violet: '#25765e', 'agent-surface': '#f4f5f4', 'world-bg': '#f0f1f0', 'world-ink': '#4a4a4e',
  'bubble-bg': '#e6e9e7', 'bubble-ink': '#1f2221', 'tool-result': '#087452',
  'chart-hit': '#19815e', 'chart-miss': '#96743b', 'chart-output': '#00a870',
  'chart-1': '#00a870', 'chart-2': '#54b494', 'chart-3': '#348f86', 'chart-4': '#72967f',
  'chart-5': '#b59564', 'chart-6': '#9b8071', 'chart-7': '#4a8f9a', 'chart-8': '#889460',
};

const mintDark: ThemePalette = {
  paper: '#121312', 'paper-2': '#181a19', sheet: '#1d1f1e', 'sheet-2': '#242726', 'sheet-3': '#2c302e',
  ink: '#e9eae9', 'ink-soft': '#b0b2b1', 'ink-dim': '#828584', line: '#292c2b', 'line-2': '#383c3a', 'line-strong': '#535856',
  accent: '#2fd59b', 'accent-2': '#78cbae', 'on-accent': '#082a1e', ok: '#76ca9f', warn: '#c4a372', danger: '#d18c83',
  'ink-blue': '#53bda0', violet: '#91d8bb', 'agent-surface': '#181a19', 'world-bg': '#1e211f', 'world-ink': '#adb2b0',
  'bubble-bg': '#2c3230', 'bubble-ink': '#e6eae8', 'tool-result': '#75cfa8',
  'chart-hit': '#76ca9f', 'chart-miss': '#c4a372', 'chart-output': '#2fd59b',
  'chart-1': '#2fd59b', 'chart-2': '#78cbae', 'chart-3': '#64b8ad', 'chart-4': '#91b99d',
  'chart-5': '#c4a372', 'chart-6': '#b69b8c', 'chart-7': '#76afb9', 'chart-8': '#a8b17e',
};

const navigatorLight: ThemePalette = {
  paper: '#f3f4f6', 'paper-2': '#eaecef', sheet: '#fbfbfc', 'sheet-2': '#f1f2f5', 'sheet-3': '#e6e8ec',
  ink: '#1c1f24', 'ink-soft': '#565c66', 'ink-dim': '#868c95', line: '#e2e4e8', 'line-2': '#ced2d8', 'line-strong': '#aab0b9',
  accent: '#2f5d94', 'accent-2': '#b8862f', 'on-accent': '#ffffff', ok: '#2f8f7a', warn: '#b8862f', danger: '#c2544f',
  'ink-blue': '#356e9d', violet: '#87601e', 'agent-surface': '#f3f4f6', 'world-bg': '#eff0f3', 'world-ink': '#474c55',
  'bubble-bg': '#e5e7ec', 'bubble-ink': '#1d2026', 'tool-result': '#2f5d94',
  'chart-hit': '#2f8f7a', 'chart-miss': '#b8862f', 'chart-output': '#2f5d94',
  'chart-1': '#2f5d94', 'chart-2': '#4aa3d8', 'chart-3': '#b8862f', 'chart-4': '#2f8f7a',
  'chart-5': '#6591c3', 'chart-6': '#a8628f', 'chart-7': '#5e6b7d', 'chart-8': '#3fa8b8',
};

const navigatorDark: ThemePalette = {
  paper: '#111316', 'paper-2': '#16191d', sheet: '#1b1f23', 'sheet-2': '#22262c', 'sheet-3': '#2a2f36',
  ink: '#e8eaee', 'ink-soft': '#adb3bb', 'ink-dim': '#80878f', line: '#272b31', 'line-2': '#363c44', 'line-strong': '#505760',
  accent: '#81c9ef', 'accent-2': '#d8aa5d', 'on-accent': '#0a1826', ok: '#5fc9a8', warn: '#d8aa5d', danger: '#e58a84',
  'ink-blue': '#81c9ef', violet: '#d8aa5d', 'agent-surface': '#16191d', 'world-bg': '#1c2024', 'world-ink': '#abb1b9',
  'bubble-bg': '#2a2f36', 'bubble-ink': '#e8eaee', 'tool-result': '#81c9ef',
  'chart-hit': '#5fc9a8', 'chart-miss': '#d8aa5d', 'chart-output': '#81c9ef',
  'chart-1': '#81c9ef', 'chart-2': '#d8aa5d', 'chart-3': '#6591c3', 'chart-4': '#5fc9a8',
  'chart-5': '#f0b8bf', 'chart-6': '#a79ed6', 'chart-7': '#8fa8bf', 'chart-8': '#5fd0d8',
};

/** Claude 灰阶配赤陶与灰玫瑰强调色；浅色文字使用同色系的深色。 */
const crabDaisyLight: ThemePalette = {
  paper: '#fcfcfb', 'paper-2': '#f9f9f7', sheet: '#ffffff', 'sheet-2': '#f3f3f0', 'sheet-3': '#f0efec',
  ink: '#0b0b0b', 'ink-soft': '#52514e', 'ink-dim': '#7b7974', line: '#e1e0d9', 'line-2': '#d2d1c7', 'line-strong': '#b4b3a8',
  accent: '#c87c5d', 'accent-2': '#cb7c78', 'on-accent': '#131313', ok: '#006300', warn: '#835100', danger: '#8e2626',
  'ink-blue': '#cb7c78', violet: '#a15d59', 'agent-surface': '#fcfcfb', 'world-bg': '#f3f3f0', 'world-ink': '#52514e',
  'bubble-bg': '#f0efec', 'bubble-ink': '#131313', 'tool-result': '#995b43',
  'chart-hit': '#009300', 'chart-miss': '#a66a00', 'chart-output': '#c87c5d',
  'chart-1': '#c87c5d', 'chart-2': '#cb7c78', 'chart-3': '#7161e0', 'chart-4': '#009300',
  'chart-5': '#c6613f', 'chart-6': '#a66a00', 'chart-7': '#7b7974', 'chart-8': '#c04873',
};

const crabDaisyDark: ThemePalette = {
  paper: '#151515', 'paper-2': '#111111', sheet: '#20201f', 'sheet-2': '#1e1e1d', 'sheet-3': '#2c2c2a',
  ink: '#f0efec', 'ink-soft': '#c3c2b7', 'ink-dim': '#97958d', line: '#383835', 'line-2': '#454442', 'line-strong': '#5f5e5a',
  accent: '#c87c5d', 'accent-2': '#cb7c78', 'on-accent': '#131313', ok: '#91d68b', warn: '#db9300', danger: '#ec7e7e',
  'ink-blue': '#cb7c78', violet: '#cb7c78', 'agent-surface': '#151515', 'world-bg': '#20201f', 'world-ink': '#c3c2b7',
  'bubble-bg': '#2c2c2a', 'bubble-ink': '#f0efec', 'tool-result': '#c87c5d',
  'chart-hit': '#91d68b', 'chart-miss': '#db9300', 'chart-output': '#c87c5d',
  'chart-1': '#c87c5d', 'chart-2': '#cb7c78', 'chart-3': '#a096eb', 'chart-4': '#91d68b',
  'chart-5': '#ec835a', 'chart-6': '#db9300', 'chart-7': '#97958d', 'chart-8': '#e87ba4',
};

/** 存储和部署都没给出可用方案 id 时落到哪一个。 */
export const DEFAULT_SCHEME_ID = 'mint';

export const BUILTIN_SCHEMES: readonly ThemeScheme[] = [
  {
    id: DEFAULT_SCHEME_ID, name: S.schemeMint, note: S.schemeMintNote,
    palettes: { light: mintLight, dark: mintDark },
  },
  {
    id: 'navigator', name: S.schemeNavigator, note: S.schemeNavigatorNote,
    palettes: { light: navigatorLight, dark: navigatorDark },
  },
  {
    id: 'crab-daisy', name: S.schemeCrabDaisy, note: S.schemeCrabDaisyNote,
    palettes: { light: crabDaisyLight, dark: crabDaisyDark },
  },
];

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/** `#rrggbb`（大小写不限）。三位简写**不算**——存储里只留规范形式。 */
export function isHexColor(value: unknown): boolean {
  return /^#[0-9a-f]{6}$/i.test(String(value ?? ''));
}

/**
 * 用户输入 → 规范 `#rrggbb`（小写）；认不出给 `null`。
 *
 * 收 `#abc` 简写是因为手打十六进制的人真会那么写，而 `<input type="color">`
 * 永远吐六位——两边喂进同一个函数，编辑器里就不必分两条路。
 */
export function normalizeHex(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  const short = /^#([0-9a-f]{3})$/i.exec(raw);
  const full = short ? '#' + short[1].split('').map((c) => c + c).join('') : raw;
  return isHexColor(full) ? full.toLowerCase() : null;
}

/** 该明暗变体的兜底调色板（内置首个方案）。 */
export function fallbackPalette(appearance: ThemeAppearance): ThemePalette {
  return appearance === 'dark' ? mintDark : mintLight;
}

/**
 * 逐 token 校验 + 补齐。**只留词表里的键**：存储里混进来的野键不该被原样写回
 * `documentElement`，那等于让本机存档往全站注入任意 CSS 变量。
 */
export function normalizePalette(palette: unknown, fallback: ThemePalette): ThemePalette {
  const src = (palette ?? {}) as Record<string, unknown>;
  const out: ThemePalette = {};
  for (const token of THEME_TOKENS) {
    const value = src[token.key];
    out[token.key] = isHexColor(value) ? String(value).toLowerCase() : fallback[token.key];
  }
  return out;
}

/** 部署给的方案 id；不是内置方案就落到框架默认方案。 */
export function resolveDefaultSchemeId(value: unknown): string {
  const id = String(value ?? '');
  return BUILTIN_SCHEMES.some((scheme) => scheme.id === id) ? id : DEFAULT_SCHEME_ID;
}

export function clonePalette(palette: ThemePalette): ThemePalette {
  return { ...palette };
}

export function cloneScheme(scheme: ThemeScheme): ThemeScheme {
  return {
    ...scheme,
    palettes: {
      light: clonePalette(scheme.palettes.light),
      dark: clonePalette(scheme.palettes.dark),
    },
  };
}

/** 方案卡上那条四格色带：底纸 / 主卡纸 / 主强调 / 一个图表系列色。 */
export function schemeSwatches(scheme: ThemeScheme, appearance: ThemeAppearance): string[] {
  const p = scheme.palettes[appearance];
  return [p.paper, p.sheet, p.accent, p['chart-2']];
}

/**
 * 词表按 `group` 归并，**保持 `THEME_TOKENS` 里的出现顺序**。
 *
 * 编辑器要的就是这个形状；单独拿出来是因为"分组"是这一页唯一有分量的纯逻辑，
 * 而它写在渲染函数里就只能靠看 DOM 来验。
 */
export function groupedThemeTokens(
  tokens: readonly ThemeToken[] = THEME_TOKENS,
): Array<{ group: string; tokens: ThemeToken[] }> {
  const out: Array<{ group: string; tokens: ThemeToken[] }> = [];
  const index = new Map<string, { group: string; tokens: ThemeToken[] }>();
  for (const token of tokens) {
    let bucket = index.get(token.group);
    if (!bucket) {
      bucket = { group: token.group, tokens: [] };
      index.set(token.group, bucket);
      out.push(bucket);
    }
    bucket.tokens.push(token);
  }
  return out;
}
