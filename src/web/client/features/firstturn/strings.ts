import { pick } from '../../core/language.ts';

const zh = {
  title: '首轮对话',
  desc: '预写的第一轮 user / assistant 来回(含思维链),发请求时插在系统前缀之后、真实历史之前,'
    + '用来锚定语言风格。**只进请求,不落盘**——落盘历史与记忆里没有它;'
    + '任一空着(用户输入或回复)整轮就不注入。写作提醒:它在每次交接后仍然在场,'
    + '别写"这是我们第一次说话"这类会随时间穿帮的句子。',
  loading: '加载中…',
  loadFailed: (msg: string) => `加载失败: ${msg}`,
  noSources: '这个Persona没有提供首轮对话源。',
  enable: '启用注入(内容为空时开着也不注入)',
  enabledNote: '已开启——下一次请求生效',
  disabledNote: '已关闭——下一次请求即不再注入',
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
  desc: 'A pre-written first user / assistant exchange (with reasoning), inserted after the system prefix and before the real history on every request'
    + ' to anchor the language style. **Request-only, never persisted to disk** — persisted history and memory do not contain it;'
    + ' if either side (user input or reply) is empty the whole turn is not injected. Writing note: it stays present after every handoff,'
    + ' so avoid sentences like "this is the first time we talk" that stop being true over time.',
  loading: 'Loading…',
  loadFailed: (msg: string) => `Load failed: ${msg}`,
  noSources: 'This Persona provides no first-turn sources.',
  enable: 'Enable injection (nothing is injected while the content is empty, even when on)',
  enabledNote: 'Enabled — takes effect on the next request',
  disabledNote: 'Disabled — no longer injected from the next request',
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
