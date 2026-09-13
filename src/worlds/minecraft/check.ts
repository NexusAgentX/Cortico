/**
 * mc_check:她出一组断言,系统对照世界,回执只报差异。与 dryRun 对偶——那个是动手
 * 之前试算,这个是做完之后对账。
 *
 * 全部纯函数:世界数据由调用方经 `CheckWorld` 喂进来,这里不认识 bot、不寻路、
 * 不改动任何东西,也不等待——只读已加载区块,读不到的格照实说"没加载"。
 *
 * 几条口径,代码按它写:
 * - 方块比对一律 **id 级**:朝向、连接面这些由邻居决定的属性不参与,不然一堵砌好的
 *   墙会因为服务端算出来的 `north=true` 被判成不符;
 * - **没加载 ≠ 不符**,也 ≠ 符合。它自成一档结论,在回执里单独一句;
 * - `sealed` 的通路判定按**能不能灌进来**算,所以水和岩浆算通路,不算墙。
 */

import { blueprintStepStateMatches, diffBlueprint, type BlueprintPlan } from './blueprint-plan.ts';
import { blockIdOf, isAirState, type NormalizedBlueprint, type PositionXYZ } from './blueprint.ts';
import type { ItemEnchant } from './item-facts.ts';
import { roman, zhDimension, zhEnchant, zhName } from './names.ts';

/** 一次调用最多几条断言。她一口气想核对的东西超过这个数,该分两次核 */
export const CHECK_MAX_ASSERTS = 16;
/** 单条区域断言的格数上限(沿用蓝图回读那一档) */
export const CHECK_BOX_CELL_CAP = 4096;
/** sealed 洪泛的体积上限;它按格走不按格读,所以比区域断言宽一档 */
export const CHECK_SEALED_VOLUME_CAP = 32 * 32 * 32;
/** 一条不符的断言最多点几处名 */
const CHECK_SAMPLE_CAP = 6;
/** 漏口最多点几处名 */
const CHECK_LEAK_SAMPLE_CAP = 3;

/** 空气族:她写 `air` 指的是"该空着",三种空气都算空着 */
const AIR_IDS = new Set(['air', 'cave_air', 'void_air']);

const LIQUID_IDS = new Set(['water', 'lava', 'bubble_column']);

function isLiquidId(id: string): boolean {
  return LIQUID_IDS.has(id);
}

// ── 世界取用面 ────────────────────────────────────────────────────────────────

/** 一格现状。`state` 带属性(蓝图对账要它),`solid` 是碰撞箱占满整格 */
export interface CheckCell {
  state: string;
  solid: boolean;
}

/** 一份蓝图在这个世界的施工面;没装载给 null,装载了没开工给 anchor: null */
export interface CheckSite {
  key: string;
  name: string | null;
  blueprint: NormalizedBlueprint;
  plan: BlueprintPlan;
  anchor: PositionXYZ | null;
}

/** 一处路标的核验结论(module 那边 checkMark 的结果摊平进来) */
export interface CheckMarkProbe {
  name: string;
  kind: string;
  dimension: string;
  pos: PositionXYZ;
  verdict: 'ok' | 'mismatch' | 'unloaded' | 'other-dimension' | 'unchecked';
  /** 对不上时那一格现在是什么(中文名) */
  found: string | null;
}

export interface CheckWorld {
  /** 世界坐标一格;区块没加载、读不到 → null */
  cell(x: number, y: number, z: number): CheckCell | null;
  /** 背包现有:物品名 → 个数 */
  inventory(): ReadonlyMap<string, number>;
  /**
   * 背包里叫这个名字的每一摞各带什么附魔(一摞一条,没附魔的是空数组)。
   * 不接 = 这个部署读不到附魔,`enchant` 断言如实说读不到,不拿「没有」冒充。
   */
  enchantsOf?: (item: string) => ItemEnchant[][];
  /** 这一版认不认得这个方块名;拿不到 registry 时不给,断言就不做名字校验 */
  knowsBlock?: (id: string) => boolean;
  site(key: string): CheckSite | null;
  mark(name: string): CheckMarkProbe | null;
}

