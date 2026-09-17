import type { ContextRecord } from '../protocol/open-responses/context.ts';
import type { ProviderAttempt } from './generation.ts';
import { usageCounters } from '../protocol/open-responses/context-helpers.ts';

import type { LLMUsage } from './types.ts';
import { nowIso } from './util.ts';

export interface SessionStats {
  id: string;
  /** session声明id(Persona定义的不透明字符串) */
  role: string;
  label: string;
  startedAt: string;
  /** null=进行中 */
  endedAt: string | null;
  /** LLM调用次数 */
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
  /** 缓存命中率估算 = hit/(hit+miss);无输入数据为null */
  cacheHitRate: number | null;
  /** 当前消息条数(引用实时读) */
  messageCount: number;
}

export interface SessionHandle {
  recordAttempts(attempts: readonly ProviderAttempt[], messagesRef?: ContextRecord[]): void;
  /** 本次 session 实例的 id；常驻 session 使用声明 id，临时 fork 使用运行期序号。 */
  id: string;

  record(
    usage: LLMUsage,
    messagesRef?: ContextRecord[],
  ): void;
  /** 关闭 session；重复调用无效。 */
  close(): void;
}

interface Entry {
  stats: Omit<SessionStats, 'cacheHitRate' | 'messageCount'>;
  messagesRef: (() => readonly ContextRecord[]) | null;
  /** 用固定id注册的常驻session:结束后也不从仪表里清掉 */
  pinned: boolean;
}

/** 已结束session最多保留条数(临时session的近期历史,防内存膨胀) */
const CLOSED_KEEP = 8;

export class SessionTracker {
  private readonly timezone: string;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners: Array<() => void> = [];
  private seq = 0;

  constructor(timezone: string) {
    this.timezone = timezone;
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  /**
   * 注册一个session。opts.id指定固定id(常驻session用它的声明id);
   * opts.messagesRef=消息数组的惰性引用(查看消息流/条数用)。
   */
  open(
    role: string,
    label: string,
    opts?: { id?: string; messagesRef?: () => readonly ContextRecord[] },
  ): SessionHandle {
    const id = opts?.id ?? `${role}-${++this.seq}`;
    const entry: Entry = {
      stats: {
        id,
        role,
        label,
        startedAt: nowIso(this.timezone),
        endedAt: null,
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        reasoningTokens: 0,
      },
      messagesRef: opts?.messagesRef ?? null,
      pinned: opts?.id !== undefined,
    };
    this.entries.set(id, entry);
    this.pruneClosed();
    this.emit();

    let closed = false;
    return {
      id,
      recordAttempts: (attempts, messagesRef) => {
        if (closed) return;
        if (messagesRef) entry.messagesRef = () => messagesRef;
        for (const attempt of attempts) {
          const usage = usageCounters(attempt.meters);
          const stats = entry.stats;
          stats.calls++;
          stats.promptTokens += usage.promptTokens;
          stats.completionTokens += usage.completionTokens;
          stats.cacheHitTokens += usage.cacheHitTokens;
          stats.cacheMissTokens += usage.cacheMissTokens;
          stats.reasoningTokens += usage.reasoningTokens ?? 0;
        }
        this.emit();
      },
      record: (
        usage: LLMUsage,
        messagesRef?: ContextRecord[],
      ) => {
        if (closed) return;
        const s = entry.stats;
        s.calls++;
        s.promptTokens += usage.promptTokens;
        s.completionTokens += usage.completionTokens;
        s.cacheHitTokens += usage.cacheHitTokens;
        s.cacheMissTokens += usage.cacheMissTokens;
        s.reasoningTokens += usage.reasoningTokens ?? 0;
        if (messagesRef) entry.messagesRef = () => messagesRef;
        this.emit();
      },
      close: () => {
        if (closed) return;
        closed = true;
        entry.stats.endedAt = nowIso(this.timezone);
        this.pruneClosed();
        this.emit();
      },
    };
  }

  /** 全部session统计(进行中在前,新的在前) */
  list(): SessionStats[] {
    const out: SessionStats[] = [];
    for (const e of this.entries.values()) {
      const s = e.stats;
      const denom = s.cacheHitTokens + s.cacheMissTokens;
      out.push({
        ...s,
        cacheHitRate: denom > 0 ? s.cacheHitTokens / denom : null,
        messageCount: this.countMessages(e),
      });
    }
    return out.sort((a, b) => {
      const ra = a.endedAt === null ? 0 : 1;
      const rb = b.endedAt === null ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return b.startedAt.localeCompare(a.startedAt);
    });
  }

  reset(): void {
    for (const [id, e] of [...this.entries]) {
      if (e.stats.endedAt !== null) {
        this.entries.delete(id);
        continue;
      }
      e.stats.calls = 0;
      e.stats.promptTokens = 0;
      e.stats.completionTokens = 0;
      e.stats.cacheHitTokens = 0;
      e.stats.cacheMissTokens = 0;
      e.stats.reasoningTokens = 0;
      e.stats.startedAt = nowIso(this.timezone);
    }
    this.emit();
  }

  /** 某session当前消息流(引用实时序列化);未知id或无引用→null */
  messages(id: string): readonly ContextRecord[] | null {
    const e = this.entries.get(id);
    if (!e?.messagesRef) return null;
    try {
      return e.messagesRef();
    } catch {
      return null;
    }
  }

  private countMessages(e: Entry): number {
    if (!e.messagesRef) return 0;
    try {
      return e.messagesRef().length;
    } catch {
      return 0;
    }
  }

  /** 已结束session只留最近CLOSED_KEEP个(按结束时间;常驻条目永不清) */
  private pruneClosed(): void {
    const closed = [...this.entries.values()]
      .filter((e) => e.stats.endedAt !== null && !e.pinned)
      .sort((a, b) => (b.stats.endedAt ?? '').localeCompare(a.stats.endedAt ?? ''));
    for (const e of closed.slice(CLOSED_KEEP)) {
      this.entries.delete(e.stats.id);
    }
  }

  private emit(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        /* 观察者异常不影响主流程 */
      }
    }
  }
}
