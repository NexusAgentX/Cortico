/** Core 机械状态，持久化到 `<dataDir>/core-state.json`。 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface CoreStateData {
  /** 上次截断时刻ISO */
  lastTruncateAt: string | null;
  /**
   * 投递水位：该游标及之前的唤醒项均已进入 session。
   * 总线队列不持久化；重启时仅补投水位之后的外部事件，内部事件不跨进程重放。
   */
  lastDeliveredCursor: number;
  /**
   * 持久化的 LLM 连败账，时间单位为毫秒。since 为当前连败起点，0 表示不在连败中；at 保存窗口内每次失败时刻，重启后仍可在恢复时报告。
   */
  llmStall: { since: number; at: number[] };
  /** Persona所有的不透明状态；core 仅负责原子持久化。 */
  persona: Record<string, unknown>;
  /**
   * 运维设置的 World 可见性，默认可见并跨重启保留。隐藏仅撤下 agent 表面，
   * 不改变部署层的挂载状态。
   */
  worldVisibility: Record<string, boolean>;
}

const DEFAULTS: CoreStateData = {
  lastTruncateAt: null,
  lastDeliveredCursor: 0,
  llmStall: { since: 0, at: [] },
  persona: {},
  worldVisibility: {},
};

function freshDefaults(): CoreStateData {
  return { ...DEFAULTS, llmStall: { since: 0, at: [] }, persona: {}, worldVisibility: {} };
}

function readStall(raw: unknown): { since: number; at: number[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { since: 0, at: [] };
  const r = raw as { since?: unknown; at?: unknown };
  return {
    since: typeof r.since === 'number' && Number.isFinite(r.since) ? r.since : 0,
    at: Array.isArray(r.at)
      ? r.at.filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
      : [],
  };
}

export class CoreState {
  private file: string;
  // persona 每个实例各自新建:DEFAULTS 是共享字面量,浅拷贝会让两个实例改到同一个袋子。
  data: CoreStateData = freshDefaults();

  constructor(dataDir: string) {
    this.file = join(dataDir, 'core-state.json');
  }

  load(): void {
    this.data = freshDefaults();
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<CoreStateData>;
      this.data = {
        lastTruncateAt: raw.lastTruncateAt ?? DEFAULTS.lastTruncateAt,
        lastDeliveredCursor: Number.isInteger(raw.lastDeliveredCursor)
          ? (raw.lastDeliveredCursor as number)
          : DEFAULTS.lastDeliveredCursor,
        llmStall: readStall(raw.llmStall),
        persona:
          raw.persona && typeof raw.persona === 'object' && !Array.isArray(raw.persona)
            ? (raw.persona as Record<string, unknown>)
            : {},
        worldVisibility:
          raw.worldVisibility && typeof raw.worldVisibility === 'object' && !Array.isArray(raw.worldVisibility)
            ? Object.fromEntries(
                Object.entries(raw.worldVisibility as Record<string, unknown>).map(([k, v]) => [k, v !== false]),
              )
            : {},
      };
    } catch {
      // 损坏则用默认值
    }
  }

  save(): void {
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    // 通过 rename 原子覆盖状态文件，不先删除，避免崩溃后状态缺失。Windows 的 renameSync 使用 MoveFileExW 与 MOVEFILE_REPLACE_EXISTING 支持覆盖。
    renameSync(tmp, this.file);
  }

  /**
   * 清除人格状态与截断标记并落盘。投递水位和运维可见性跨重置保留，避免重放
   * 已投递事件或改变 World 可见性。
   */
  clear(): void {
    this.data = {
      ...freshDefaults(),
      lastDeliveredCursor: this.data.lastDeliveredCursor,
      worldVisibility: this.data.worldVisibility,
    };
    this.save();
  }
}
