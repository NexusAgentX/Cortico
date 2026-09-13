import { LANGUAGE, saveLanguage, type Language } from '../../core/language.ts';
import type { FeatureContext } from '../feature.ts';
import { S } from './strings.ts';

export function mountGeneral(ctx: FeatureContext): void {
  const { ui, root, signal } = ctx;
  const win = root.ownerDocument.defaultView!;
  const group = ui.h('div');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', S.language);
  root.append(ui.h('h3', null, S.language), ui.h('p', null, S.languageDesc), group);
  for (const [language, label] of [['zh', '简体中文'], ['en', 'English']] as const) {
    const button = ui.h('button', 'btn', label);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(language === LANGUAGE));
    button.disabled = language === LANGUAGE;
    button.addEventListener('click', () => { void changeLanguage(language).catch(ctx.onError); }, { signal });
    group.append(button);
  }

  async function changeLanguage(language: Language): Promise<void> {
    if (!await ui.confirm({ title: S.reloadTitle, body: S.reloadBody }) || signal.aborted) return;
    saveLanguage(language, win.localStorage);
    win.location.reload();
  }
}