// ── 断言 ──────────────────────────────────────────────────────────────────────

type CheckCompare = { op: '=' | '>=' | '<='; n: number };

type CheckAssert =
  | { kind: 'at'; at: PositionXYZ; is: string }
  | { kind: 'count'; box: CheckBox; want: Array<{ id: string } & CheckCompare> }
  | { kind: 'all'; box: CheckBox; is: string }
  | { kind: 'air'; box: CheckBox }
  | { kind: 'sealed'; box: CheckBox; from: PositionXYZ | null }
  | { kind: 'inv'; want: Array<{ item: string; enchant?: string } & CheckCompare> }
  | { kind: 'blueprint'; key: string }
  | { kind: 'mark'; name: string };

/** 已归正的盒子:min 各轴都不大于 max */
interface CheckBox {
  min: PositionXYZ;
  max: PositionXYZ;
}

/** 一条断言的受理结果:收下了,或者这一条就地报错(不废整单) */
export type CheckParsed = { ok: true; assert: CheckAssert } | { ok: false; error: string };

function posText(p: readonly [number, number, number]): string {
  return `(${p[0]}, ${p[1]}, ${p[2]})`;
}

function boxText(box: CheckBox): string {
  return `${posText(box.min)}–${posText(box.max)}`;
}

function boxCells(box: CheckBox): number {
  return (box.max[0] - box.min[0] + 1) * (box.max[1] - box.min[1] + 1) * (box.max[2] - box.min[2] + 1);
}

/** 世界侧读回来的状态串 → 纯 id(去前缀去属性) */
function idOf(state: string): string {
  return blockIdOf(state).replace(/^minecraft:/, '');
}

/** 她写的方块名归正:`minecraft:Chest` / ` chest ` 都收 */
function parseBlockId(value: unknown, path: string): string | { error: string } {
  if (typeof value !== 'string' || value.trim() === '') return { error: `${path} 要一个方块名` };
  return value.trim().toLowerCase().replace(/^minecraft:/, '');
}

function parsePos(value: unknown, path: string): PositionXYZ | { error: string } {
  if (!Array.isArray(value) || value.length !== 3) return { error: `${path} 要 [x, y, z] 三个整数` };
  const out = value.map((v) => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : null));
  if (out.some((v) => v === null)) return { error: `${path} 要 [x, y, z] 三个整数` };
  return out as PositionXYZ;
}

/** `box: [[x1,y1,z1],[x2,y2,z2]]`;两端谁大谁小随便写,这里归正 */
function parseBox(value: unknown): CheckBox | { error: string } {
  if (!Array.isArray(value) || value.length !== 2) {
    return { error: 'box 要 [[x1,y1,z1],[x2,y2,z2]] 两个角' };
  }
  const a = parsePos(value[0], 'box 的第一个角');
  if ('error' in a) return a;
  const b = parsePos(value[1], 'box 的第二个角');
  if ('error' in b) return b;
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  };
}

/** 计数值:整数 = 恰好这么多;`">=8"` / `"<=2"` = 一侧的界 */
function parseCompare(value: unknown, path: string): CheckCompare | { error: string } {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return { op: '=', n: value };
  if (typeof value === 'string') {
    const m = /^\s*(>=|<=|=)?\s*(\d+)\s*$/.exec(value);
    if (m) return { op: (m[1] === '=' || m[1] === undefined ? '=' : m[1]) as CheckCompare['op'], n: Number(m[2]) };
  }
  return { error: `${path} 要一个非负整数,或者 ">=8" / "<=2" 这样的界` };
}

function compareText(c: CheckCompare): string {
  return c.op === '=' ? `${c.n}` : `${c.op === '>=' ? '≥' : '≤'}${c.n}`;
}

function compareHolds(c: CheckCompare, actual: number): boolean {
  return c.op === '=' ? actual === c.n : c.op === '>=' ? actual >= c.n : actual <= c.n;
}

