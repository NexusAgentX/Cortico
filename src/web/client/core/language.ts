/**
 * The console's language on the browser side. The server stamps `<html lang>` when it
 * serves the page, so the value is known synchronously at import time and framework
 * pages can pick their strings at module scope. Without a stamp (tests, a bare file)
 * the console is Chinese.
 */
import type { Language } from '../../../core/language.ts';

export type { Language };

function readStamp(): Language {
  try {
    const tag = (globalThis as { document?: { documentElement?: { lang?: string } } })
      .document?.documentElement?.lang ?? '';
    return tag.toLowerCase().startsWith('en') ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

export const LANGUAGE: Language = readStamp();

/** Select one language's table; declare tables as `zh` plus `en: typeof zh`. */
export function pick<T>(table: { readonly zh: T; readonly en: T }): T {
  return LANGUAGE === 'en' ? table.en : table.zh;
}
