/**
 * 同一轮、同一工具且读数指纹相同的重复查询返回简短回执；状态变化时重新完整回答。
 * 指纹排除时钟字段，避免经过时间造成虚假的状态变化。
 * 主循环的 round 经代理 IPC 原样传入子进程的 ctx.round；缺少轮号时每次正常回答。
 */
import type { ToolCallContext } from '../../core/types.ts';

/** 这次调用属于哪一轮;认不出来返回 null(此时调用方不设闸)。 */
export function roundTokenOf(ctx: ToolCallContext | undefined): number | null {
  if (!ctx) return null;
  if (typeof ctx.round === 'number') return ctx.round;
  return null;
}

/** 一轮一答的短回执:不复述内容,只指回上一条 */
export const REPEATED_QUERY_RECEIPT = '这轮已经答过了,答案不会变,先看上一条。';

/**
 * 一轮一答闸。每个工具一格,记「上一次是哪一轮、答的那份读数指纹是什么」。
 * 纯记账,不做任何判断替代:它只回答「这两次是不是同一轮的同一份读数」。
 */
export class RoundOnceGate {
  private readonly last = new Map<string, { round: number; stamp: string }>();

  /**
   * 这一次要不要真答。`round` 为 null(认不出轮)一律真答。
   * 真答时把这一轮与指纹记下;算重复时不动账。
   */
  answered(tool: string, round: number | null, stamp: string): boolean {
    if (round === null) return true;
    const prev = this.last.get(tool);
    if (prev && prev.round === round && prev.stamp === stamp) return false;
    this.last.set(tool, { round, stamp });
    return true;
  }
}
