/**
 * 最底层的两个 DOM 助手——控制台里所有面板都靠它俩拼 DOM，口径不能有第二套。
 *
 * `h` 收一个 `doc`，因为这个模块**不许在顶层引用 `document`**：那样测试
 * （node 环境）与多实例（未来的 iframe / 离屏文档）都难受。面向扩展的
 * `ConsoleUi.h` 已经把 `doc` 绑好，扩展看不到这个参数。
 */

/** `h(doc, 'div', 'sheet', '文本')` */
export function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  cls?: string | null,
  text?: string | null,
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

/** HTML 转义。只转 `&<>"'` 五个字符。 */
export function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
