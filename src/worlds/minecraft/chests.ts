/**
 * 容器账本:按方块坐标记住上次看见的内容。
 *
 * 不是地标。箱子族服务 stow/take/peek 选箱和快照「近处」那一行;炉子族多记三个
 * 槽位与「按估计什么时候烧完」,给到期事件和收货用;自备的工作台/熔炉也入账,
 * 几何族试算据此点名「这片罩住了你放的工作台」。没开过就是不知道,走远了不把
 * 全世界的箱子塞进上下文。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ItemStack } from './terrain.ts';

/** 炉子族方块名(原版三种炉子;槽位名照原版 input/fuel/output) */
export const FURNACE_BLOCKS = ['furnace', 'smoker', 'blast_furnace'] as const;

/** 箱子族方块名(能当仓库用的那些);工作台、炉子族、酿造台都不在内 */
export const CHEST_BLOCKS = ['chest', 'trapped_chest', 'barrel', 'ender_chest'] as const;

const CHEST_KINDS = new Set<string>(CHEST_BLOCKS);

/**
 * 炉子三槽位的上次读数 + 按每件耗时估计的烧完时刻。
 * 服务端不同步没开窗的炉子槽位,这份永远是「上次看见」,措辞必须按估计说。
 */
interface FurnaceState {
  input: ItemStack | null;
  fuel: ItemStack | null;
  output: ItemStack | null;
  /** 下料(或最近一次读到槽位)的时刻 */
  loadedAt: number;
  /** 按每件耗时估计的烧完时刻;null = 输入槽空着,没在烧 */
  expectedDoneAt: number | null;
  /** 到期事件已经发过,不重复发 */
  notified?: boolean;
}

export interface ChestRecord {
  x: number;
  y: number;
  z: number;
  dimension: string;
  items: ItemStack[];
  usedSlots: number;
  slots: number;
  /** 方块名;旧档案没有这个字段,读档按 chest 兜底 */
  name?: string;
  /** 我们自己放下的时刻;捡现成的没有 */
  placedAt?: number;
  /** 炉子族的三槽位;箱子族没有 */
  furnace?: FurnaceState;
}

/**
 * 一条账目自报的方块名。开箱记下的那份不带 `name`(旧档案同样不带),一律按 `chest`
 * 兜底 —— 这条兜底口径只此一处,读它的地方(账本自己、回执、试算点名)不再各写一遍。
 */
export function chestBlockName(rec: ChestRecord): string {
  return rec.name ?? 'chest';
}

/** 类别名按整词或 `_query` 后缀匹配，与 collect 共用此规则。 */
export function matchItemName(query: string, name: string): boolean {
  return name === query || name.endsWith(`_${query}`);
}

/**
 * registry 的名字面。判据只问 itemsByName / blocksByName 有没有这个 key;
 * 两张表都可缺 —— 拿不到表时判据答不出「这是不是真 id」,退回后缀口径而不是装作知道。
 */
export interface NameRegistry {
  itemsByName?: Record<string, unknown>;
  blocksByName?: Record<string, unknown>;
}

/** `name` 是不是 registry 里的真实物品/方块 id */
export function isRealId(reg: NameRegistry | null | undefined, name: string): boolean {
  return reg != null
    && (reg.itemsByName?.[name] !== undefined || reg.blocksByName?.[name] !== undefined);
}

/**
 * 注册表中存在的物品 id 只作精确匹配；其余查询按 `_query` 后缀匹配类别。
 * 材料选择与放置核对共用此规则。
 */
export function matchMaterialName(
  reg: NameRegistry | null | undefined,
  query: string,
  name: string,
): boolean {
  if (name === query) return true;
  if (isRealId(reg, query)) return false;
  return name.endsWith(`_${query}`);
}

function chestKey(dimension: string, p: { x: number; y: number; z: number }): string {
  return `${dimension}:${p.x},${p.y},${p.z}`;
}

/** 容量包括空槽和同种物品的未满栈；stackMax 必须取自物品注册表。 */
export function hasRoom(rec: ChestRecord, item: string, stackMax: number): boolean {
  if (rec.usedSlots < rec.slots) return true;
  return rec.items.some((i) => matchItemName(item, i.name) && i.count % stackMax !== 0);
}