function parseWantMap(
  raw: unknown,
  field: string,
): Array<{ key: string } & CheckCompare> | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: `${field} 要一个 {"名字": 个数} 对象` };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return { error: `${field} 是空的,没有东西可对` };
  const out: Array<{ key: string } & CheckCompare> = [];
  for (const [name, value] of entries) {
    const key = name.trim().toLowerCase().replace(/^minecraft:/, '');
    if (key === '') return { error: `${field} 里有一个空名字` };
    const cmp = parseCompare(value, `${field}["${name}"]`);
    if ('error' in cmp) return cmp;
    out.push({ key, ...cmp });
  }
  return out;
}

/**
 * `inv` 的值有两形:个数(`4` / `">=8"`),或 `{"enchant":"efficiency"}` 那种
 * 「带这个附魔的有几件」。后者不写 count 时按「至少一件」。
 */
function parseInvWant(
  raw: unknown,
): Array<{ item: string; enchant?: string } & CheckCompare> | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'inv 要一个 {"名字": 个数} 对象' };
  }
  const out: Array<{ item: string; enchant?: string } & CheckCompare> = [];
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return { error: 'inv 是空的,没有东西可对' };
  for (const [name, value] of entries) {
    const item = name.trim().toLowerCase().replace(/^minecraft:/, '');
    if (item === '') return { error: 'inv 里有一个空名字' };
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const body = value as Record<string, unknown>;
      const enchant = typeof body.enchant === 'string' ? body.enchant.trim().toLowerCase() : '';
      if (enchant === '') return { error: `inv["${name}"] 那个对象要一个 enchant 附魔名` };
      const cmp = body.count === undefined
        ? { op: '>=' as const, n: 1 }
        : parseCompare(body.count, `inv["${name}"].count`);
      if ('error' in cmp) return cmp;
      out.push({ item, enchant: enchant.replace(/^minecraft:/, ''), ...cmp });
      continue;
    }
    const cmp = parseCompare(value, `inv["${name}"]`);
    if ('error' in cmp) return cmp;
    out.push({ item, ...cmp });
  }
  return out;
}

