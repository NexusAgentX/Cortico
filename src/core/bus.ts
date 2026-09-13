/**
 * WakeBus:合批事件总线。
 *
 * 一条事件按 TriggerMode 分四档:preempt 请求取消尚未外化的在途模型轮并立即
 * 投递、flush 到达即投递、debounce 参与计时、piggyback 只入队等下一班车。
 *
 * debounce 那一批的投递时刻由四条判据合成:不早于首件到达 + minBatchAge(地板)、
 * 不早于末件到达 + quietGap(防抖)、不晚于首件到达 + maxBatchAge(上限)、
 * 积压事件到 maxBatchSize 立即投递。满足条件就尽早投。
 *
 * 防抖等待输入安静，地板为小批量设置最早投递时间。两者共同约束低频事件的
 * 逐条投递与突发事件的过早分批。
 *
 * **全序不变式**:队列 FIFO,任何投递都是整个队列——没有任何路径能让后到的
 * 唤醒项先离开总线。总线是 agent 经历的时间线,上下文序 = 投递序 = 到达序。
 * 队列里有三种项:即时成文事件、投递成文观察与候选票据。观察没有发生时刻,
 * 不参与关键词、攒批与闸门溢出。候选票据代表已发生的外部动静,按即时外部项参与
 * 发车与溢出；它的 `gateText` 只用于关键词闸门。
 *
 * **搭车项一条路都不发车。** piggyback 不下计时器、不计入攒批与闸门溢出、
 * 不参与关键词命中,队列里只剩它们时 deliver() 既不投递也不置 ready。它们
 * 唯一的出场方式是被别的唤醒项带走——包括心跳这类周期性内部项,所以积压不会
 * 无限期停在总线上。
 *
 * 两个闸门都扣一切:paused 是操作者暂停,任何自动机制不能解除;投递闸门
 * (DeliveryGate,Persona经 CoreApi 安装)的出口只有解除、关键词命中与
 * 积压溢出,三条出口都整批放行。单消费者:nextBatch() 取走全部积压。
 */
import type { DeliveryGate, EventOrigin, Logger, TriggerMode, WakeItem } from './types.ts';
import { nullLogger } from './util.ts';

export interface WakeBusOptions {
  /** 末件到达之后安静这么久才投递 */
  quietGapMs: number;
  /** 首件到达起至少攒这么久 */
  minBatchAgeMs: number;
  /** 首件到达起最多攒这么久,到点强制投递 */
  maxBatchAgeMs: number;
  /** 积压事件达到这个条数就强制投递 */
  maxBatchSize: number;
}

// opts 在每次 push 时读取;活配置对象的就地更新立即生效,bus 实例保持不变。

/** 队列元素:唤醒项本身,加上入队时定下的档位里唯一有后效的那一位。 */
interface Queued {
  item: WakeItem;
  piggyback: boolean;
}

export class WakeBus {
  private opts: WakeBusOptions;
  private queue: Queued[] = [];
  private paused = false;
  private gate: DeliveryGate | null = null;
  /** 一次整批投递许可;人工暂停的优先级更高。 */
  private bypassGateOnce = false;
  /** 到期即投递的那一个定时器;每次 push 按四条判据重算 */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 本批首件与末件的到达时刻(队列空时为 null) */
  private firstAt: number | null = null;
  private lastAt = 0;
  /** 挂起中的消费者(单消费者,最多一个) */
  private waiter: ((batch: WakeItem[]) => void) | null = null;
  /** 已到投递条件但没有消费者在等:置真,消费者一来就取走 */
  private ready = false;
  /** preempt 只报告机械时机；是否仍可安全取消由主循环裁决。 */
  private preemptHandler: (() => void) | null = null;

  private readonly log: Logger;

  constructor(opts: WakeBusOptions, log: Logger = nullLogger()) {
    this.opts = opts;
    this.log = log;
  }

  setPreemptHandler(handler: () => void): void {
    this.preemptHandler = handler;
  }

