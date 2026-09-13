/**
 * 内核自带的面板实现。键就是 `ConsolePanelDecl.builtin` 的取值。
 *
 * 这张表里的面板不属于任何一页:声明它的可以是仓库里的内建贡献方,也可以是装在
 * `extensions/` 下的外部 npm 包——后者拿不到框架的浏览器代码,所以凡是"每一页长得
 * 一样"的面板都必须由内核提供,而不是由每份产物各打一遍。
 *
 * 收进这里的判据只有一条:**这块面板不需要知道是哪一页在用它**。要改一行才能
 * 支持下一个贡献方的面板不属于这里,它归那一页自己的扩展。
 */

import type { ConsolePanel } from '../../shared/client-panel.ts';
import { llmSettingsPanel } from './builtins/llm-settings/panel.ts';

export type BuiltinPanels = Readonly<Record<string, ConsolePanel>>;

export const BUILTIN_PANELS: BuiltinPanels = {
  'llm-settings': llmSettingsPanel,
};
