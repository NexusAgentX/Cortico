/**
 * Browser preference overrides the server's language stamp. Strings are selected at
 * module load time; changing the preference requires a page reload.
 */
import type { Language } from '../../../core/language.ts';

export type { Language };

const STORAGE_KEY = 'cortico.console.language';

export function saveLanguage(language: Language, storage: Pick<Storage, 'setItem'>): void {
  storage.setItem(STORAGE_KEY, language);
}

export function readLanguage(doc: Document): Language {
  let preference: string | null = null;
  try {
    preference = doc.defaultView?.localStorage.getItem(STORAGE_KEY) ?? null;
  } catch {
    // Storage may be unavailable in private browsing; retain the server default.
  }
  const language = preference === 'zh' || preference === 'en'
    ? preference
    : doc.documentElement.lang.toLowerCase().startsWith('en') ? 'en' : 'zh';
  doc.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  return language;
}

function readStamp(): Language {
  try {
    return readLanguage(document);
  } catch {
    return 'zh';
  }
}

export const LANGUAGE: Language = readStamp();

/** Select one language's table; declare tables as `zh` plus `en: typeof zh`. */
export function pick<T>(table: { readonly zh: T; readonly en: T }): T {
  return LANGUAGE === 'en' ? table.en : table.zh;
}
