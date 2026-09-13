/**
 * `ConsoleUi` 的组装口。host 每挂一个面板就造一个实例，把该面板的 `memo`、生命周期
 * `signal` 与浮层宿主绑进去；扩展拿到的 `ctx.ui` 就是这里的返回值。
 *
 * 为什么要按面板造实例、而不是全局单例：
 *
 * - `foldSheet` 的折叠状态必须落在该面板的 `memo` 命名空间里，两个 provider 用同一个
 *   卡片 id 才不会互相顶掉；
 * - `signal` 是**该面板的**生命周期。浮层与监听都绑在它上面，面板一卸，这个 ui 实例
 *   造出来的所有活物（开着的抽屉、挂起的 confirm、待摘的监听）当场结束。单例做不到
 *   这件事——它不知道现在这句 `toast` 是谁喊的。
 */

import type { ConsoleMemo, ConsoleUi, Disposable } from '../../shared/client-panel.ts';
import { esc, h } from './dom.ts';
import { consoleFormat } from './format.ts';
import { kv, progress, statgrid, stat, table } from './data.ts';
import { checkbox, field, input, segmented, select, textarea } from './fields.ts';
import { copyButton, disable } from './actions.ts';
import { log } from './log.ts';
import { promptInput } from './prompt-input.tsx';
import {
  actions,
  button,
  chip,
  foldSheet,
  msgline,
  pill,
  placeholder,
  rowbar,
  section,
  sheet,
} from './sheet.ts';
import type { Overlay, OverlayEnv } from './overlay.ts';
import { busy, confirm, drawer, noopDisposable, toast } from './overlay.ts';

export interface ConsoleUiDeps {
  /** 面板局部持久化。`foldSheet` 的展开状态存这儿。 */
  memo: ConsoleMemo;
  /**
   * toast / confirm / drawer 的挂载点。host 传 `document.body` 或一个专用容器。
   * **不能是面板的 `root`**——那个在 unmount 时会被清空。
   */
  overlayHost: HTMLElement;
  /**
   * 面板的 `ctx.signal`。**必填**：这不是可选的加固，而是这套原语能不能收场的前提。
   * 少了它，一个 `await ui.confirm(...)` 就能在面板卸载后永远挂着。
   */
  signal: AbortSignal;
  /** 缺省取 `overlayHost.ownerDocument`。留出口子是为了测试与离屏文档。 */
  doc?: Document;
}

export function createConsoleUi(deps: ConsoleUiDeps): ConsoleUi {
  const doc = deps.doc ?? deps.overlayHost.ownerDocument;
  const signal = deps.signal;
  const env: OverlayEnv = { doc, host: deps.overlayHost, signal };
  // 同一实例只留一条 toast:后来的顶掉前面的,免得叠成一摞
  let liveToast: Overlay | null = null;
  // 抽出来是因为 copyButton 也要弹 toast,而"只留一条"这条规矩记在上面那个闭包里
  const showToast = (text: string, tone?: 'ok' | 'bad'): Disposable => {
    liveToast = toast(env, text, tone, liveToast);
    // abort 之后 toast 不显示,但仍要给回一个句柄:调用方 `.dispose()` 不该炸
    return liveToast ?? noopDisposable;
  };

  return {
    h: (tag, cls, text) => h(doc, tag, cls, text),
    esc,
    sheet: (opts) => sheet(doc, opts),
    foldSheet: (id, opts) => foldSheet(doc, deps.memo, signal, id, opts),
    rowbar: () => rowbar(doc),
    section: (title, description) => section(doc, title, description),
    actions: () => actions(doc),
    button: (label, opts) => button(doc, signal, label, opts),
    copyButton: (text, opts) => copyButton(env, showToast, text, opts),
    pill: (text, tone) => pill(doc, text, tone),
    chip: (text, tone) => chip(doc, text, tone),
    msgline: (text, bad) => msgline(doc, text, bad),
    placeholder: (text) => placeholder(doc, text),
    input: (opts) => input(doc, signal, opts),
    select: (opts) => select(doc, signal, opts),
    textarea: (opts) => textarea(doc, signal, opts),
    promptInput: (opts) => promptInput(doc, signal, opts),
    checkbox: (label, opts) => checkbox(doc, signal, label, opts),
    field: (label, control) => field(doc, label, control),
    segmented: (items, opts) => segmented(doc, signal, items, opts),
    table: (opts) => table(doc, opts),
    kv: (rows) => kv(doc, rows),
    log: (opts) => log(doc, signal, opts),
    stat: (item) => stat(doc, item),
    statgrid: (items) => statgrid(doc, items),
    progress: (opts) => progress(doc, opts),
    toast: showToast,
    confirm: (opts) => confirm(env, opts),
    drawer: (title, body) => drawer(env, title, body),
    busy: (title, text) => busy(env, title, text),
    disable: (...els) => disable(els),
    fmt: consoleFormat,
  };
}

/**
 * 粘滞判定单独导出：它是 `log` 里唯一容易算错的一步，而 DOM 上又最难验
 * （测试里 `scrollTop` / `scrollHeight` / `clientHeight` 全是 0）。拿出来直接钉。
 */
export { LOG_STICK_PX, shouldStick } from './log.ts';
