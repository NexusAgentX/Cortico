/** localStorage 主题记录；兼容旧键和既有记录字段，读取失败时返回默认值。 */

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

/** 兼容旧存储键；读到后复制到新键，保留旧记录。 */
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

export function defaultStoredTheme(defaultSchemeId: string = DEFAULT_SCHEME_ID): StoredTheme {
  return { selectedId: defaultSchemeId, mode: 'system', custom: [] };
}

/** 规范化自定义方案；名称上限 40 字、说明上限 80 字，非法记录返回 null。 */
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

/** 解析 StoredTheme；非法数据返回默认值，不抛错。 */
export function parseStoredTheme(
  raw: string | null | undefined,
  defaultSchemeId: string = DEFAULT_SCHEME_ID,
): StoredTheme {
  if (raw == null || raw === '') return defaultStoredTheme(defaultSchemeId);
  try {
    const parsed = JSON.parse(raw) as Partial<StoredTheme> | null;
    if (!parsed || typeof parsed !== 'object') return defaultStoredTheme(defaultSchemeId);
    return {
      selectedId: typeof parsed.selectedId === 'string' ? parsed.selectedId : defaultSchemeId,
      mode: THEME_MODES.includes(parsed.mode as ThemeMode) ? (parsed.mode as ThemeMode) : 'system',
      custom: Array.isArray(parsed.custom)
        ? parsed.custom.map(normalizeCustomScheme).filter((s): s is ThemeScheme => s !== null)
        : [],
    };
  } catch {
    return defaultStoredTheme(defaultSchemeId);
  }
}

export function readStoredTheme(
  storage: ThemeStorageLike | null | undefined,
  defaultSchemeId: string = DEFAULT_SCHEME_ID,
): StoredTheme {
  if (!storage) return defaultStoredTheme(defaultSchemeId);
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    if (raw != null && raw !== '') return parseStoredTheme(raw, defaultSchemeId);
    const legacy = storage.getItem(LEGACY_THEME_STORAGE_KEY);
    if (legacy == null || legacy === '') return defaultStoredTheme(defaultSchemeId);
    // 写入新键失败时仍返回已读取的记录。
    const state = parseStoredTheme(legacy, defaultSchemeId);
    writeStoredTheme(storage, state);
    return state;
  } catch {
    // 存储访问可能被拒绝。
    return defaultStoredTheme(defaultSchemeId);
  }
}

/** 返回写入是否成功。失败时当前选择仍有效，下次加载使用上次已保存记录。 */
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

/** 使用文档所属窗口的 localStorage；属性访问被拒绝或不可用时返回 null。 */
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
