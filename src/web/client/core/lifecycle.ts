/**
 * 每次控制台挂载的资源管理器。卸载时先 abort，再逐项 dispose。
 * 监听和 fetch 使用 signal；不接受 signal 的定时器、RAF、observer、AudioContext 与 ObjectURL 经 own、interval 或 frame 登记。
 */

import { toDisposable, type Disposable } from '../../shared/client-panel.ts';

export class Lifecycle {
  private readonly controller = new AbortController();
  /** 后进先出：后借的先还，跟资源之间的依赖方向一致。 */
  private readonly owned: Disposable[] = [];
  private closed = false;
  private readonly onError: (err: unknown) => void;

  /**
   * `onError` 收 dispose 过程中抛出的错误。**一个资源释放失败不能挡住其余的**——
   * 那正是"清理代码里再泄漏一次"的经典形状。
   */
  constructor(onError: (err: unknown) => void = () => {}) {
    this.onError = onError;
  }

  /** unmount 时 abort。传给 `addEventListener` / `fetch` 即可自动清理。 */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get disposed(): boolean {
    return this.closed;
  }

  /**
   * 登记一个资源。
   *
   * **已经 dispose 之后再登记的，立即释放并原样返回**：异步 mount 里很容易出现
   * "await 回来时面板已经没了"，那时候把资源默默挂进一个死账本就是纯泄漏。
   */
  own<T extends Disposable>(d: T): T {
    if (this.closed) {
      this.safely(() => d.dispose());
      return d;
    }
    this.owned.push(d);
    return d;
  }

  /** 包一个清理函数并登记。 */
  add(cleanup: () => void): Disposable {
    return this.own(toDisposable(cleanup));
  }

  /** 轮询。dispose 时自动停。 */
  interval(fn: () => void, ms: number): Disposable {
    if (this.closed) return toDisposable(() => {});
    const id = setInterval(() => {
      try {
        fn();
      } catch (err) {
        this.onError(err);
      }
    }, ms);
    return this.own(toDisposable(() => clearInterval(id)));
  }

  /**
   * 一次性延时。dispose 时自动取消。
   *
   * 触发后**把自己从账本里摘掉**：长驻面板反复调 `timeout` 的话，不摘就是一条
   * 无界增长的空闭包数组——只费内存不改行为，但正是"泄漏"这个词的意思。
   */
  timeout(fn: () => void, ms: number): Disposable {
    if (this.closed) return toDisposable(() => {});
    let handle: Disposable | undefined;
    const id = setTimeout(() => {
      if (handle) this.forget(handle);
      try {
        fn();
      } catch (err) {
        this.onError(err);
      }
    }, ms);
    handle = this.own(toDisposable(() => clearTimeout(id)));
    return handle;
  }

  private forget(d: Disposable): void {
    const i = this.owned.indexOf(d);
    if (i >= 0) this.owned.splice(i, 1);
  }

  /**
   * RAF 循环。`fn` 返回 `false` 即自行结束；dispose 时自动停。
   * `dtMs` 是距上一帧的毫秒数，首帧为 0。
   */
  frame(fn: (dtMs: number) => void | false): Disposable {
    if (this.closed) return toDisposable(() => {});
    let raf = 0;
    let last = 0;
    let stopped = false;
    const step = (now: number): void => {
      if (stopped) return;
      const dt = last === 0 ? 0 : now - last;
      last = now;
      let keep: void | false;
      try {
        keep = fn(dt);
      } catch (err) {
        this.onError(err);
        keep = false;
      }
      if (keep === false) {
        stopped = true;
        return;
      }
      // 回调里把整个 Lifecycle dispose 掉是合法写法(面板自己决定收工)。此时
      // `raf` 还指着**正在跑的这一帧**,cancel 它等于没 cancel;不在这儿早退的话
      // 下面又会挂一帧,而且没人取消得了它。
      if (stopped) return;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return this.own(toDisposable(() => {
      stopped = true;
      cancelAnimationFrame(raf);
    }));
  }

  /**
   * 释放全部。**幂等**，重复调用无副作用。
   *
   * 顺序是 abort 在前：先让所有认识 signal 的东西（挂起的 fetch、监听）自己收手，
   * 再逐个 dispose 那些不认识的。反过来的话，dispose 期间可能又触发一次
   * 已被释放资源上的回调。
   */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.safely(() => this.controller.abort());
    for (let i = this.owned.length - 1; i >= 0; i--) {
      const d = this.owned[i]!;
      this.safely(() => d.dispose());
    }
    this.owned.length = 0;
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.onError(err);
    }
  }
}