  push(item: WakeItem, opts?: { trigger?: TriggerMode }): void {
    const origin = originOf(item);
    // 档位由推的人定;不表态时按来源取默认——内部项通常是"现在就该叫醒她"
    const trigger: TriggerMode =
      opts?.trigger ?? (origin === 'internal' ? 'flush' : 'debounce');
    const piggyback = trigger === 'piggyback';
    this.queue.push({ item, piggyback });
    const gate = this.gate;
    if (gate) {
      this.clearTimers();
      // 搭车项在闸门下同样不发车:两条出口(关键词、溢出)都跳过它。
      if (piggyback) return;
      // 投递成文项此刻没有正文,关键词无从命中。
      const gateText = textForGate(item);
      if (origin === 'external' && gate.keyword !== undefined && gateText?.includes(gate.keyword)) {
        gate.onKeyword();
        const permitted = this.gate !== gate || this.bypassGateOnce;
        this.log.emit('debug', '闸门关键词命中', { event: 'gate-keyword', data: { gate: gate.id, permitted } });
        if (permitted) this.deliver(this.bypassGateOnce);
        this.notifyPreempt(trigger, permitted);
        return;
      }
      // 已经有一批获准放行时,新到直接并入该批,不重复产生溢出通知。
      if (this.bypassGateOnce) {
        this.deliver(true);
        this.notifyPreempt(trigger, true);
        return;
      }
      if (origin === 'external' && this.pendingEventCount() > gate.overflowLimit) {
        // 先获准整批放行:onOverflow 回调里注入的溢出通知随批同行,不拆成两个回合
        this.bypassGateOnce = true;
        this.log.emit('debug', '闸门下积压越过溢出线,整批放行', { event: 'gate-overflow', data: { gate: gate.id, pending: this.pendingEventCount(), limit: gate.overflowLimit } });
        gate.onOverflow();
        this.deliver(true);
        this.notifyPreempt(trigger, true);
      }
      return;
    }

    if (trigger === 'preempt') {
      const permitted = !this.blocked();
      this.deliver();
      this.notifyPreempt(trigger, permitted);
      return;
    }
    if (trigger === 'flush') {
      this.deliver();
      return;
    }
    // 搭车项保持排队,不启动或延后批次计时器。
    if (piggyback) return;
    const now = Date.now();
    if (this.firstAt === null) this.firstAt = now;
    this.lastAt = now;
    // 攒够一批就别再等钟了
    if (this.pendingEventCount() >= this.opts.maxBatchSize) {
      this.deliver();
      return;
    }
    this.arm();
  }

