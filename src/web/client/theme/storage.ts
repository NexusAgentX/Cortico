/**
 * 主题存档的读写 —— 本机 `localStorage` 里那一条记录。
 *
 * **记录形状必须与迁移前一字不差**:`StoredTheme` 的字段全部照抄,新增字段只能是可选的、
 * 缺省不改变行为的。键名换过一次(见 `LEGACY_THEME_STORAGE_KEY`),所以读路径认两个键——
 * 裸换键名就是"升级一次控制台,配色回到出厂",而且是静默的,因为旧记录还在,只是没人再读它。
 *
 * 这里同样不碰 DOM：拿 `ThemeStorageLike` 收存储后端，测试喂一个 Map 即可，
 * 无痕模式喂 `null`。
 */

import {
  BUILTIN_SCHEMES,
  DEFAULT_SCHEME_ID,
  THEME_MODES,
  cloneScheme,
  fallbackPalette,
  normalizePalette,
  type ThemeMode,
  type ThemeScheme,
} from './registry.ts';
import { S } from './strings.ts';

/** 存档键。`cortico.` 是产品前缀。 */
export const THEME_STORAGE_KEY = 'cortico.theme.v1';

/**
 * 产品改名前的存档键(那时整个仓库叫 `xuewu-bot`,这个前缀是产品名不是人格名)。
 * 只在读路径上还认:读到它就把记录搬到新键。**旧记录留在原地不删**,这样回退到
 * 旧版本的控制台仍读得到自己的配色。
 */
export const LEGACY_THEME_STORAGE_KEY = 'xuewu.theme-studio.v1';

/** `localStorage` 的最小面。只要这两个方法，测试与降级都好造。 */
export interface ThemeStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface StoredTheme {
  /** 选中的方案 id（可能指向一个已被删掉的自定义方案，取用时再兜底）。 */
  selectedId: string;
  mode: ThemeMode;
  /** 本机自定义方案。内置方案不进存档。 */
  custom: ThemeScheme[];
}

export function defaultStoredTheme(): StoredTheme {
  return { selectedId: DEFAULT_SCHEME_ID, mode: 'system', custom: [] };
}

/**
 * 存档里的一条自定义方案 → 规范形状；认不出给 `null`（调用方 filter 掉）。
 *
 * 长度上限（名 40 / 说明 80）与迁移前一致：这条记录是用户可编辑的，没有上限时
 * 一段几 MB 的粘贴就能把整条存档撑爆，而 `localStorage` 满了是**静默失败**。
 */
function normalizeCustomScheme(raw: unknown): ThemeScheme | null {
  if (!raw || typeof raw !== 'object') return null;
  const scheme = raw as Partial<ThemeScheme>;
  if (typeof scheme.id !== 'string' || scheme.id === '') return null;
  const palettes = (scheme.palettes ?? {}) as Partial<ThemeScheme['palettes']>;
  return {
    id: scheme.id,
    name: String(scheme.name ?? S.customScheme).slice(0, 40),
    note: String(scheme.note ?? S.customNote).slice(0, 80),
    palettes: {
      light: normalizePalette(palettes.light, fallbackPalette('light')),
      dark: normalizePalette(palettes.dark, fallbackPalette('dark')),
    },
    custom: true,
  };
}

/**
 * 存档正文 → `StoredTheme`。**任何坏数据都退回默认值，绝不抛**：主题是首屏第一步，
 * 这里抛一次异常就是整页白屏，而起因可能只是别的标签页写坏了一个字节。
 */
export function parseStoredTheme(raw: string | null | undefined): StoredTheme {
  if (raw == null || raw === '') return defaultStoredTheme();
  try {
    const parsed = JSON.parse(raw) as Partial<StoredTheme> | null;
    if (!parsed || typeof parsed !== 'object') return defaultStoredTheme();
    return {
      selectedId: typeof parsed.selectedId === 'string' ? parsed.selectedId : DEFAULT_SCHEME_ID,
      mode: THEME_MODES.includes(parsed.mode as ThemeMode) ? (parsed.mode as ThemeMode) : 'system',
      custom: Array.isArray(parsed.custom)
        ? parsed.custom.map(normalizeCustomScheme).filter((s): s is ThemeScheme => s !== null)
        : [],
    };
  } catch {
    return defaultStoredTheme();
  }
}

export function readStoredTheme(storage: ThemeStorageLike | null | undefined): StoredTheme {
  if (!storage) return defaultStoredTheme();
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    if (raw != null && raw !== '') return parseStoredTheme(raw);
    const legacy = storage.getItem(LEGACY_THEME_STORAGE_KEY);
    if (legacy == null || legacy === '') return defaultStoredTheme();
    // 搬到新键。写不进去(无痕/配额满)也不影响这一轮:返回值仍是读出来的那份。
    const state = parseStoredTheme(legacy);
    writeStoredTheme(storage, state);
    return state;
  } catch {
    // 无痕模式下连 getItem 都会抛。
    return defaultStoredTheme();
  }
}

/**
 * 写回。返回是否真写进去了——**写不进去不是错误**（无痕、配额满），这一轮的选择
 * 仍然生效，只是下次打开回到上一次的存档。调用方要提示时才看返回值。
 */
export function writeStoredTheme(
  storage: ThemeStorageLike | null | undefined,
  state: StoredTheme,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(THEME_STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/**
 * 取浏览器的 `localStorage`。**经 `doc.defaultView` 而不是全局 `window`**：
 * 这样离屏文档与测试里的假文档各用各的，模块顶层也就不需要认识任何全局。
 * 沙箱 iframe 里连读这个属性都会抛，所以整段包在 try 里，拿不到就是 `null`。
 */
export function browserThemeStorage(doc: Document): ThemeStorageLike | null {
  try {
    return doc.defaultView?.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 全部内置方案的副本（带 `builtin` 标）。存档里没有它们，每次现取。 */
export function builtinSchemes(): ThemeScheme[] {
  return BUILTIN_SCHEMES.map((scheme) => ({ ...cloneScheme(scheme), builtin: true }));
}
