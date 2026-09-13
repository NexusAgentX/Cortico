/**
 * 表单控件：`input` / `select` / `textarea` / `checkbox` / `segmented`，外加把标签与
 * 控件绑成一行的 `field`。
 *
 * 前三者在 `styles.css` 里共用同一个 class `.field`（`input.field, select.field` 一条、
 * `textarea.field` 一条），焦点态也已经写好（`:focus { border-color: var(--accent) }`）；
 * `checkbox` 复用既有的 `label.check`；`segmented` 复用既有的 `.segwrap` / `.seg`。
 * 只有 `field` 的两个 class 是新追加的（`styles.css` 里本来没有表单标签这一档）。
 *
 * 为什么值变化的回调也要走原语：扩展自己 `el.addEventListener('input', …)` 是合法的，
 * 但那条监听不带 `signal`，面板卸了它还在（闭包顺带钉住整棵旧 DOM）。原语把 `signal`
 * 一并挂上，扩展就没有理由自己去装监听。
 */

import type {
  ConsoleCheckbox,
  ConsoleCheckboxOptions,
  ConsoleFieldOptions,
  ConsoleInputOptions,
  ConsoleSegmented,
  ConsoleSegmentedOptions,
  ConsoleSelectOptions,
  ConsoleTextareaOptions,
} from '../../shared/client-panel.ts';
import { h } from './dom.ts';

/** `field` + 调用方追加的 class（如 `mono` / `grow`） */
function fieldClass(extra?: string): string {
  return extra ? 'field ' + extra : 'field';
}

/**
 * 三者共通的收尾：初值、禁用、三个时刻的回调。
 * （`placeholder` 不在这儿——`<select>` 压根没有这个属性，由两个有的自己设。）
 *
 * `event` 是 `onInput` 该听哪个事件：能逐次击键的听 `input`，`<select>` 只有 `change`。
 * `onChange` 一律听 `change`，`onCommit` 一律听 `keydown`——三条各挂各的，谁都不替谁
 * 兜底（原语替调用方猜"这次算不算提交"，猜错时扩展连改都没处改）。
 */
function wire(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  signal: AbortSignal,
  opts: ConsoleFieldOptions,
  event: 'input' | 'change',
): void {
  if (opts.value != null) el.value = opts.value;
  if (opts.disabled) el.disabled = true;
  const onInput = opts.onInput;
  if (onInput) el.addEventListener(event, () => onInput(el.value), { signal });
  const onChange = opts.onChange;
  if (onChange) el.addEventListener('change', () => onChange(el.value), { signal });
  const onCommit = opts.onCommit;
  if (onCommit) {
    // 形参写成 `Event` 再收窄:`el` 是三种控件的联合类型,它的 `addEventListener`
    // 只剩下不带事件名类型推导的那条通用重载(TS 对联合方法取的是签名的交集),
    // 直接写 `(ev: KeyboardEvent)` 会被判成不兼容。
    el.addEventListener(
      'keydown',
      (ev: Event) => {
        if (isCommitKey(el, ev as KeyboardEvent)) onCommit(el.value);
      },
      { signal },
    );
  }
}

/**
 * 判断 Enter 是否提交：IME composition 期间只选词；textarea 裸 Enter 换行，Ctrl/⌘+Enter 提交。
 */
function isCommitKey(el: { tagName: string }, ev: KeyboardEvent): boolean {
  if (ev.key !== 'Enter' || ev.isComposing) return false;
  if (el.tagName.toLowerCase() !== 'textarea') return true;
  return ev.ctrlKey || ev.metaKey;
}

/** 单行输入。缺省 `type=text`。 */
export function input(
  doc: Document,
  signal: AbortSignal,
  opts?: ConsoleInputOptions,
): HTMLInputElement {
  const o = opts ?? {};
  const el = h(doc, 'input', fieldClass(o.cls));
  el.type = o.type ?? 'text';
  if (o.placeholder != null) el.placeholder = o.placeholder;
  wire(el, signal, o, 'input');
  return el;
}

/**
 * 下拉选择。选项给字符串等价于 `{ value: s, label: s }`。
 *
 * 注意顺序：**先填 option 再设 value**。反过来的话浏览器会把不存在的值丢掉，
 * 结果是"明明传了 value，选中的却是第一项"——这是选择框最常见的那个假 bug。
 */
