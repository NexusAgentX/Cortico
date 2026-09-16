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

/**
 * 大面积 token（`paper*`、`sheet*`、`agent-surface`、`world-bg`、`bubble-bg`）一律取中性灰，
 * 方案的色相只出现在 `accent`、状态色、时间线标记与图表系列这些小块上。
 */
const mintLight: ThemePalette = {
  paper: '#f4f5f4', 'paper-2': '#ecedec', sheet: '#fbfbfb', 'sheet-2': '#f2f3f2', 'sheet-3': '#e8e9e8',
  ink: '#1b1a1e', 'ink-soft': '#5c5c60', 'ink-dim': '#8b8b8f', line: '#e3e4e3', 'line-2': '#d0d2d0', 'line-strong': '#aeb0ae',
  accent: '#00a870', 'accent-2': '#00815a', 'on-accent': '#ffffff', ok: '#1f7a57', warn: '#a0762a', danger: '#bc4f43',
  'ink-blue': '#41727a', violet: '#6b5a8c', 'agent-surface': '#f4f5f4', 'world-bg': '#f0f1f0', 'world-ink': '#4a4a4e',
  'bubble-bg': '#e6e9e7', 'bubble-ink': '#1f2221', 'tool-result': '#1f7a57',
  'chart-hit': '#00a870', 'chart-miss': '#a0762a', 'chart-output': '#41727a',
  'chart-1': '#00a870', 'chart-2': '#41727a', 'chart-3': '#6b5a8c', 'chart-4': '#4c8f3e',
  'chart-5': '#c2803c', 'chart-6': '#b04f6a', 'chart-7': '#3f8f8a', 'chart-8': '#7a8b2f',
};

const mintDark: ThemePalette = {
  paper: '#121312', 'paper-2': '#181a19', sheet: '#1d1f1e', 'sheet-2': '#242726', 'sheet-3': '#2c302e',
  ink: '#e9eae9', 'ink-soft': '#b0b2b1', 'ink-dim': '#828584', line: '#292c2b', 'line-2': '#383c3a', 'line-strong': '#535856',
  accent: '#2fd59b', 'accent-2': '#1fa87a', 'on-accent': '#062018', ok: '#5fd0a6', warn: '#d4a862', danger: '#e2857b',
  'ink-blue': '#7ab8c0', violet: '#a897c6', 'agent-surface': '#181a19', 'world-bg': '#1e211f', 'world-ink': '#adb2b0',
  'bubble-bg': '#2c3230', 'bubble-ink': '#e6eae8', 'tool-result': '#5fd0a6',
  'chart-hit': '#2fd59b', 'chart-miss': '#d4a862', 'chart-output': '#7ab8c0',
  'chart-1': '#2fd59b', 'chart-2': '#7ab8c0', 'chart-3': '#a897c6', 'chart-4': '#94cf6f',
  'chart-5': '#e0a877', 'chart-6': '#e08aa3', 'chart-7': '#5fc9c2', 'chart-8': '#c2cf6f',
};

const navigatorLight: ThemePalette = {
  paper: '#f3f4f6', 'paper-2': '#eaecef', sheet: '#fbfbfc', 'sheet-2': '#f1f2f5', 'sheet-3': '#e6e8ec',
  ink: '#1c1f24', 'ink-soft': '#565c66', 'ink-dim': '#868c95', line: '#e2e4e8', 'line-2': '#ced2d8', 'line-strong': '#aab0b9',
  accent: '#2f5d94', 'accent-2': '#6591c3', 'on-accent': '#ffffff', ok: '#2f8f7a', warn: '#b8862f', danger: '#c2544f',
  'ink-blue': '#3f7fb8', violet: '#6b6a9c', 'agent-surface': '#f3f4f6', 'world-bg': '#eff0f3', 'world-ink': '#474c55',
  'bubble-bg': '#e5e7ec', 'bubble-ink': '#1d2026', 'tool-result': '#2f7d6a',
  'chart-hit': '#2f8f7a', 'chart-miss': '#b8862f', 'chart-output': '#2f5d94',
  'chart-1': '#2f5d94', 'chart-2': '#4aa3d8', 'chart-3': '#b8862f', 'chart-4': '#2f8f7a',
  'chart-5': '#6591c3', 'chart-6': '#a8628f', 'chart-7': '#5e6b7d', 'chart-8': '#3fa8b8',
};