/** 一条断言的受理。**认不出形状就报错**,不猜她想核对什么 */
export function parseAssert(raw: unknown, knowsBlock?: (id: string) => boolean): CheckParsed {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: '一条断言要一个对象' };
  }
  const body = raw as Record<string, unknown>;
  const unknownName = (id: string): string | null =>
    knowsBlock && !knowsBlock(id) && !AIR_IDS.has(id) ? `这一版里没有叫「${id}」的方块` : null;

  if (body.at !== undefined) {
    const at = parsePos(body.at, 'at');
    if ('error' in at) return { ok: false, error: at.error };
    const is = parseBlockId(body.is, 'is');
    if (typeof is === 'object') return { ok: false, error: is.error };
    const bad = unknownName(is);
    if (bad) return { ok: false, error: bad };
    return { ok: true, assert: { kind: 'at', at, is } };
  }

  if (body.inv !== undefined) {
    const want = parseInvWant(body.inv);
    if ('error' in want) return { ok: false, error: want.error };
    return { ok: true, assert: { kind: 'inv', want } };
  }

  if (body.blueprint !== undefined) {
    if (typeof body.blueprint !== 'string' || body.blueprint.trim() === '') {
      return { ok: false, error: 'blueprint 要一个蓝图键' };
    }
    return { ok: true, assert: { kind: 'blueprint', key: body.blueprint.trim() } };
  }

  if (body.mark !== undefined) {
    if (typeof body.mark !== 'string' || body.mark.trim() === '') {
      return { ok: false, error: 'mark 要一个路标名' };
    }
    return { ok: true, assert: { kind: 'mark', name: body.mark.trim() } };
  }

  if (body.box === undefined) {
    return { ok: false, error: '认不出这条断言:要 at / box / inv / blueprint / mark 之一' };
  }
  const box = parseBox(body.box);
  if ('error' in box) return { ok: false, error: box.error };

  if (body.sealed !== undefined) {
    if (body.sealed !== true) return { ok: false, error: 'sealed 只收 true' };
    if (boxCells(box) > CHECK_SEALED_VOLUME_CAP) {
      return {
        ok: false,
        error: `这个盒子 ${boxCells(box)} 格,超过一次能洪泛的 ${CHECK_SEALED_VOLUME_CAP} 格,分块再对`,
      };
    }
    let from: PositionXYZ | null = null;
    if (body.from !== undefined) {
      const parsed = parsePos(body.from, 'from');
      if ('error' in parsed) return { ok: false, error: parsed.error };
      const inside = parsed.every((v, i) => v >= box.min[i] && v <= box.max[i]);
      if (!inside) return { ok: false, error: `from ${posText(parsed)} 不在 ${boxText(box)} 里面` };
      from = parsed;
    }
    return { ok: true, assert: { kind: 'sealed', box, from } };
  }

  if (boxCells(box) > CHECK_BOX_CELL_CAP) {
    return {
      ok: false,
      error: `这个区域 ${boxCells(box)} 格,超过一次能对的 ${CHECK_BOX_CELL_CAP} 格,分块再对`,
    };
  }

  if (body.count !== undefined) {
    const want = parseWantMap(body.count, 'count');
    if ('error' in want) return { ok: false, error: want.error };
    for (const { key } of want) {
      const bad = unknownName(key);
      if (bad) return { ok: false, error: bad };
    }
    return { ok: true, assert: { kind: 'count', box, want: want.map(({ key, ...c }) => ({ id: key, ...c })) } };
  }
  if (body.all !== undefined) {
    const is = parseBlockId(body.all, 'all');
    if (typeof is === 'object') return { ok: false, error: is.error };
    const bad = unknownName(is);
    if (bad) return { ok: false, error: bad };
    return { ok: true, assert: { kind: 'all', box, is } };
  }
  if (body.air !== undefined) {
    if (body.air !== true) return { ok: false, error: 'air 只收 true' };
    return { ok: true, assert: { kind: 'air', box } };
  }
  return { ok: false, error: '给了 box 但没说要对什么:count / all / air / sealed 选一个' };
}

/** 整单受理。`checks` 不成形是整单的错;单条不成形只坏那一条 */
export function parseChecks(
  args: Record<string, unknown>,
  knowsBlock?: (id: string) => boolean,
): CheckParsed[] | { error: string } {
  const raw = args.checks;
  if (!Array.isArray(raw)) return { error: 'checks 要一个断言数组' };
  if (raw.length === 0) return { error: 'checks 是空的,没有东西可对' };
  if (raw.length > CHECK_MAX_ASSERTS) {
    return { error: `一次最多 ${CHECK_MAX_ASSERTS} 条断言,这次给了 ${raw.length} 条;分几次对` };
  }
  return raw.map((item) => parseAssert(item, knowsBlock));
}

// ── 求值 ──────────────────────────────────────────────────────────────────────

/**
 * 一条断言的结论。`unknown` 是**区块没加载**那一档 —— 它既不算符合也不算不符,
 * 混进任何一边都会让她拿"这边什么都没有"当结论。
 */
export type CheckVerdict = 'ok' | 'bad' | 'unknown' | 'error';

export interface CheckResult {
  verdict: CheckVerdict;
  /** 这一条怎么念;`ok` 的那几条不进回执正文 */
  text: string;
}

function forEachBoxCell(box: CheckBox, fn: (x: number, y: number, z: number) => void): void {
  for (let y = box.min[1]; y <= box.max[1]; y++) {
    for (let z = box.min[2]; z <= box.max[2]; z++) {
      for (let x = box.min[0]; x <= box.max[0]; x++) fn(x, y, z);
    }
  }
}

function unloadedTail(n: number): string {
  return n > 0 ? `;另有 ${n} 格没加载,没对全` : '';
}