export function hasItem(rec: ChestRecord, item: string): boolean {
  return rec.items.some((i) => matchItemName(item, i.name) && i.count > 0);
}

export class ChestBook {
  private readonly map = new Map<string, ChestRecord>();

  constructor(private readonly file: string | null) {
    this.load();
  }

  get(dimension: string, p: { x: number; y: number; z: number }): ChestRecord | undefined {
    return this.map.get(chestKey(dimension, p));
  }

  remember(
    dimension: string,
    p: { x: number; y: number; z: number },
    items: ItemStack[],
    usedSlots: number,
    slots: number,
  ): void {
    // 重开箱子只刷新内容,别把「这是我放的」那份来历冲掉
    const prev = this.map.get(chestKey(dimension, p));
    const rec: ChestRecord = {
      x: p.x, y: p.y, z: p.z, dimension, items, usedSlots, slots,
      ...(prev?.name !== undefined ? { name: prev.name } : {}),
      ...(prev?.placedAt !== undefined ? { placedAt: prev.placedAt } : {}),
    };
    this.map.set(chestKey(dimension, p), rec);
    this.save();
  }

  /**
   * 工作站入账(自备的工作台/熔炉,或右键认出来的容器方块名)。
   * 只登来历与名字,不动已记的内容;placedAt 给了才写(= 这一座是我们自己放的)。
   */
  rememberStation(
    dimension: string,
    p: { x: number; y: number; z: number },
    name: string,
    placedAt?: number,
  ): void {
    const k = chestKey(dimension, p);
    const prev = this.map.get(k);
    this.map.set(k, {
      x: p.x, y: p.y, z: p.z, dimension,
      items: prev?.items ?? [],
      usedSlots: prev?.usedSlots ?? 0,
      slots: prev?.slots ?? 0,
      name,
      ...(placedAt !== undefined ? { placedAt } : prev?.placedAt !== undefined ? { placedAt: prev.placedAt } : {}),
      ...(prev?.furnace !== undefined ? { furnace: prev.furnace } : {}),
    });
    this.save();
  }

  /**
   * 炉子的三槽位读数入账。`expectedDoneAt` 由调用方按「每件几秒 × 件数」算好传进来
   * (账本不持有时钟);null = 输入槽空着。items 同步成非空槽的清单,快照那行照读。
   */
  rememberFurnace(
    dimension: string,
    p: { x: number; y: number; z: number },
    name: string,
    state: { input: ItemStack | null; fuel: ItemStack | null; output: ItemStack | null },
    loadedAt: number,
    expectedDoneAt: number | null,
  ): void {
    const k = chestKey(dimension, p);
    const prev = this.map.get(k);
    const items = [state.input, state.fuel, state.output].filter((s): s is ItemStack => s !== null);
    this.map.set(k, {
      x: p.x, y: p.y, z: p.z, dimension,
      items, usedSlots: items.length, slots: 3,
      name,
      ...(prev?.placedAt !== undefined ? { placedAt: prev.placedAt } : {}),
      furnace: { ...state, loadedAt, expectedDoneAt },
    });
    this.save();
  }

  /** 到点没报过的炉子(expectedDoneAt ≤ now 且没发过到期事件) */
  due(now: number): ChestRecord[] {
    const out: ChestRecord[] = [];
    for (const rec of this.map.values()) {
      const f = rec.furnace;
      if (f && f.expectedDoneAt !== null && f.expectedDoneAt <= now && !f.notified) out.push(rec);
    }
    return out;
  }

  /** 到期事件发过了:同一炉不重复报 */
  markNotified(dimension: string, p: { x: number; y: number; z: number }): void {
    const rec = this.map.get(chestKey(dimension, p));
    if (!rec?.furnace || rec.furnace.notified) return;
    rec.furnace.notified = true;
    this.save();
  }

