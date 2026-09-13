/**
 * 框架 /ws/debug 与 /ws/sessions 的 JSON WebSocket 入口，复用 core/stream 的退避、发送排队和生命周期取消。
 * 按页面协议选择 ws/wss；文本帧解析为 JSON，坏帧报告 onError 后丢弃；网络状态通过回调交给调用方呈现。
 */

import type { ConsoleStreamHandle } from '../../shared/client-panel.ts';
import type { Lifecycle } from './lifecycle.ts';
import { openStream, type SocketLike } from './stream.ts';

/** 环境依赖。全部注入,测试里换成假件即可跑完整条重连逻辑。 */
export interface SocketEnv {
  /** `/ws/debug` → 绝对地址 */
  wsUrl(path: string): string;
  createSocket(url: string): SocketLike;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(id: number): void;
}

/** 只取 `protocol` / `host` 两项:够拼地址,又不必在测试里造一整个 `Location`。 */
export interface LocationLike {
  protocol: string;
  host: string;
}

/** 页面是 https 时必须 wss——混合内容会被浏览器直接掐掉,且没有可读的报错。 */
export function wsUrlOf(loc: LocationLike, path: string): string {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}${path}`;
}

/**
 * 浏览器里的那一套。`win` 显式传进来,免得这个模块自己去摸全局;类型带上
 * `typeof globalThis` 是因为 `WebSocket` 构造器挂在全局那一半上,不在 `Window` 接口里。
 */
export function browserSocketEnv(win: Window & typeof globalThis): SocketEnv {
  return {
    wsUrl: (path) => wsUrlOf(win.location, path),
    createSocket: (url) => new win.WebSocket(url) as unknown as SocketLike,
    setTimer: (fn, ms) => win.setTimeout(fn, ms),
    clearTimer: (id) => win.clearTimeout(id),
  };
}

export interface FrameworkSocketOptions {
  /** `/ws/debug` / `/ws/sessions` */
  path: string;
  /** 本次挂载的账本。abort = 连重连一起停;句柄也登记在里面。 */
  lifecycle: Lifecycle;
  /** 一帧(已解析)。非对象的帧(数组、裸字符串)不会送到这儿。 */
  onFrame(frame: Readonly<Record<string, unknown>>): void;
  /**
   * 连上/掉线。**面板自己卸载导致的关闭不算掉线**——那时候画"接口不可达"是句谎话,
   * 而且要写的那个节点马上就要被清掉了。
   */
  onNet?(online: boolean): void;
  onError?(err: unknown): void;
  env: SocketEnv;
}

/**
 * 开一条框架通道。返回的句柄已登记在 `lifecycle` 上——想提前停就自己 `dispose()`,
 * 忘了也不会漏,页面离开时账本会收。
 */
export function openFrameworkSocket(opts: FrameworkSocketOptions): ConsoleStreamHandle {
  const { env } = opts;
  const handle = openStream({
    url: env.wsUrl(opts.path),
    signal: opts.lifecycle.signal,
    createSocket: env.createSocket,
    setTimer: env.setTimer,
    clearTimer: env.clearTimer,
    ...(opts.onError ? { onError: opts.onError } : {}),
    handlers: {
      open: () => opts.onNet?.(true),
      close: (willRetry) => {
        // willRetry=false 只在"我们自己收工"时出现,见上面 onNet 的注释。
        if (willRetry) opts.onNet?.(false);
      },
      message: (text) => {
        let frame: unknown;
        try {
          frame = JSON.parse(text);
        } catch (err) {
          opts.onError?.(err);
          return;
        }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return;
        opts.onFrame(frame as Record<string, unknown>);
      },
    },
  });
  return opts.lifecycle.own(handle);
}
