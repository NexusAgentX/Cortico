/**
 * Hash 路由集中读写 location.hash，提供解析、变更通知与离开拦截。路由只解析路径段；各段的业务含义由 host 解释。
 */

import { toDisposable, type Disposable } from '../../shared/client-panel.ts';

export interface Route {
  /** 路径段，已 decode。`#/provider/worlds%3Achat/gate` → `['provider','world:chat','gate']` */
  segments: string[];
  /** 查询参数（`?a=1`），已 decode */
  query: Record<string, string>;
  /** 原始 hash（不含前导 `#`），用于回滚 */
  raw: string;
}

/** 返回一句话 = 拦下并让用户确认；返回 null = 放行。 */
export type LeaveGuard = () => string | null;

export interface RouterDeps {
  /** 注入而不是直接摸全局：测试与多实例都需要。 */
  win: Window;
  /** 拦截时问用户。返回 true 表示确认离开。 */
  confirmLeave(message: string): Promise<boolean>;
  onError?(err: unknown): void;
}

export function parseHash(raw: string): Route {
  const hash = raw.startsWith('#') ? raw.slice(1) : raw;
  const qIdx = hash.indexOf('?');
  const path = qIdx >= 0 ? hash.slice(0, qIdx) : hash;
  const query: Record<string, string> = {};
  if (qIdx >= 0) {
    for (const pair of hash.slice(qIdx + 1).split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const k = eq >= 0 ? pair.slice(0, eq) : pair;
      const v = eq >= 0 ? pair.slice(eq + 1) : '';
      try {
        query[decodeURIComponent(k)] = decodeURIComponent(v);
      } catch {
        query[k] = v; // 坏编码不该让整页打不开
      }
    }
  }
  const segments = path.split('/').filter((s) => s !== '').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  return { segments, query, raw: hash };
}

/** 比较两个 hash 是否指向同一处，忽略前导 `#`（`''` / `'#'` 都算空）。 */
function sameHash(a: string, b: string): boolean {
  const norm = (h: string): string => (h.startsWith('#') ? h.slice(1) : h);
  return norm(a) === norm(b);
}

export function buildHash(segments: readonly string[], query?: Record<string, string>): string {
  const path = segments.map((s) => encodeURIComponent(s)).join('/');
  const entries = Object.entries(query ?? {});
  const qs = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `#/${path}${qs ? `?${qs}` : ''}`;
}

export class Router {
  private readonly deps: RouterDeps;
  private readonly listeners = new Set<(route: Route) => void>();
  private readonly guards = new Set<LeaveGuard>();
  private current: Route;
  /**
   * 正在等待的回拨目标。
   *
   * **不能用一个布尔。** 回拨写进去的值若恰好等于地址栏现值，浏览器根本不发
   * hashchange，那面旗子就没人消费、永远留在 true，把下一次正当导航整个吃掉。
   * 触发路径很实在：确认框挂起期间又来一次 hashchange，两次都被拒，两次回拨
   * 目标是同一个原值 → 第二次赋值哑火。所以记**具体是哪个 hash**，比对上才清。
   */
  private pendingRevert: string | null = null;
  /** 确认框是否已经开着。开着时再来的变更直接拨回，不叠第二个框。 */
  private confirming = false;
  private started = false;

  constructor(deps: RouterDeps) {
    this.deps = deps;
    this.current = parseHash(deps.win.location.hash);
  }

  get route(): Route {
    return this.current;
  }

  start(): Disposable {
    if (this.started) throw new Error('Router 已经启动');
    this.started = true;
    // 重读一次:构造与 start 之间地址可能已经变了(异步 boot、加载中用户点了链接)。
    // 拿构造时的快照广播会让 router 一上来就与地址栏错位。
    this.current = parseHash(this.deps.win.location.hash);
    const handler = (): void => { void this.onHashChange(); };
    this.deps.win.addEventListener('hashchange', handler);
    this.emit();
    return toDisposable(() => this.deps.win.removeEventListener('hashchange', handler));
  }

  onChange(cb: (route: Route) => void): Disposable {
    this.listeners.add(cb);
    return toDisposable(() => this.listeners.delete(cb));
  }

  /**
   * 离开拦截。编辑器类面板（有未保存改动）用它。
   * 返回的 `Disposable` 解除拦截——面板 unmount 时必须解除，否则一个已经不在的
   * 页面会永远拦着别人。
   */
  addLeaveGuard(guard: LeaveGuard): Disposable {
    this.guards.add(guard);
    return toDisposable(() => this.guards.delete(guard));
  }

  navigate(segments: readonly string[], query?: Record<string, string>): void {
    const next = buildHash(segments, query);
    // 去重要跟**地址栏**比，不能跟 `current` 比：两者一旦脱节，"写一个地址栏里
    // 已经有的值"既不早退、也不触发 hashchange，这个路由就永远到不了了。
    if (sameHash(this.deps.win.location.hash, next)) {
      if (!sameHash(this.current.raw, next)) {
        this.current = parseHash(next);
        this.emit();
      }
      return;
    }
    this.deps.win.location.hash = next;
  }

  /** 把地址栏拨回某个值。已经是它了就不写——那样不会有 hashchange，旗子会漏消费。 */
  private revertTo(raw: string): void {
    const target = `#${raw}`;
    if (sameHash(this.deps.win.location.hash, target)) {
      this.pendingRevert = null;
      return;
    }
    this.pendingRevert = target;
    this.deps.win.location.hash = target;
  }

  private firstBlock(): string | null {
    for (const g of this.guards) {
      let msg: string | null = null;
      try {
        msg = g();
      } catch (err) {
        this.deps.onError?.(err);
      }
      if (msg) return msg;
    }
    return null;
  }

  private async onHashChange(): Promise<void> {
    const win = this.deps.win;
    // 这次变更是我们自己拨回去造成的,不算一次导航。
    if (this.pendingRevert !== null && sameHash(win.location.hash, this.pendingRevert)) {
      this.pendingRevert = null;
      return;
    }
    // 已经在问用户了:再来的变更一律先拨回去,不叠第二个确认框。
    // (连按后退、或弹窗期间有程序化导航,都会走到这里。)
    if (this.confirming) {
      this.revertTo(this.current.raw);
      return;
    }

    const block = this.firstBlock();
    if (block) {
      this.confirming = true;
      let ok = false;
      try {
        ok = await this.deps.confirmLeave(block);
      } catch (err) {
        this.deps.onError?.(err); // 问不出结果就当没同意
      } finally {
        this.confirming = false;
      }
      if (!ok) {
        this.revertTo(this.current.raw);
        return;
      }
      // 用户确认离开：拦截器归它自己的面板所有，unmount 时会解除,这里不动它。
    }
    this.current = parseHash(win.location.hash);
    this.emit();
  }

  private emit(): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(this.current);
      } catch (err) {
        this.deps.onError?.(err);
      }
    }
  }
}