const navigatorDark: ThemePalette = {
  paper: '#111316', 'paper-2': '#16191d', sheet: '#1b1f23', 'sheet-2': '#22262c', 'sheet-3': '#2a2f36',
  ink: '#e8eaee', 'ink-soft': '#adb3bb', 'ink-dim': '#80878f', line: '#272b31', 'line-2': '#363c44', 'line-strong': '#505760',
  accent: '#81c9ef', 'accent-2': '#d8aa5d', 'on-accent': '#0a1826', ok: '#5fc9a8', warn: '#d8aa5d', danger: '#e58a84',
  'ink-blue': '#6bb8e8', violet: '#a79ed6', 'agent-surface': '#16191d', 'world-bg': '#1c2024', 'world-ink': '#abb1b9',
  'bubble-bg': '#2a2f36', 'bubble-ink': '#e8eaee', 'tool-result': '#7fd8bb',
  'chart-hit': '#5fc9a8', 'chart-miss': '#d8aa5d', 'chart-output': '#81c9ef',
  'chart-1': '#81c9ef', 'chart-2': '#d8aa5d', 'chart-3': '#6591c3', 'chart-4': '#5fc9a8',
  'chart-5': '#f0b8bf', 'chart-6': '#a79ed6', 'chart-7': '#8fa8bf', 'chart-8': '#5fd0d8',
};

const crabDaisyLight: ThemePalette = {
  paper: '#faf9f5', 'paper-2': '#f2f1ec', sheet: '#ffffff', 'sheet-2': '#f5f4f0', 'sheet-3': '#edece6',
  ink: '#1f1e1c', 'ink-soft': '#5c5b57', 'ink-dim': '#8c8a84', line: '#e7e5de', 'line-2': '#d6d3ca', 'line-strong': '#b6b2a8',
  accent: '#d97757', 'accent-2': '#b8532f', 'on-accent': '#ffffff', ok: '#4f7a52', warn: '#b1832e', danger: '#bc4c3f',
  'ink-blue': '#5a6e7a', violet: '#7b6a88', 'agent-surface': '#faf9f5', 'world-bg': '#f4f3ee', 'world-ink': '#5b574e',
  'bubble-bg': '#eeece5', 'bubble-ink': '#2b2926', 'tool-result': '#4f7a52',
  'chart-hit': '#4f7a52', 'chart-miss': '#b1832e', 'chart-output': '#d97757',
  'chart-1': '#d97757', 'chart-2': '#5a6e7a', 'chart-3': '#7b6a88', 'chart-4': '#4f7a52',
  'chart-5': '#c9a227', 'chart-6': '#b1832e', 'chart-7': '#8a8577', 'chart-8': '#6b93a3',
};

const crabDaisyDark: ThemePalette = {
  paper: '#1a1a18', 'paper-2': '#21211f', sheet: '#262624', 'sheet-2': '#2e2e2b', 'sheet-3': '#383733',
  ink: '#f5f4ef', 'ink-soft': '#bdbbb3', 'ink-dim': '#8d8b84', line: '#33322f', 'line-2': '#45443f', 'line-strong': '#605e57',
  accent: '#e08768', 'accent-2': '#c96a49', 'on-accent': '#1f130e', ok: '#8fb07f', warn: '#d7ad63', danger: '#e08a7c',
  'ink-blue': '#93a9b5', violet: '#b6a3c2', 'agent-surface': '#21211f', 'world-bg': '#282723', 'world-ink': '#b5b1a7',
  'bubble-bg': '#36342f', 'bubble-ink': '#f0eee7', 'tool-result': '#9fc48e',
  'chart-hit': '#8fb07f', 'chart-miss': '#d7ad63', 'chart-output': '#e08768',
  'chart-1': '#e08768', 'chart-2': '#93a9b5', 'chart-3': '#b6a3c2', 'chart-4': '#8fb07f',
  'chart-5': '#e6c759', 'chart-6': '#d7ad63', 'chart-7': '#a8a396', 'chart-8': '#82aec2',
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
