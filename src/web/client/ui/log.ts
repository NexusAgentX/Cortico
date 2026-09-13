/**
 * 滚动日志 `log`：一个限高的框，里面一串只往末尾长的 `.logline`。
 *
 * 这个原语真正的内容只有两条，其余都是包装：
 *
 * 1. **环形裁剪**。超过上限就从头摘。没有上限的流式面板是一颗定时炸弹——一条
 *    长驻的流开一晚上能堆出几十万个节点，而这类面板恰恰是开着不管的那种。
 *
 * 2. **尾部粘滞**。贴着底就跟着新行走；用户一往上翻就停住；翻回底部再恢复。
 *    每个接流的面板都会自己写一遍，也都会以同一种方式写错：无条件
 *    `scrollTop = scrollHeight`，于是用户永远读不完一段往上翻的历史。
 *
 * 判定单独抽成纯函数 `shouldStick` 并对外导出，是因为它是这里唯一容易算错的一步，
 * 而它又恰恰最难在 DOM 上测——真实布局给的三个数在测试里全是 0。函数拿出来，
 * 边界（正好在底 / 差一像素 / 用户上翻）就能直接钉住，DOM 那层只剩接线。
 *
 * 视觉靠文件末尾追加的 `.logview` / `.logline` 两档；空态复用既有的 `.placeholder`。
 */

import type {
  ConsoleLog,
  ConsoleLogOptions,
  ConsoleLogTone,
} from '../../shared/client-panel.ts';
import { h } from './dom.ts';

/** 缺省上限。四百行足够翻一阵子，又不至于让布局开始喘。 */
const LOG_MAX_LINES = 400;

/** 缺省的粘滞容差（像素）。 */
export const LOG_STICK_PX = 24;

/** 缺省高度。给了限高才会滚，粘滞也才有意义。 */
const LOG_MAX_HEIGHT = '240px';

/**
 * 此刻算不算"贴着底"。
 *
 * 判据是 **`scrollHeight - clientHeight - scrollTop <= threshold`**：等号左边就是
 * 底下还剩多少没滚出来，滚到最底时为 0。三处细节：
 *
 * - **容差不能取 0**。浏览器报的 `scrollHeight` / `clientHeight` 带小数（缩放、
 *   边框、亚像素行高都会让它们凑不整），滚到底时这三个数几乎从不严格相等；
 *   取 0 等于粘滞永远不成立，日志看着就是"不自动滚"。
 * - **内容还没撑满框**（`scrollHeight <= clientHeight`）时左边是负数，照样 `true`——
 *   刚开始铺日志、一行都没溢出的时候本来就该跟着长。
 * - **拿不到数**（三个都是 0 的未布局节点、NaN）时返回 `true`。默认粘住是安全的
 *   那一边：猜错顶多多滚一次，猜成不粘的话新行会一直落在视野外面。
 */
export function shouldStick(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = LOG_STICK_PX,
): boolean {
  const rest = scrollHeight - clientHeight - scrollTop;
  if (!Number.isFinite(rest)) return true;
  return rest <= Math.max(0, threshold);
}

/** tone → class。`plain` 与不给一样落中性 `.logline`。 */
function lineClass(tone?: ConsoleLogTone): string {
  return tone && tone !== 'plain' ? 'logline ' + tone : 'logline';
}

export function log(doc: Document, signal: AbortSignal, opts?: ConsoleLogOptions): ConsoleLog {
  const o = opts ?? {};
  const max = Math.max(1, Math.floor(o.max ?? LOG_MAX_LINES));
  const threshold = o.stickThreshold ?? LOG_STICK_PX;
  const el = h(doc, 'div', o.variant === 'conversation' ? 'logview conversation' : 'logview');
  el.setAttribute('style', 'max-height:' + (o.maxHeight ?? LOG_MAX_HEIGHT));

  // 空态是一个独立节点、且在第一行进来时就摘掉:留着它当孩子的话,环形裁剪
  // 从头摘的第一个就是它,行数从此少算一行。
  let empty: HTMLElement | null = null;
  const showEmpty = (): void => {
    if (!o.empty || empty) return;
    empty = h(doc, 'div', 'placeholder', o.empty);
    el.appendChild(empty);
  };
  const hideEmpty = (): void => {
    empty?.remove();
    empty = null;
  };
  showEmpty();

  // 初值 true:刚建出来的日志本来就在底部,第一批行必须跟着走
  let stuck = true;
  const scrollToEnd = (): void => {
    el.scrollTop = el.scrollHeight;
    stuck = true;
  };
  // 唯一的一条监听,随面板 signal 摘。程序化地设 scrollTop 也会派发 scroll,
  // 那一发照样走这里重算——算出来仍是"贴着底",所以不必特意去屏蔽它。
  el.addEventListener(
    'scroll',
    () => {
      stuck = shouldStick(el.scrollTop, el.scrollHeight, el.clientHeight, threshold);
    },
    { signal },
  );

  return {
    el,
    append(line, tone) {
      hideEmpty();
      const row = h(doc, 'div', lineClass(tone), line);
      el.appendChild(row);
      // 逐个摘而不是重建:这个模块一处 innerHTML 都没有
      while (el.children.length > max) el.children[0].remove();
      if (stuck) scrollToEnd();
      return row;
    },
    clear() {
      while (el.children.length) el.children[0].remove();
      empty = null;
      showEmpty();
      // 清空之后重新粘住:一个空的日志框谈不上"用户正在往上翻"
      stuck = true;
    },
    get count(): number {
      return empty ? 0 : el.children.length;
    },
    get stuck(): boolean {
      return stuck;
    },
    scrollToEnd,
  };
}
