import { pick } from '../../core/language.ts';

const zh = {
  title: '首轮对话',
  desc: "预写的 user / assistant 示例对话，可含思维链，用于设定语言风格。启用后每次请求都插入系统前缀之后、实际历史之前，不写入 session 历史或 Memory。用户输入或回复为空时不注入。",
  loading: '加载中…',
  loadFailed: (msg: string) => `加载失败: ${msg}`,
  noSources: '这个Persona没有提供首轮对话源。',
  enable: "启用首轮对话",
  enabledNote: "已开启，下一次请求生效",
  disabledNote: "已关闭，下一次请求不再注入",
  toggleFailed: (msg: string) => `开关保存失败: ${msg}`,
  noChanges: '没有改动。',
  saving: '保存中…',
  saveFailed: (title: string, msg: string) => `${title} 保存失败: ${msg}`,
  savedReload: '已保存。重载前缀后对当前 session 生效。',
  savedNext: '已保存。下一次前缀重建时生效。',
  saveAndReload: '保存并重载前缀',
  reloading: '正在重载…',
  reloaded: '已保存并重载,注入内容已更新',
  reloadFailed: (msg: string) => `重载失败: ${msg}`,
  save: '保存',
};

const en: typeof zh = {
  title: 'First turn',
  desc: "A prewritten user/assistant example, with optional reasoning, that sets the language style. When enabled, each request includes it after the system prefix and before actual history. It is excluded from session history and Memory. Empty user input or reply disables injection.",
  loading: 'Loading…',
  loadFailed: (msg: string) => `Load failed: ${msg}`,
  noSources: 'This Persona provides no first-turn sources.',
  enable: "Enable first turn",
  enabledNote: "Enabled; applies to the next request",
  disabledNote: "Disabled; excluded from the next request",
  toggleFailed: (msg: string) => `Failed to save the switch: ${msg}`,
  noChanges: 'No changes.',
  saving: 'Saving…',
  saveFailed: (title: string, msg: string) => `${title} save failed: ${msg}`,
  savedReload: 'Saved. Takes effect for the current session after the prefix is reloaded.',
  savedNext: 'Saved. Takes effect on the next prefix rebuild.',
  saveAndReload: 'Save and reload prefix',
  reloading: 'Reloading…',
  reloaded: 'Saved and reloaded; injected content updated',
  reloadFailed: (msg: string) => `Reload failed: ${msg}`,
  save: 'Save',
};

export const S = pick({ zh, en });