  /** 记着的东西还有哪些槽里有料的炉子(preempt 回执点名用) */
  loadedFurnaces(dimension: string): ChestRecord[] {
    const out: ChestRecord[] = [];
    for (const rec of this.map.values()) {
      const f = rec.furnace;
      if (rec.dimension !== dimension || !f) continue;
      if (f.input || f.output) out.push(rec);
    }
    return out;
  }

  /**
   * 当前维度账上的箱子族，不含炉子族与工作台。
   * 记录表示上次看见的状态，调用方须按历史读数措辞。
   */
  chestsIn(dimension: string): ChestRecord[] {
    const out: ChestRecord[] = [];
    for (const rec of this.map.values()) {
      if (rec.dimension !== dimension || rec.furnace) continue;
      if (CHEST_KINDS.has(chestBlockName(rec))) out.push(rec);
    }
    return out;
  }

  /** 方块被挖掉了:这一条从账上划掉。没记过就什么都不做(也不写盘) */
  forget(dimension: string, p: { x: number; y: number; z: number }): boolean {
    const removed = this.map.delete(chestKey(dimension, p));
    if (removed) this.save();
    return removed;
  }

  /** 落在这批格子里的账目(几何族试算点名工作站用) */
  inCells(dimension: string, cells: ReadonlyArray<{ x: number; y: number; z: number }>): ChestRecord[] {
    if (this.map.size === 0) return [];
    const keys = new Set(cells.map((c) => chestKey(dimension, c)));
    const out: ChestRecord[] = [];
    for (const [k, rec] of this.map) {
      if (keys.has(k)) out.push(rec);
    }
    return out;
  }

  /**
   * 这个维度账面上的合计:物品名 → 数量(蓝图三分账单的「在箱」那一栏读它)。
   * 口径与账本本身一致 —— 全是「上次看见」,不是此刻的真值,调用方措辞照此。
   */
  tally(dimension: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const rec of this.map.values()) {
      if (rec.dimension !== dimension) continue;
      for (const it of rec.items) out[it.name] = (out[it.name] ?? 0) + it.count;
    }
    return out;
  }

  stat(): string {
    const n = this.map.size;
    if (!this.file || !existsSync(this.file)) return n === 0 ? '(无文件)' : `${n} 个(未落盘)`;
    const kb = (this.fileSize() / 1024).toFixed(1);
    return `${n} 个 / ${kb}KB`;
  }

  clear(): string {
    const n = this.map.size;
    this.map.clear();
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, '{}\n', 'utf8');
    }
    return n === 0 ? '容器账本是空的' : `容器账本已清空(${n} 个)`;
  }

  private fileSize(): number {
    return statSync(this.file!).size;
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    const raw = readFileSync(this.file, 'utf8').trim();
    if (!raw) return;
    const data = JSON.parse(raw) as Record<string, ChestRecord>;
    for (const [k, v] of Object.entries(data)) {
      if (typeof v?.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number') {
        const f = v.furnace;
        this.map.set(k, {
          x: v.x, y: v.y, z: v.z,
          dimension: typeof v.dimension === 'string' ? v.dimension : 'overworld',
          items: Array.isArray(v.items) ? v.items : [],
          usedSlots: typeof v.usedSlots === 'number' ? v.usedSlots : 0,
          slots: typeof v.slots === 'number' ? v.slots : 27,
          ...(typeof v.name === 'string' ? { name: v.name } : {}),
          ...(typeof v.placedAt === 'number' ? { placedAt: v.placedAt } : {}),
          ...(f && typeof f === 'object' ? {
            furnace: {
              input: f.input ?? null,
              fuel: f.fuel ?? null,
              output: f.output ?? null,
              loadedAt: typeof f.loadedAt === 'number' ? f.loadedAt : 0,
              expectedDoneAt: typeof f.expectedDoneAt === 'number' ? f.expectedDoneAt : null,
              ...(f.notified === true ? { notified: true } : {}),
            },
          } : {}),
        });
      }
    }
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const obj: Record<string, ChestRecord> = {};
    for (const [k, v] of this.map) obj[k] = v;
    writeFileSync(this.file, `${JSON.stringify(obj)}\n`, 'utf8');
  }
}