  /**
   * 按四条判据算出这一批该在什么时刻投递,重下定时器。
   * 每次 push 都重算:opts 是活引用,控制台热改的新值下一次 push 即生效。
   */
  private arm(): void {
    if (this.firstAt === null) return;
    const { quietGapMs, minBatchAgeMs, maxBatchAgeMs } = this.opts;
    const at = Math.min(
      this.firstAt + maxBatchAgeMs,
      Math.max(this.firstAt + minBatchAgeMs, this.lastAt + quietGapMs),
    );
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.deliver(), Math.max(0, at - Date.now()));
  }

  /** 暂停或闸门(未获准整批放行)期间不投递。 */
  private blocked(): boolean {
    return this.paused || (this.gate !== null && !this.bypassGateOnce);
  }

  /** 已获准投递的 preempt 才能取消当前模型轮；暂停与闸门继续拥有更高优先级。 */
  private notifyPreempt(trigger: TriggerMode, permitted: boolean): void {
    if (trigger === 'preempt' && permitted && !this.paused) {
      this.log.emit('debug', '抢占:请求取消尚未外化的在途模型轮', { event: 'preempt' });
      this.preemptHandler?.();
    }
  }

  /** 人工暂停/继续(控制台);继续时积压一次性投递 */
  setPaused(v: boolean): void {
    if (v !== this.paused) this.log.emit('info', v ? '总线已暂停:事件照常落库,不投递' : '总线继续', { event: v ? 'paused' : 'resumed', data: { queued: this.queue.length } });
    this.paused = v;
    if (!this.paused && (this.ready || this.queue.length > 0)) {
      this.deliver(this.bypassGateOnce);
    }
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * 安装或更新投递闸门。若此前没有闸门,安装前已经积压的内容获准放行一次;
   * 闸门只约束安装之后到达的唤醒项。
   */
  setDeliveryGate(gate: DeliveryGate): void {
    const hadGate = this.gate !== null;
    this.gate = gate;
    this.clearTimers();
    this.log.emit('debug', hadGate ? '投递闸门已更新' : '投递闸门已安装', { event: 'gate-set', data: { gate: gate.id, queued: this.queue.length } });
    if (!hadGate && this.queue.length > 0) {
      this.deliver(true);
    }
  }

  /**
   * 只解除匹配id的闸门。deliverQueued=false用于"先解闸、再把到期通知和积压
   * 一起投递",避免拆成两个user回合。
   */
  clearDeliveryGate(id: string, deliverQueued = true): boolean {
    if (this.gate?.id !== id) return false;
    this.gate = null;
    this.log.emit('debug', '投递闸门已解除', { event: 'gate-cleared', data: { gate: id, queued: this.queue.length, deliverQueued } });
    if (deliverQueued && this.queue.length > 0) {
      this.deliver(this.bypassGateOnce);
    }
    return true;
  }

  isDeliveryBlocked(): boolean {
    return this.gate !== null;
  }

  /** 当前积压条数(控制台可见性;含尚未成文的投递成文项) */
  pending(): number {
    return this.queue.length;
  }

  /**
   * 积压中的即时项条数(空闲判定用)。长期停放、等着搭车的项不算"还有事没处理"
   * ——它不该压着空闲钩子(onIdle)不放。
   */
  pendingImmediate(): number {
    let n = 0;
    for (const q of this.queue) {
      if (!q.piggyback && (q.item.event !== undefined || q.item.candidate !== undefined)) n++;
    }
    return n;
  }

  /**
   * 同步抽走队列中所有满足pred的项并按原序返回(消费一次,不再投递);
   * 纯同步:不await、不投递、不碰waiter/ready/定时器(draft工具中途窥取用)。
   */
  drainPending(pred: (item: WakeItem) => boolean): WakeItem[] {
    const drained: WakeItem[] = [];
    const kept: Queued[] = [];
    for (const q of this.queue) {
      if (pred(q.item)) drained.push(q.item);
      else kept.push(q);
    }
    this.queue = kept;
    // 搭车项自己不驱动投递,只剩它们时也该复位:留着 ready 与计时器会让下一个
    // 消费者为一批不该独自发车的挂单空跑一趟。
    if (!this.hasWakingItem()) {
      this.ready = false;
      this.bypassGateOnce = false;
      this.firstAt = null;
      this.clearTimers();
    }
    return drained;
  }

  /**
   * 已达投递标准就同步取走一批,否则返回null。不挂起、不等待。
   * 主循环在工具调用链途中用它:模型仍在连续行动时没有消费者在等 nextBatch,
   * 到点的批只会把 ready 置真;这个入口让本轮的工具结果之后就能接上通知。
   */
  takeIfReady(): WakeItem[] | null {
    if (!this.ready || this.queue.length === 0 || this.blocked()) return null;
    this.ready = false;
    return this.take();
  }

  /** 取走全部积压并清空;没货时挂起等待。单消费者。 */
  nextBatch(): Promise<WakeItem[]> {
    if (this.waiter) throw new Error('WakeBus只支持单消费者');
    if (this.ready && this.queue.length > 0 && !this.blocked()) {
      this.ready = false;
      return Promise.resolve(this.take());
    }
    return new Promise<WakeItem[]>((resolve) => {
      this.waiter = resolve;
    });
  }

  private deliver(bypassGate = false): void {
    this.clearTimers();
    // 只剩搭车项:不投递也不置 ready,等下一个能自己发车的唤醒项来带走它们。
    if (this.queue.length > 0 && !this.hasWakingItem()) return;
    if (bypassGate) this.bypassGateOnce = true;
    if (this.blocked()) {
      // 积压保留,解除时投递
      this.ready = true;
      return;
    }
    if (this.queue.length === 0) {
      // 放行许可没有对象就作废——那一批已经走了,许可不能留给下一条被扣项
      this.bypassGateOnce = false;
      return;
    }
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      this.ready = false;
      w(this.take());
    } else {
      this.ready = true;
    }
  }

  private take(): WakeItem[] {
    const batch = this.queue.map((q) => q.item);
    this.log.emit('debug', '投递一批', { event: 'deliver', data: { count: batch.length, piggyback: this.queue.filter((q) => q.piggyback).length, ageMs: this.firstAt === null ? 0 : Date.now() - this.firstAt } });
    this.queue = [];
    this.bypassGateOnce = false;
    this.firstAt = null; // 下一批的延迟下限和上限从首条事件重新计时。
    return batch;
  }

  /**
   * 返回积压中的外部即时事件数。批次判据和闸门上限不计内部事件,也不计投递成文项
   * 与搭车项(尚未成文的观察、以及等着搭车的状态帧,都不算积压的动静)。
   */
  private pendingEventCount(): number {
    let count = 0;
    for (const q of this.queue) {
      if (
        !q.piggyback &&
        (q.item.event !== undefined || q.item.candidate !== undefined) &&
        originOf(q.item) === 'external'
      ) count++;
    }
    return count;
  }

  /** 队列里有没有能自己发车的项。 */
  private hasWakingItem(): boolean {
    return this.queue.some((q) => !q.piggyback);
  }

  private clearTimers(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function originOf(item: WakeItem): EventOrigin {
  return item.event?.origin ?? item.deferred?.origin ?? item.candidate!.origin;
}

function textForGate(item: WakeItem): string | null {
  return item.event?.text ?? item.candidate?.gateText ?? null;
}