function evalAt(a: Extract<CheckAssert, { kind: 'at' }>, world: CheckWorld): CheckResult {
  const cell = world.cell(a.at[0], a.at[1], a.at[2]);
  if (!cell) return { verdict: 'unknown', text: `${posText(a.at)} 区块没加载,走近再对` };
  const actual = idOf(cell.state);
  const hit = AIR_IDS.has(a.is) ? AIR_IDS.has(actual) : actual === a.is;
  if (hit) return { verdict: 'ok', text: `${posText(a.at)} 是${zhName(a.is)}` };
  return { verdict: 'bad', text: `${posText(a.at)} 该是${zhName(a.is)},现在是${zhName(actual)}` };
}

function evalCount(a: Extract<CheckAssert, { kind: 'count' }>, world: CheckWorld): CheckResult {
  const tally = new Map<string, number>();
  let unloaded = 0;
  forEachBoxCell(a.box, (x, y, z) => {
    const cell = world.cell(x, y, z);
    if (!cell) { unloaded++; return; }
    const id = idOf(cell.state);
    tally.set(id, (tally.get(id) ?? 0) + 1);
  });
  const bad: string[] = [];
  const okBits: string[] = [];
  for (const want of a.want) {
    const actual = AIR_IDS.has(want.id)
      ? [...tally].filter(([id]) => AIR_IDS.has(id)).reduce((n, [, c]) => n + c, 0)
      : tally.get(want.id) ?? 0;
    const line = `${zhName(want.id)} ${actual}(要 ${compareText(want)})`;
    if (compareHolds(want, actual)) okBits.push(line);
    else bad.push(line);
  }
  const where = boxText(a.box);
  if (bad.length > 0) {
    return { verdict: 'bad', text: `${where} 里 ${bad.join('、')}${unloadedTail(unloaded)}` };
  }
  if (unloaded > 0) {
    return { verdict: 'unknown', text: `${where} 里 ${okBits.join('、')},但有 ${unloaded} 格没加载,数不准` };
  }
  return { verdict: 'ok', text: `${where} 里 ${okBits.join('、')}` };
}

function evalUniform(
  a: Extract<CheckAssert, { kind: 'all' | 'air' }>,
  world: CheckWorld,
): CheckResult {
  const wantAir = a.kind === 'air';
  const wantId = a.kind === 'air' ? 'air' : a.is;
  const offenders: string[] = [];
  let unloaded = 0;
  let bad = 0;
  let total = 0;
  forEachBoxCell(a.box, (x, y, z) => {
    total++;
    const cell = world.cell(x, y, z);
    if (!cell) { unloaded++; return; }
    const id = idOf(cell.state);
    if (wantAir ? AIR_IDS.has(id) : id === wantId) return;
    bad++;
    if (offenders.length < CHECK_SAMPLE_CAP) offenders.push(`${posText([x, y, z])} 是${zhName(id)}`);
  });
  const what = wantAir ? '空的' : zhName(wantId);
  if (bad > 0) {
    const more = bad > offenders.length ? `,还有 ${bad - offenders.length} 格` : '';
    return {
      verdict: 'bad',
      text: `${boxText(a.box)} ${total} 格里 ${bad} 格不是${what}:${offenders.join('、')}${more}`
        + unloadedTail(unloaded),
    };
  }
  if (unloaded > 0) {
    return {
      verdict: 'unknown',
      text: `${boxText(a.box)} 读到的 ${total - unloaded} 格都是${what},另有 ${unloaded} 格没加载,没对全`,
    };
  }
  return { verdict: 'ok', text: `${boxText(a.box)} ${total} 格都是${what}` };
}

/**
 * 封闭性:从盒内一点洪泛可通行格,能走到盒外就是漏。
 *
 * 漏口按**盒内那一格**报(她要堵的是这一格),盒外邻格只用来判定通不通。液体算
 * 通路:水会顺着灌进来,一堵"用水当墙"的房子不封闭。没加载的邻格既不算通也不算堵,
 * 单独记数说清没对全。
 */
