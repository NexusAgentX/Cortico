/**
 * World 日志:一场试玩的单一现场。
 *
 * 记录按泳道关联工具调用、投递事件、执行结果和内部判断,落到运行日志
 * (`data/runs/<run>/log.jsonl`,区域 `worlds.minecraft.<泳道>`),锚点(轮次、
 * 工具调用 id)由子进程的日志上下文自动补齐。环形缓冲给控制台面板增量轮询。
 */
import type { Logger, LogLevel } from '../../core/types.ts';
import { nowIso, nullLogger } from '../../core/util.ts';

/**
 * 泳道。分法按"这条记录在回答哪个问题":下了什么令(tool)、投递出去什么(event)、
 * 执行到哪一步(task/skill)、判断怎么做出的(craft)、物品发生了什么(inventory)、寻路进展(path)、
 * 全身控制权怎么交接(body)、不经主脑的动作(reflex)、连接状况(link)、
 * 服务端说世界变成什么样了(world)。
 */
type MinecraftLane =
  | 'tool'
  | 'event'
  | 'task'
  | 'skill'
  | 'craft'
  | 'inventory'
  | 'path'
  | 'body'
  | 'reflex'
  | 'combat'
  | 'link'
  | 'world';

/** 泳道的中文名:面板的过滤钮与日志行首都用它 */
export const LANE_ZH: Record<MinecraftLane, string> = {
  tool: '工具',
  event: '投递',
  task: '任务',
  skill: '技能',
  craft: '合成',
  inventory: '物品',
  path: '寻路',
  body: '身体',
  reflex: '反射',
  combat: '战斗',
  link: '连接',
  world: '世界',
};

/**
 * 泳道的默认级别:info = 值班的人逐条读的状态迁移(下令、投递、任务、连接、世界、反射、战斗),
 * debug = 排查一次问题要看的中间量,trace = 每 tick 的身体控制。
 */
const LANE_LEVEL: Record<MinecraftLane, LogLevel> = {
  tool: 'info',
  event: 'info',
  task: 'info',
  skill: 'debug',
  craft: 'debug',
  inventory: 'debug',
  path: 'debug',
  body: 'trace',
  reflex: 'info',
  combat: 'info',
  link: 'info',
  world: 'info',
};

/** 按 `泳道/小类` 覆盖:每次点击、每帧寻路、每口气的机械回声降到 trace。 */
const EVENT_LEVEL: Record<string, LogLevel> = {
  'craft/slot-in': 'trace',
  'craft/click-out': 'trace',
  'craft/items-in': 'trace',
  'craft/place-out': 'trace',
  'craft/grid-clear': 'trace',
  'craft/result-slot': 'trace',
  'craft/stateid-rewrite': 'trace',
  'path/update': 'trace',
  'reflex/drown-submerged': 'trace',
  'reflex/drown-breath': 'trace',
  'skill/dig-ground-wait': 'trace',
  'link/spectate': 'debug',
};

export function laneLevel(lane: MinecraftLane, event: string): LogLevel {
  return EVENT_LEVEL[`${lane}/${event}`] ?? LANE_LEVEL[lane];
}

interface MinecraftLogInput {
  lane: MinecraftLane;
  /** 机器可读小类(同泳道内自洽),排查时按它 grep */
  event: string;
  /** 一句中文。这一行单独读也要说得清发生了什么 */
  msg: string;
  /** 关联的任务号;没有归属的不填 */
  taskId?: number;
  /** 这件事花了多久 */
  durMs?: number;
  /** 原始读数。人读 msg,机器读这里 */
  data?: Record<string, unknown>;
  /** 显式级别;不给按泳道与小类的默认表 */
  level?: LogLevel;
}

export interface MinecraftLogEntry extends MinecraftLogInput {
  seq: number;
  ts: string;
}

interface MinecraftLogOptions {
  /** World 的 logger(区域 worlds.minecraft);不给就只进环形缓冲 */
  log?: Logger;
  timezone?: string;
  /** 环形缓冲容量(控制台面板读它) */
  ring?: number;
}

export class MinecraftLog {
  private readonly log: Logger;
  private readonly timezone: string;
  private readonly capacity: number;
  private ring: MinecraftLogEntry[] = [];
  private seq = 0;

  constructor(opts: MinecraftLogOptions = {}) {
    this.log = opts.log ?? nullLogger();
    this.timezone = opts.timezone ?? 'Asia/Shanghai';
    this.capacity = opts.ring ?? 2_000;
  }

  write(input: MinecraftLogInput): void {
    const entry: MinecraftLogEntry = { seq: ++this.seq, ts: nowIso(this.timezone), ...input };
    this.ring.push(entry);
    if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity);
    this.log.child(input.lane).emit(input.level ?? laneLevel(input.lane, input.event), input.msg, {
      event: input.event,
      ...(input.taskId !== undefined ? { task: input.taskId } : {}),
      ...(input.durMs !== undefined ? { durMs: input.durMs } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
    });
  }

  /** 面板增量轮询:seq 大于 after 的那些 */
  after(seq: number): MinecraftLogEntry[] {
    return this.ring.filter((e) => e.seq > seq);
  }

  /** 清空缓冲;序号继续往下走,面板的 after 游标不会因清空而回头 */
  clear(): string {
    const had = this.ring.length;
    this.ring = [];
    return `面板缓冲已清空(${had} 条);落盘的运行日志不受影响`;
  }
}
