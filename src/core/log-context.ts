/**
 * 日志锚点的异步上下文:主循环在轮次、工具调用边界上设置,Logger 在落盘刻读取。
 * 记录因此自带 sess / round / resp / call,调用签名不变。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogAnchors {
  /** session 声明 id(main / dream …) */
  sess?: string;
  /** 主循环轮次,进程内单调 */
  round?: number;
  /** 本轮的 response id */
  resp?: string;
  /** 正在执行的 tool_call id */
  call?: string;
  /** 事件游标 */
  ev?: number;
  /** World 任务号 */
  task?: number;
}

const storage = new AsyncLocalStorage<LogAnchors>();

/** 在 fn 及其派生的所有异步续体里叠加这些锚点。 */
export function withAnchors<T>(anchors: LogAnchors, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...anchors }, fn);
}

/** 改写当前作用域的锚点。作用域由最近一次 withAnchors 建立,没有作用域时无事发生。 */
export function setAnchors(patch: LogAnchors): void {
  const current = storage.getStore();
  if (!current) return;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete (current as Record<string, unknown>)[key];
    else (current as Record<string, unknown>)[key] = value;
  }
}

export function currentAnchors(): LogAnchors {
  return storage.getStore() ?? {};
}
