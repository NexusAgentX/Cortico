/**
 * 浮层四件：toast / confirm / drawer / busy。
 *
 * 前三件用户都能自己关掉（到点自摘 / 答一个 / Esc）；`busy` 是唯一关不掉的一层，
 * 见它自己那段注释。
 *
 * 两条结构性约定，其余细节都是从它们推出来的：
 *
 * 1. **挂载点由调用方给**（`env.host`）。面板自己的 `root` 会被 host 在 unmount 时
 *    清空，浮层挂那里会被连带抹掉；而模块顶层引用 `document` 又让测试与多实例难受。
 *
 * 2. **每层浮层自带一个 `AbortController`，并把面板的 `signal` 接进来。**
 *    浮层是全套原语里唯一"活得比调用它的那次渲染更久"的东西，也就唯一有生命周期
 *    问题：面板卸了，开着的抽屉会赖在屏幕上，更糟的是挂起的 `confirm()` 永远不
 *    resolve——扩展里 `await ui.confirm(...)` 之后的代码（包括它自己的清理）直接吊死。
 *    所以面板 abort 时一律强制关闭；`confirm` 按**用户没答应**收场，resolve `false`
 *    而不是 reject（reject 会把"面板正常卸载"这种日常事件变成扩展里的未捕获异常）。
 *    abort 之后再调：`confirm` 立即给 `false`，`toast` / `drawer` 静默不显示——
 *    面板都没了，弹一个没人认领的窗只会误导。
 *
 * 视觉复用既有 class：`modal` / `modalcard` / `modalhead` / `modaltitle` /
 * `modalbody` / `pre.mono` / `btn` / `toast`。
 */

import type { Disposable } from '../../shared/client-panel.ts';
import { h } from './dom.ts';
import { button, rowbar } from './sheet.ts';
import { S } from './strings.ts';

/** 浮层的生存环境：文档、挂载点、面板生命周期。 */
export interface OverlayEnv {
  doc: Document;
  /** 浮层挂在这里。**不能是面板的 `root`**——那个在 unmount 时会被清空。 */
  host: HTMLElement;
  /** 面板的 `ctx.signal`。abort = 面板没了，浮层必须跟着消失。 */
  signal: AbortSignal;
}

/**
 * 一层浮层。`close()` 幂等。
 * `dispose` 与 `close` 是同一个函数：对外（扩展手里的 `Disposable`）叫 dispose，
 * 对内叫 close——不为了统一名字去改契约里那个通用的资源名。
 */
export interface Overlay extends Disposable {
  el: HTMLElement;
  close(): void;
  /** 本层的生命周期：`close()` 即 abort。层内的监听全挂它。 */
  signal: AbortSignal;
}

/** 面板已经 abort 之后的调用返回它：拿到的是个不会爆的空句柄。 */
export const noopDisposable: Disposable = { dispose() {} };

/**
 * 铺一层浮层：进 DOM，接上"面板 abort 就关"。
 *
 * 面板那条 abort 监听自己也挂着本层的 signal（`once` + `signal`），所以浮层先被关掉时
 * 它当场摘掉——不会在面板的 signal 上攒一串已经没用的闭包（那是个真泄漏：一个面板
 * 弹一百次 toast 就攒一百条）。
 */
function openLayer(env: OverlayEnv, el: HTMLElement, onClose?: () => void): Overlay {
  const ac = new AbortController();
  const close = (): void => {
    if (ac.signal.aborted) return;
    ac.abort();
    el.remove();
    onClose?.();
  };
  env.signal.addEventListener('abort', close, { once: true, signal: ac.signal });
  env.host.appendChild(el);
  return { el, close, signal: ac.signal, dispose: close };
}

/**
 * 铺一层 `.modal` 遮罩，接好"点遮罩 / 按 Esc 关闭"。
 * `onClose` 只会被调一次；重复调用 `close()` 是安全的。
 */
function openModal(env: OverlayEnv, onClose: () => void): Overlay {
  const el = h(env.doc, 'div', 'modal');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  const layer = openLayer(env, el, onClose);

  env.doc.addEventListener(
    'keydown',
    (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') layer.close();
    },
    { signal: layer.signal },
  );
  // 用 mousedown 而不是 click:在卡片里按下、拖到遮罩上才松手,click 的 target
  // 会是遮罩,那样一次划选就把对话框关了。
  el.addEventListener(
    'mousedown',
    (ev: MouseEvent) => {
      if (ev.target === el) layer.close();
    },
    { signal: layer.signal },
  );
  return layer;
}

/** toast 停留多久（与 `@keyframes toast` 的 1.9s 对齐，留一点余量再摘节点）。 */
const TOAST_MS = 2000;

/**
 * 瞬时提示。`prev` 是上一条 toast（同一个 ui 实例只留一条，后来的顶掉前面的，
 * 与既有前端 `sendToast` 的行为一致）。返回新的一层，面板 abort 后返回 `null`。
 */
