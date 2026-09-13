import type { ConsoleUi } from '../../shared/client-panel.ts';

/** 页面身份区。每个常规页面只放一个，后续 section 从它建立阅读层级。 */
export function pageIntro(ui: Pick<ConsoleUi, 'h'>, title: string, description: string): HTMLElement {
  const intro = ui.h('header', 'featureintro');
  intro.append(
    ui.h('h1', 'pagetitle', title),
    ui.h('p', 'pagedesc', description),
  );
  return intro;
}