function evalSealed(a: Extract<CheckAssert, { kind: 'sealed' }>, world: CheckWorld): CheckResult {
  const { box } = a;
  const inside = (x: number, y: number, z: number): boolean =>
    x >= box.min[0] && x <= box.max[0] && y >= box.min[1] && y <= box.max[1]
    && z >= box.min[2] && z <= box.max[2];
  const passable = (x: number, y: number, z: number): boolean | null => {
    const cell = world.cell(x, y, z);
    if (!cell) return null;
    return !cell.solid;
  };

  const start = a.from ?? findStart(box, world);
  if (!start) {
    return { verdict: 'error', text: `${boxText(a.box)} 里没有可站的空格(整个盒子是实心的,或者区块没加载)` };
  }
  if (passable(start[0], start[1], start[2]) === null) {
    return { verdict: 'unknown', text: `${posText(start)} 区块没加载,洪泛起不了步` };
  }
  if (passable(start[0], start[1], start[2]) === false) {
    return { verdict: 'error', text: `${posText(start)} 是实心的,从这里洪泛不起来;换一个 from` };
  }

  const seen = new Set<string>([start.join(',')]);
  const queue: PositionXYZ[] = [start];
  const leaks: PositionXYZ[] = [];
  let leakCount = 0;
  let liquidLeak = false;
  /** 读不到的格按坐标去重:同一格会被六个方向各碰一次 */
  const unloadedCells = new Set<string>();
  const steps: ReadonlyArray<PositionXYZ> = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  while (queue.length > 0) {
    const [x, y, z] = queue.shift()!;
    let leaked = false;
    for (const [dx, dy, dz] of steps) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      const cell = world.cell(nx, ny, nz);
      if (!cell) { unloadedCells.add(`${nx},${ny},${nz}`); continue; }
      if (cell.solid) continue;
      if (!inside(nx, ny, nz)) {
        leaked = true;
        if (isLiquidId(idOf(cell.state))) liquidLeak = true;
        continue;
      }
      const key = `${nx},${ny},${nz}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push([nx, ny, nz]);
    }
    if (leaked) {
      leakCount++;
      const self = world.cell(x, y, z);
      if (self && isLiquidId(idOf(self.state))) liquidLeak = true;
      if (leaks.length < CHECK_LEAK_SAMPLE_CAP) leaks.push([x, y, z]);
    }
  }

  if (leakCount > 0) {
    const nearest = leaks
      .map((p) => ({ p, d: Math.hypot(p[0] - start[0], p[1] - start[1], p[2] - start[2]) }))
      .sort((l, r) => l.d - r.d);
    const rest = nearest.slice(1).map((e) => posText(e.p));
    return {
      verdict: 'bad',
      text: `${boxText(box)} 不封闭:${leakCount} 个漏口,最近的在 ${posText(nearest[0].p)}`
        + `${rest.length > 0 ? `,还有 ${rest.join('、')}` : ''}`
        + `${liquidLeak ? '(液体按通路算,水会灌进来)' : ''}`
        + unloadedTail(unloadedCells.size),
    };
  }
  if (unloadedCells.size > 0) {
    return {
      verdict: 'unknown',
      text: `${boxText(box)} 目前没找到漏口,但周边 ${unloadedCells.size} 格没加载,没对全`,
    };
  }
  return { verdict: 'ok', text: `${boxText(box)} 封闭(从 ${posText(start)} 洪泛 ${seen.size} 格,没走出去)` };
}

/** 盒中心那一格;实心就在盒内找离中心最近的可通行格 */
function findStart(box: CheckBox, world: CheckWorld): PositionXYZ | null {
  const center: PositionXYZ = [
    Math.floor((box.min[0] + box.max[0]) / 2),
    Math.floor((box.min[1] + box.max[1]) / 2),
    Math.floor((box.min[2] + box.max[2]) / 2),
  ];
  const centerCell = world.cell(center[0], center[1], center[2]);
  if (centerCell && !centerCell.solid) return center;
  let bestPos: PositionXYZ | null = null;
  let bestDistance = Infinity;
  forEachBoxCell(box, (x, y, z) => {
    const cell = world.cell(x, y, z);
    if (!cell || cell.solid) return;
    const d = Math.hypot(x - center[0], y - center[1], z - center[2]);
    if (d < bestDistance) {
      bestDistance = d;
      bestPos = [x, y, z];
    }
  });
  return bestPos;
}

/** 背包断言按精确物品 id 计数，与 at/count 的核对口径一致。类别断言须逐项列出。 */
function evalInv(a: Extract<CheckAssert, { kind: 'inv' }>, world: CheckWorld): CheckResult {
  const inv = world.inventory();
  const bad: string[] = [];
  const okBits: string[] = [];
  for (const want of a.want) {
    if (want.enchant !== undefined) {
      if (!world.enchantsOf) {
        bad.push(`${zhName(want.item)} 的附魔读不到(这个部署没接附魔读数)`);
        continue;
      }
      const stacks = world.enchantsOf(want.item);
      const hits = stacks.filter((e) => e.some((one) => one.name === want.enchant));
      const seen = stacks.length === 0
        ? '包里没有这样东西'
        : stacks.map((e) => (e.length === 0 ? '没附魔' : e.map((o) => `${zhEnchant(o.name)}${roman(o.level)}`).join('·')))
          .join(' / ');
      const line = `${zhName(want.item)} 带${zhEnchant(want.enchant)}的 ${hits.length} 件`
        + `(要 ${compareText(want)};包里那几件:${seen})`;
      if (compareHolds(want, hits.length)) okBits.push(line);
      else bad.push(line);
      continue;
    }
    const actual = inv.get(want.item) ?? 0;
    const line = `${zhName(want.item)} ${actual}(要 ${compareText(want)})`;
    if (compareHolds(want, actual)) okBits.push(line);
    else bad.push(line);
  }
  if (bad.length > 0) return { verdict: 'bad', text: `包里现有:${bad.join('、')}` };
  return { verdict: 'ok', text: `包里现有:${okBits.join('、')}` };
}

/** 蓝图缺的那几格点名:「橡木木板 在 (x, y, z)」,按施工步序取前几处 */
function missingSamples(site: CheckSite, anchor: PositionXYZ, world: CheckWorld, cap: number): string[] {
  const out: string[] = [];
  for (const step of site.plan.steps) {
    for (let y = step.from[1]; y <= step.to[1] && out.length < cap; y++) {
      for (let z = step.from[2]; z <= step.to[2] && out.length < cap; z++) {
        for (let x = step.from[0]; x <= step.to[0] && out.length < cap; x++) {
          const pos: PositionXYZ = [anchor[0] + x, anchor[1] + y, anchor[2] + z];
          const cell = world.cell(pos[0], pos[1], pos[2]);
          if (!cell) continue;
          if (blueprintStepStateMatches(step, cell.state)) continue;
          out.push(`${zhName(blockIdOf(step.state))} 在 ${posText(pos)}`);
        }
      }
    }
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * 一份蓝图的现场对账:对上多少格、缺多少格(点名)、冲突多少格。
 * 没装载、没绑锚点都照实说 —— 这两种情况下没有可对的账,不拿 0/0 充数。
 */
export function blueprintCheckText(site: CheckSite | null, key: string, world: CheckWorld): CheckResult {
  if (!site) return { verdict: 'error', text: `蓝图「${key}」没装载,对不了` };
  if (!site.anchor) {
    return { verdict: 'error', text: `蓝图「${site.key}」在这个世界还没绑锚点(没开工过),没有工地可对` };
  }
  const anchor = site.anchor;
  const diff = diffBlueprint(
    site.blueprint,
    site.plan,
    anchor,
    (x, y, z) => world.cell(x, y, z)?.state ?? null,
    { checkAir: true, sampleLimit: CHECK_SAMPLE_CAP },
  );
  const conflicts = diff.conflictCounts['wrong-block'] + diff.conflictCounts['should-be-air'];
  const head = `蓝图「${site.key}」对上 ${diff.matched}/${diff.total} 格`;
  if (diff.missing === 0 && conflicts === 0 && diff.unknown === 0) {
    return { verdict: 'ok', text: `${head},整张图都到位了` };
  }
  const bits: string[] = [];
  if (diff.missing > 0) {
    const samples = missingSamples(site, anchor, world, CHECK_SAMPLE_CAP);
    bits.push(`缺 ${diff.missing} 格${samples.length > 0 ? `(${samples.join('、')}${diff.missing > samples.length ? ' 等' : ''})` : ''}`);
  }
  if (conflicts > 0) bits.push(`冲突 ${conflicts} 格`);
  if (diff.unknown > 0) bits.push(`${diff.unknown} 格没加载,没对全`);
  return {
    verdict: diff.missing > 0 || conflicts > 0 ? 'bad' : 'unknown',
    text: `${head};${bits.join(';')}`,
  };
}

function evalMark(a: Extract<CheckAssert, { kind: 'mark' }>, world: CheckWorld): CheckResult {
  const probe = world.mark(a.name);
  if (!probe) return { verdict: 'error', text: `路标表里没有「${a.name}」` };
  const where = `[${zhDimension(probe.dimension)}] ${posText(probe.pos)}`;
  switch (probe.verdict) {
    case 'ok':
      return { verdict: 'ok', text: `「${probe.name}」${where} 还是${probe.kind}` };
    case 'mismatch':
      return {
        verdict: 'bad',
        text: `「${probe.name}」登记的是${probe.kind},${where} 现在是${probe.found}`,
      };
    case 'unloaded':
      return { verdict: 'unknown', text: `「${probe.name}」${where} 区块没加载,走近再对` };
    case 'other-dimension':
      return { verdict: 'unknown', text: `「${probe.name}」在别的维度 ${where},当前维度没法核` };
    case 'unchecked':
      return {
        verdict: 'error',
        text: `「${probe.name}」是${probe.kind},世界里没有一格叫这个,核不了`,
      };
  }
}

export function evalAssert(assert: CheckAssert, world: CheckWorld): CheckResult {
  switch (assert.kind) {
    case 'at': return evalAt(assert, world);
    case 'count': return evalCount(assert, world);
    case 'all': case 'air': return evalUniform(assert, world);
    case 'sealed': return evalSealed(assert, world);
    case 'inv': return evalInv(assert, world);
    case 'blueprint': return blueprintCheckText(world.site(assert.key), assert.key, world);
    case 'mark': return evalMark(assert, world);
  }
}

/**
 * 整单回执:先一句总账,符合的合并成一句带过,其余逐条点名。
 *
 * 只报差异是这个工具存在的理由 —— 符合的那几条逐条复述回去,省下来的上下文就还回去了。
 */
export function renderChecks(parsed: readonly CheckParsed[], world: CheckWorld): string {
  const lines: Array<{ n: number; result: CheckResult }> = parsed.map((item, i) => ({
    n: i + 1,
    result: item.ok ? evalAssert(item.assert, world) : { verdict: 'error' as const, text: item.error },
  }));
  const by = (v: CheckVerdict): typeof lines => lines.filter((l) => l.result.verdict === v);
  const ok = by('ok');
  const bad = by('bad');
  const unknown = by('unknown');
  const errored = by('error');

  const head = [
    `对账 ${lines.length} 条`,
    [
      `${ok.length} 条符合`,
      bad.length > 0 ? `${bad.length} 条不符` : '',
      unknown.length > 0 ? `${unknown.length} 条没对上(区块没加载)` : '',
      errored.length > 0 ? `${errored.length} 条没受理` : '',
    ].filter(Boolean).join('、'),
  ].join(':');

  const body = [...bad, ...unknown, ...errored]
    .sort((l, r) => l.n - r.n)
    .map((l) => `#${l.n} ${l.result.text}`);
  return body.length === 0 ? `${head}。` : `${head}。\n${body.join('\n')}`;
}