export function select(
  doc: Document,
  signal: AbortSignal,
  opts?: ConsoleSelectOptions,
): HTMLSelectElement {
  const o = opts ?? {};
  const el = h(doc, 'select', fieldClass(o.cls));
  for (const raw of o.options ?? []) {
    const item = typeof raw === 'string' ? { value: raw, label: raw } : raw;
    const opt = h(doc, 'option', null, item.label ?? item.value);
    opt.value = item.value;
    el.appendChild(opt);
  }
  wire(el, signal, o, 'change');
  return el;
}

/** 多行输入。`rows` 缺省交给 CSS 的 `min-height`。 */
export function textarea(
  doc: Document,
  signal: AbortSignal,
  opts?: ConsoleTextareaOptions,
): HTMLTextAreaElement {
  const o = opts ?? {};
  const el = h(doc, 'textarea', fieldClass(o.cls));
  if (o.rows != null) el.rows = o.rows;
  if (o.placeholder != null) el.placeholder = o.placeholder;
  wire(el, signal, o, 'input');
  return el;
}

/**
 * 勾选框采用 label.check > input[type=checkbox] + span。文本单独放入 span，使 inline-flex 的 gap 在控件与整段文本之间一致生效。
 */
export function checkbox(
  doc: Document,
  signal: AbortSignal,
  label: string,
  opts?: ConsoleCheckboxOptions,
): ConsoleCheckbox {
  const o = opts ?? {};
  const el = h(doc, 'label', 'check');
  const box = h(doc, 'input');
  box.type = 'checkbox';
  if (o.checked) box.checked = true;
  if (o.disabled) box.disabled = true;
  if (o.title) el.title = o.title;
  el.append(box, h(doc, 'span', null, label));
  const cb = o.onChange;
  if (cb) box.addEventListener('change', () => cb(box.checked), { signal });
  return {
    el,
    input: box,
    get checked(): boolean {
      return box.checked;
    },
    // 只改值不发事件:`change` 本来就只在用户动作时派发,这里手动补一发的话,
    // "保存失败回滚成旧值"会立刻把回滚本身当成一次新的用户改动再存一遍。
    setChecked(v: boolean): void {
      box.checked = v;
    },
  };
}

/**
 * 字段标签 + 控件。控件嵌在 `<label>` 里，点标签即聚焦控件（不必配 `for`/`id`，
 * 扩展也就不必发明一套全局唯一的 id）。
 */
export function field(doc: Document, label: string, control: HTMLElement): HTMLLabelElement {
  const el = h(doc, 'label', 'fieldrow');
  el.append(h(doc, 'span', 'fieldlabel', label), control);
  return el;
}

/**
 * 分段选择器。
 *
 * 选中态记在闭包里、由 `paint()` 统一刷 class——不去读 DOM 反推当前值（那样一来
 * "当前选中的是谁"就有了两份真相，`setValue` 与用户点击各改一份）。
 *
 * 按 value 存一个数组而不是 Map：items 里出现重复 value 时，Map 会把先来的那颗
 * 丢掉，之后 `paint()` 就再也刷不到它——一颗永远亮着的死键。
 */
export function segmented(
  doc: Document,
  signal: AbortSignal,
  items: readonly (string | { value: string; label?: string })[],
  opts?: ConsoleSegmentedOptions,
): ConsoleSegmented {
  const o = opts ?? {};
  const el = h(doc, 'div', o.size === 'sm' ? 'segwrap sm' : 'segwrap');
  const keys: { value: string; btn: HTMLButtonElement }[] = [];
  let current = o.value ?? '';
  const paint = (): void => {
    for (const k of keys) k.btn.className = k.value === current ? 'seg active' : 'seg';
  };

  for (const raw of items) {
    const item = typeof raw === 'string' ? { value: raw, label: raw } : raw;
    const btn = h(doc, 'button', 'seg', item.label ?? item.value);
    btn.type = 'button';
    keys.push({ value: item.value, btn });
    btn.addEventListener(
      'click',
      () => {
        // 点已经选中的那颗:不回调。onSelect 后面挂的常是一次重新取数,
        // 白刷一遍不只是浪费,还会把用户刚滚到的位置弹回去。
        if (current === item.value) return;
        current = item.value;
        paint();
        o.onSelect?.(item.value);
      },
      { signal },
    );
    el.appendChild(btn);
  }
  paint();

  return {
    el,
    get value(): string {
      return current;
    },
    setValue(v: string): void {
      current = v;
      paint();
    },
  };
}
