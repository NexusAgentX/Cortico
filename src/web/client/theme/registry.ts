/**
 * 颜色方案注册表 —— 全站语义颜色的**唯一**词表。
 *
 * 页面组件（终端时间线、状态卡、成本图表）一律只消费 `--<token>` 这些 CSS 变量，
 * 不自己写死颜色；那些变量的名字、分组与内置取值全部在这里。所以"加一个新配色"
 * 是往 `THEME_TOKENS` 加一行 + 往三份内置调色板各补一格，而不是去某个面板里
 * 硬编码一个 `#4c6672`。
 *
 * 这份文件**只有数据与纯函数**：不碰 `document`、不碰 `localStorage`、顶层没有任何
 * 副作用。存取在 `storage.ts`，落到 DOM 在 `palette.ts`，可变状态在 `studio.ts`。
 * 分成四份的理由就是这条——首屏那一步只需要"读 + 应用"，不该顺带把编辑器拖起来。
 */

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

const archiveLight: ThemePalette = {
  paper: '#f7f5ef', 'paper-2': '#efede6', sheet: '#fbfaf6', 'sheet-2': '#f2f0e9', 'sheet-3': '#ebe8df',
  ink: '#33312d', 'ink-soft': '#6f6b63', 'ink-dim': '#918c82', line: '#e5e1d8', 'line-2': '#d7d2c8', 'line-strong': '#bdb6aa',
  accent: '#c15f3c', 'accent-2': '#9b5035', 'on-accent': '#fff8f0', ok: '#58734a', warn: '#9a6d31', danger: '#aa4d43',
  'ink-blue': '#526c72', violet: '#77667f', 'agent-surface': '#f7f5ef', 'world-bg': '#f5eee6', 'world-ink': '#694735',
  'bubble-bg': '#ece6da', 'bubble-ink': '#3c352d', 'tool-result': '#58734a',
  'chart-hit': '#5f7a4c', 'chart-miss': '#a9772a', 'chart-output': '#ab5c30',
  'chart-1': '#ab5c30', 'chart-2': '#4c6672', 'chart-3': '#7a5b86', 'chart-4': '#5f7a4c',
  'chart-5': '#c6845a', 'chart-6': '#a9772a', 'chart-7': '#7d7048', 'chart-8': '#6b8e9e',
};

const archiveDark: ThemePalette = {
  paper: '#1c1a17', 'paper-2': '#24211d', sheet: '#292621', 'sheet-2': '#302c27', 'sheet-3': '#38332d',
  ink: '#eee9df', 'ink-soft': '#bdb5a8', 'ink-dim': '#8f877c', line: '#3a352f', 'line-2': '#4d473e', 'line-strong': '#6b6256',
  accent: '#d9815f', 'accent-2': '#e4a085', 'on-accent': '#241711', ok: '#9db58b', warn: '#d3ad70', danger: '#df8e82',
  'ink-blue': '#9ab4bb', violet: '#b9a7c0', 'agent-surface': '#1c1a17', 'world-bg': '#2d241e', 'world-ink': '#e2bea2',
  'bubble-bg': '#4a4035', 'bubble-ink': '#eee6d9', 'tool-result': '#a4c492',
  'chart-hit': '#86a873', 'chart-miss': '#d0a45e', 'chart-output': '#d88b62',
  'chart-1': '#d88b62', 'chart-2': '#80a7b8', 'chart-3': '#ad94bd', 'chart-4': '#86a873',
  'chart-5': '#e1a47d', 'chart-6': '#d0a45e', 'chart-7': '#b8a56c', 'chart-8': '#82b3c4',
};

const patch = (base: ThemePalette, over: ThemePalette): ThemePalette => ({ ...base, ...over });

/** 存储里认不出方案时落到哪一个。 */
export const DEFAULT_SCHEME_ID = 'archive';

export const BUILTIN_SCHEMES: readonly ThemeScheme[] = [
  {
    id: DEFAULT_SCHEME_ID, name: S.schemeArchive, note: S.schemeArchiveNote,
    palettes: { light: archiveLight, dark: archiveDark },
  },
  {
    id: 'mineral', name: S.schemeMineral, note: S.schemeMineralNote,
    palettes: {
      light: patch(archiveLight, {
        paper: '#e7eaeb', 'paper-2': '#f0f3f4', sheet: '#fbfcfc', 'sheet-2': '#f2f5f5', 'sheet-3': '#e5eaeb',
        ink: '#172025', 'ink-soft': '#58656b', 'ink-dim': '#839097', line: '#d5dcde', 'line-2': '#bdc8cc', 'line-strong': '#93a2a8',
        accent: '#223c49', 'accent-2': '#607985', 'on-accent': '#f5f7f7', 'ink-blue': '#315f74', violet: '#655d80',
        'agent-surface': '#edf4f6', 'world-bg': '#f0f1ed', 'world-ink': '#47534a', 'bubble-bg': '#cbdde4', 'bubble-ink': '#17272e',
      }),
      dark: patch(archiveDark, {
        paper: '#0e1417', 'paper-2': '#131b1f', sheet: '#192226', 'sheet-2': '#202b30', 'sheet-3': '#28353a',
        ink: '#edf2f3', 'ink-soft': '#b4c0c3', 'ink-dim': '#7f9198', line: '#2c3a40', 'line-2': '#40525a', 'line-strong': '#617781',
        accent: '#b9d6e1', 'accent-2': '#85aab8', 'on-accent': '#102027', 'ink-blue': '#91c2d5', violet: '#b1a8d1',
        'agent-surface': '#172a33', 'world-bg': '#222820', 'world-ink': '#c9d5bd', 'bubble-bg': '#8fb8c7', 'bubble-ink': '#102127',
      }),
    },
  },
  {
    id: 'sepia', name: S.schemeSepia, note: S.schemeSepiaNote,
    palettes: {
      light: patch(archiveLight, {
        paper: '#e9e1d3', 'paper-2': '#f2eadc', sheet: '#fffaf0', 'sheet-2': '#f8f0e3', 'sheet-3': '#ece1d0',
        ink: '#281f19', 'ink-soft': '#6d5b4d', 'ink-dim': '#998775', line: '#e0d2bf', 'line-2': '#cdbba4', 'line-strong': '#aa9277',
        accent: '#4d3020', 'accent-2': '#8a684d', 'on-accent': '#fffaf1', warn: '#98621f', danger: '#9d4237',
        'ink-blue': '#526c70', violet: '#735a75', 'agent-surface': '#f2eee6', 'world-bg': '#f5e6d7', 'world-ink': '#68412b',
        'bubble-bg': '#ddc7a8', 'bubble-ink': '#382719',
      }),
      dark: patch(archiveDark, {
        paper: '#17120f', 'paper-2': '#1e1814', sheet: '#261f1a', 'sheet-2': '#2d251f', 'sheet-3': '#362c25',
        ink: '#f3e9dc', 'ink-soft': '#c3b2a1', 'ink-dim': '#8e7c6d', line: '#3b3029', 'line-2': '#54443a', 'line-strong': '#756050',
        accent: '#edcfad', 'accent-2': '#c39c75', 'on-accent': '#24170f', warn: '#d4a05d', danger: '#dc8d80',
        'ink-blue': '#9ab8ba', violet: '#c2a3c1', 'agent-surface': '#272725', 'world-bg': '#302119', 'world-ink': '#e7bf9e',
        'bubble-bg': '#c5a47e', 'bubble-ink': '#2a1d14',
      }),
    },
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
  return appearance === 'dark' ? archiveDark : archiveLight;
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