export function toast(
  env: OverlayEnv,
  text: string,
  tone: 'ok' | 'bad' | undefined,
  prev: Overlay | null,
): Overlay | null {
  prev?.close();
  if (env.signal.aborted) return null;
  const el = h(env.doc, 'div', tone === 'bad' ? 'toast bad' : 'toast', text);
  const layer = openLayer(env, el);
  const timer = setTimeout(() => layer.close(), TOAST_MS);
  // 提前关掉(被下一条顶掉、或面板卸载)时把定时器也撤了,免得留一个空转的回调
  layer.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return layer;
}

/** 模态确认。resolve 之后 DOM 与监听都已清干净。 */
export function confirm(
  env: OverlayEnv,
  opts: { title: string; body?: string; danger?: boolean },
): Promise<boolean> {
  // 面板已经卸了:不弹窗,直接按"没答应"收场
  if (env.signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    // 默认答案就是 false,所以**任何**关闭路径(取消键 / Esc / 点遮罩 / 面板 abort)
    // 都会 resolve false,不必各自记得去 settle。
    let answer = false;
    const modal = openModal(env, () => resolve(answer));
    const settle = (v: boolean): void => {
      answer = v;
      modal.close();
    };

    const doc = env.doc;
    const card = h(doc, 'div', 'modalcard');
    card.setAttribute('style', 'width:min(460px,92vw)');
    const head = h(doc, 'div', 'modalhead');
    head.appendChild(h(doc, 'span', 'modaltitle', opts.title));
    const body = h(doc, 'div', 'modalbody');
    if (opts.body) body.appendChild(h(doc, 'div', null, opts.body));

    const bar = rowbar(doc);
    bar.appendChild(h(doc, 'span', 'grow'));
    bar.appendChild(
      button(doc, modal.signal, S.cancel, { size: 'sm', onClick: () => settle(false) }),
    );
    // danger 的文案换成"仍要继续":确认键上写着后果,比一个通用的"确认"更难误按
    const ok = button(doc, modal.signal, opts.danger ? S.proceedAnyway : S.confirm, {
      size: 'sm',
      variant: opts.danger ? 'danger' : 'primary',
      onClick: () => settle(true),
    });
    bar.appendChild(ok);
    body.appendChild(bar);

    card.append(head, body);
    modal.el.appendChild(card);
    ok.focus?.();
  });
}

/**
 * 忙碌浮层：铺一层**关不掉**的遮罩，只能靠返回的 `Disposable` 撤下。
 *
 * 与 `drawer` 只差一件事，而那件事正是全部的意义：这里**不接 Esc、不接点遮罩**，
 * 也不放关闭键。等重启这类场景要的是"这段时间别动"，用 `drawer` 冒充的话，用户
 * 一按 Esc 就把遮罩关了，还以为操作取消了——其实进程照样在重启。
 *
 * 仍然走 `openLayer`，所以面板 abort 时照样自动撤：不可关闭指的是"用户关不掉"，
 * 不是"永远撤不下来"——面板都卸了还盖着一层，那是把整个控制台锁死。
 */
export function busy(env: OverlayEnv, title: string, text?: string): Disposable {
  if (env.signal.aborted) return noopDisposable;
  const doc = env.doc;
  const el = h(doc, 'div', 'modal busy');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  // 读屏软件据此播报"正忙",而不是把一张没有任何可操作控件的卡念成普通对话框
  el.setAttribute('aria-busy', 'true');
  const layer = openLayer(env, el);
  const card = h(doc, 'div', 'modalcard');
  card.setAttribute('style', 'width:min(460px,92vw)');
  const head = h(doc, 'div', 'modalhead');
  head.appendChild(h(doc, 'span', 'modaltitle', title));
  const body = h(doc, 'div', 'modalbody');
  if (text) body.appendChild(h(doc, 'div', 'busytext', text));
  card.append(head, body);
  el.appendChild(card);
  return layer;
}

/**
 * 抽屉：一层能关掉的 `.modalcard`，里面放"看一眼大的"那份东西。
 *
 * 第二参给**字符串**就铺进 `pre.mono`（看原始 JSON / 一段日志的老样子）；给**节点**
 * 就原样放进 `.modalbody`——放大的图、一份 `log`、一张 `table` 都行。
 *
 * 放宽入参而不是另开 `imageViewer` / `logViewer` 之类：那些需求彼此只差一个内容
 * 节点，各自发明一个原语等于把同一层浮层的生命周期与关闭语义复制三遍，而生命
 * 周期正是浮层唯一难的地方（见文件顶部第 2 条）。
 */
export function drawer(env: OverlayEnv, title: string, body: string | HTMLElement): Disposable {
  if (env.signal.aborted) return noopDisposable;
  const doc = env.doc;
  const modal = openModal(env, () => {});
  const card = h(doc, 'div', 'modalcard');
  const head = h(doc, 'div', 'modalhead');
  head.append(
    h(doc, 'span', 'modaltitle', title),
    button(doc, modal.signal, S.close, { size: 'sm', onClick: () => modal.close() }),
  );
  const bodyEl = h(doc, 'div', 'modalbody');
  // 字符串走 pre.mono 保持现状观感;节点直接进,抽屉不必知道里面是什么
  bodyEl.appendChild(typeof body === 'string' ? h(doc, 'pre', 'mono', body) : body);
  card.append(head, bodyEl);
  modal.el.appendChild(card);
  return modal;
}
