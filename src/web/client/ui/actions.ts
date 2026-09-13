/**
 * 「一次操作期间」的两件事：`disable`（把一组控件置灰）与 `copyButton`（复制 + 回执）。
 *
 * 归在一处是因为它们共享同一个语境——用户按下一颗按钮之后、结果回来之前的那几百
 * 毫秒。那段时间里控制台要做两件事：**别让人重复点**，以及**做完了要吭一声**。
 *
 * 两件都不新增样式：`disable` 只动 `disabled` 属性（`.btn:disabled` / `.field:disabled`
 * 既有样式已经处理了置灰），`copyButton` 就是一颗 `.btn` 加一条既有的 `.toast`。
 */

import type {
  ConsoleCopyOptions,
  ConsoleDisablable,
  Disposable,
} from '../../shared/client-panel.ts';
import { toDisposable } from '../../shared/client-panel.ts';
import { h } from './dom.ts';
import { button } from './sheet.ts';
import type { OverlayEnv } from './overlay.ts';
import { drawer } from './overlay.ts';
import { S } from './strings.ts';

/**
 * 局部禁用。返回的 `Disposable` 把每个控件放回**它自己原本的**状态。
 *
 * 恢复原值而不是一律 `false`：一排控件里本来就有几颗是禁用的（上游没就绪、
 * 权限不足），一律置回可用等于把它们悄悄解禁——用户点下去才发现后端根本不认。
 *
 * 同一个控件传两次只记第一次的原值。不去重的话第二次会把"已经被我们置成 true"
 * 当成原状记下来，恢复时按顺序放回去，最后一手写的是 true——一颗永远灰着的按钮。
 */
export function disable(els: readonly ConsoleDisablable[]): Disposable {
  const saved: { el: { disabled: boolean }; was: boolean }[] = [];
  const seen = new Set<object>();
  for (const el of els) {
    if (!el || seen.has(el)) continue;
    seen.add(el);
    saved.push({ el, was: el.disabled });
    el.disabled = true;
  }
  // toDisposable 自带幂等标志,重复 dispose 不会二次写回
  return toDisposable(() => {
    for (const s of saved) s.el.disabled = s.was;
  });
}

/**
 * 剪贴板从哪儿取。
 *
 * 先问文档自己的 `defaultView`、再退到全局：这个模块不许在顶层引用 `window`
 * （测试跑在 node 里，未来还可能是离屏文档 / iframe——那时候 `globalThis` 上的
 * 那个根本不是这份文档的窗口）。
 */
function navigatorOf(doc: Document): Navigator | null {
  return doc.defaultView?.navigator ?? (globalThis as { navigator?: Navigator }).navigator ?? null;
}

/**
 * 降级路线：把文本塞进一个离屏 `textarea`，选中，走 `document.execCommand('copy')`。
 *
 * `navigator.clipboard` 只在安全上下文（https / localhost）里有，控制台经常是从
 * 局域网另一台机器上打开的，那边它就是 `undefined`。没有这条降级的话，那台机器上
 * 所有复制按钮都是死的。
 */
function execCopy(env: OverlayEnv, value: string): boolean {
  const doc = env.doc as Document & { execCommand?: (cmd: string) => boolean };
  if (typeof doc.execCommand !== 'function') return false;
  const ta = h(doc, 'textarea');
  ta.value = value;
  // 必须真的在 DOM 里、且可聚焦,才选得中;挪到屏外并透明化是为了不闪一下
  ta.setAttribute('style', 'position:fixed;top:0;left:-9999px;opacity:0');
  env.host.appendChild(ta);
  try {
    ta.focus();
    ta.select();
    return doc.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

/** 两条路依次试。都不通给 false，由调用方去出声。 */
async function writeClipboard(env: OverlayEnv, value: string): Promise<boolean> {
  const nav = navigatorOf(env.doc);
  const clip = nav?.clipboard as Clipboard | undefined;
  if (typeof clip?.writeText === 'function') {
    try {
      await clip.writeText(value);
      return true;
    } catch {
      // 权限被拒 / 文档没聚焦:掉到降级路线,别在这儿就放弃
    }
  }
  return execCopy(env, value);
}

/**
 * 复制按钮。
 *
 * 文本允许给函数：面板上那串值常常是活的（某个实时坐标、某次调用的最新回执），
 * 渲染时抓下来的快照到手就过期了——那正是"复制出来的跟屏幕上写的不一样"这类
 * 假 bug 的来源。
 *
 * `show` 由 `createConsoleUi` 传进来而不是这里自己 `toast(env, …)`：同一个面板只
 * 留一条 toast 的规矩记在那个实例的闭包里，绕过去就会叠成一摞。
 */
export function copyButton(
  env: OverlayEnv,
  show: (text: string, tone?: 'ok' | 'bad') => void,
  text: string | (() => string),
  opts?: ConsoleCopyOptions,
): HTMLButtonElement {
  const o = opts ?? {};
  const label = o.label ?? S.copy;
  const run = async (): Promise<void> => {
    let value: string;
    try {
      value = typeof text === 'function' ? text() : text;
    } catch {
      // 惰性取值自己炸了(那串值背后的对象已经没了):照样出声,别静默
      show(S.copyNothing, 'bad');
      return;
    }
    if (await writeClipboard(env, value)) {
      show(o.okText ?? S.copied, 'ok');
      return;
    }
    // 两条路都不通:出声 + 把文本摊开让用户自己选取。静默失败的复制按钮比没有
    // 更糟——用户以为复制成功了,粘出来的是上一次的剪贴板内容。
    show(S.copyFailed, 'bad');
    drawer(env, label, value);
  };

  return button(env.doc, env.signal, label, {
    size: o.size ?? 'sm',
    variant: o.variant,
    onClick: () => void run(),
  });
}
