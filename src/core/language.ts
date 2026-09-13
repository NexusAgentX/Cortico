/**
 * Console language: a deployment fact, read once per process.
 *
 * Precedence: `language` in `config.json` when it names a known language, then the
 * `CORTICO_LANGUAGE` environment variable, then the system locale, where anything that is
 * not Chinese counts as English. The value reaches IO worlds through `WorldContext`
 * and console extensions through `ConsolePanelContext`; each owner decides whether to carry
 * a second language at all, and a missing translation falls back to the owner's Chinese.
 *
 * Model-facing text is outside this value's reach: prompt templates and persona content
 * carry their own language, and the core's own context markers are fixed English.
 */
export type Language = 'zh' | 'en';

export const LANGUAGES: readonly Language[] = ['zh', 'en'];

export function isLanguage(value: unknown): value is Language {
  return value === 'zh' || value === 'en';
}

/** BCP 47 / POSIX tag → language. Empty input is "unknown", not English. */
export function languageOfLocale(tag: string | null | undefined): Language | undefined {
  const t = (tag ?? '').trim().toLowerCase();
  if (!t) return undefined;
  return t === 'zh' || t.startsWith('zh-') || t.startsWith('zh_') ? 'zh' : 'en';
}

/** Pure form of the system read, for tests. */
export function detectLanguage(
  env: Record<string, string | undefined>,
  locale: string | null | undefined,
): Language {
  const forced = env.CORTICO_LANGUAGE;
  if (isLanguage(forced)) return forced;
  return languageOfLocale(locale) ?? 'zh';
}

let systemMemo: Language | undefined;

/** The environment/locale read, performed once and then fixed for the process lifetime. */
export function systemLanguage(): Language {
  if (systemMemo === undefined) {
    // `process` is reached through globalThis so this file also type-checks under the DOM lib.
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    let locale: string | undefined;
    try {
      locale = Intl.DateTimeFormat().resolvedOptions().locale;
    } catch {
      locale = undefined;
    }
    systemMemo = detectLanguage(env, locale);
  }
  return systemMemo;
}

/** A configured value wins over the system read; anything unrecognised is ignored. */
export function resolveLanguage(configured: unknown): Language {
  return isLanguage(configured) ? configured : systemLanguage();
}

/**
 * Select one language's table. Tables are plain objects declared as `zh` plus
 * `en: typeof zh`, so the compiler holds the two key sets equal.
 */
export function pick<T>(language: Language, table: { readonly zh: T; readonly en: T }): T {
  return language === 'en' ? table.en : table.zh;
}
