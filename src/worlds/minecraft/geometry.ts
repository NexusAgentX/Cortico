/**
 * 锚点几何:build / excavate / probe 共用的形状语言。
 *
 * 坐标写绝对数字,或 "~"/"~±n" 相对写法。相对的原点是**这一步开始执行那一刻**
 * 我脚下那一格——`goto` 之后位置是确定的,"走到那儿再往下挖"这类链子照写。
 * 没有朝向相对写法(前/左/右):寻路一路在转朝向,下令那一刻无法预知执行时朝哪。
 *
 * 栅格化是纯函数:同一份 spec 永远铺出同一批格子,执行器与试算(dryRun)
 * 共用,不会各说各话。
 */

export interface Cell { x: number; y: number; z: number }

/** 一个坐标分量:绝对数字,或 "~"/"~±n" 相对写法 */
export type AnchorCoord = number | string;
export type Anchor = [AnchorCoord, AnchorCoord, AnchorCoord];

/**
 * 方块的六个面,名字取原版:`up`/`down`/`north`/`south`/`west`/`east`。
 *
 * 原版放置就是"点已有方块的一个面",新方块落在那一面的外侧——协议里是
 * `use_item_on { position, face, cursor }`,mineflayer 是 `placeBlock(参照方块, 面向量)`。
 * 值是该面的**外法向量**:参照方块 + 向量 = 新方块那一格。
 * 声明顺序即协议里 Direction 的 0-5。
 * (把握:六个面名=确定;down/up/north/south/west/east 的枚举序=确定)
 */
export type BlockFace = 'down' | 'up' | 'north' | 'south' | 'west' | 'east';

export const BLOCK_FACES: Record<BlockFace, readonly [number, number, number]> = {
  down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1],
  south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0],
};

export const FACE_NAMES = Object.keys(BLOCK_FACES) as BlockFace[];

/** 贴着参照方块的某一面放,新方块落在哪一格 */
export function cellOnFace(ref: Cell, face: BlockFace): Cell {
  const [dx, dy, dz] = BLOCK_FACES[face];
  return { x: ref.x + dx, y: ref.y + dy, z: ref.z + dz };
}

export type ShapeName = 'line' | 'rect' | 'triangle' | 'arc' | 'box';

/**
 * 长方体的填充方式,词取原版 `/fill` 的模式名:`solid` 全填、`outline` 只动外壳而
 * 内部原样。原版另有一个 `hollow`——外壳 + **内部清成空气**,我们没有这个模式,所以
 * 这个词一个字都不出现:占着原版的词给另一套意思比自造一个词更糟,自造词只是让先验
 * 失效,假朋友会让先验主动给出反向答案。`edges`(12 条棱)原版 /fill 没有对应模式,
 * 是自造词,与 outline 配一对读得出是面还是棱。
 * (把握:原版 hollow 与 outline 的分别=确定;/fill 没有棱模式=确定)
 */
export type BoxFill = 'solid' | 'outline' | 'edges';

/** 每种形状要几个锚点 */
export const ANCHOR_COUNT: Record<ShapeName, number> = { line: 2, rect: 2, triangle: 3, arc: 3, box: 2 };

export const SHAPE_NAMES = Object.keys(ANCHOR_COUNT) as ShapeName[];

/** 单个坐标分量:数字向下取整,"~±n" 相对 origin 解析;认不出返回 null */
function resolveCoord(v: AnchorCoord, origin: number): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.floor(v) : null;
  const s = v.trim();
  if (s === '~') return origin;
  if (s.startsWith('~')) {
    const off = Number(s.slice(1));
    return Number.isFinite(off) ? origin + Math.floor(off) : null;
  }
  const abs = Number(s);
  return Number.isFinite(abs) && s !== '' ? Math.floor(abs) : null;
}

/** 锚点 → 格坐标;origin 是我脚下那一格。解析失败返回错误话术 */
export function resolveAnchors(
  anchors: readonly Anchor[],
  origin: Cell,
): Cell[] | { error: string } {
  const out: Cell[] = [];
  for (const [i, a] of anchors.entries()) {
    const x = resolveCoord(a[0], origin.x);
    const y = resolveCoord(a[1], origin.y);
    const z = resolveCoord(a[2], origin.z);
    if (x === null || y === null || z === null) {
      return { error: `第 ${i + 1} 个锚点认不出来(写数字,或 "~"/"~-3")` };
    }
    out.push({ x, y, z });
  }
  return out;
}

const key = (c: Cell): string => `${c.x},${c.y},${c.z}`;

/** 去重收集器:铺格子的顺序即返回顺序 */
class CellSet {
  private seen = new Set<string>();
  readonly cells: Cell[] = [];
  add(x: number, y: number, z: number): void {
    const c = { x: Math.round(x), y: Math.round(y), z: Math.round(z) };
    const k = key(c);
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.cells.push(c);
  }
}

/** 两点连线:按最长轴步进插值取整,连续无跳格 */
function lineInto(out: CellSet, a: Cell, b: Cell): void {
  const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z));
  if (n === 0) { out.add(a.x, a.y, a.z); return; }
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.add(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
  }
}

type Vec = [number, number, number];
const sub = (a: Cell, b: Cell): Vec => [a.x - b.x, a.y - b.y, a.z - b.z];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Vec, s: number): Vec => [a[0] * s, a[1] * s, a[2] * s];
const add3 = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/**
 * 过三点的圆弧:从第 1 点经第 2 点到第 3 点。三点共线铺不出圆,返回错误。
 * 圆心用外心公式在三点平面内解;采样步距 <1 格保证连续。
 */
function arcInto(out: CellSet, a: Cell, b: Cell, c: Cell): { error: string } | null {
  const v1 = sub(b, a);
  const v2 = sub(c, a);
  const n = cross(v1, v2);
  const n2 = dot(n, n);
  if (n2 < 1e-9) return { error: '三个锚点在一条直线上,画不出弧——直的用 line' };
  // 外心 = a + (|v1|²(v2×n) + |v2|²(n×v1)) / (2|n|²)
  const center = add3(
    [a.x, a.y, a.z],
    scale(add3(scale(cross(v2, n), dot(v1, v1)), scale(cross(n, v1), dot(v2, v2))), 1 / (2 * n2)),
  );
  const ca: Vec = [a.x - center[0], a.y - center[1], a.z - center[2]];
  const r = Math.sqrt(dot(ca, ca));
  // 平面内正交基:u 指向起点,w 与之垂直;点的角度 = atan2(·w, ·u)
  const u = scale(ca, 1 / r);
  const nHat = scale(n, 1 / Math.sqrt(n2));
  const w = cross(nHat, u);
  const angleOf = (p: Cell): number => {
    const v: Vec = [p.x - center[0], p.y - center[1], p.z - center[2]];
    const ang = Math.atan2(dot(v, w), dot(v, u));
    return ang < 0 ? ang + 2 * Math.PI : ang;
  };
  const angB = angleOf(b);
  const angC = angleOf(c);
  // 起点角为 0;扫向必须经过 b:b 在 c 之前就正着扫,否则反着扫
  const sweep = angB <= angC ? angC : angC - 2 * Math.PI;
  const steps = Math.max(2, Math.ceil(r * Math.abs(sweep) * 1.5));
  for (let i = 0; i <= steps; i++) {
    const ang = (sweep * i) / steps;
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    out.add(
      center[0] + r * (u[0] * cos + w[0] * sin),
      center[1] + r * (u[1] * cos + w[1] * sin),
      center[2] + r * (u[2] * cos + w[2] * sin),
    );
  }
  return null;
}

/**
 * 形状 → 格子清单。锚点须已解析为绝对格坐标(resolveAnchors)。
 * 返回顺序:line/arc 沿走向,rect/box 逐层,triangle 扇形填充。
 */
export function rasterize(
  shape: ShapeName,
  anchors: readonly Cell[],
  fill: BoxFill = 'solid',
): Cell[] | { error: string } {
  if (anchors.length !== ANCHOR_COUNT[shape]) {
    return { error: `${shape} 要 ${ANCHOR_COUNT[shape]} 个锚点,给了 ${anchors.length} 个` };
  }
  const out = new CellSet();
  switch (shape) {
    case 'line': {
      lineInto(out, anchors[0], anchors[1]);
      break;
    }
    case 'rect': {
      const [a, b] = anchors;
      const flat = (['x', 'y', 'z'] as const).filter((ax) => a[ax] === b[ax]);
      if (flat.length === 0) {
        return { error: 'rect 两个锚点要有一轴相等(相等的那一轴就是面的朝向)——斜面用 triangle 拼' };
      }
      for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) {
        for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) {
          for (let z = Math.min(a.z, b.z); z <= Math.max(a.z, b.z); z++) out.add(x, y, z);
        }
      }
      break;
    }
    case 'triangle': {
      // 扇形填充:第 1 点向对边每一格连线
      const edge = new CellSet();
      lineInto(edge, anchors[1], anchors[2]);
      for (const p of edge.cells) lineInto(out, anchors[0], p);
      break;
    }
    case 'arc': {
      const err = arcInto(out, anchors[0], anchors[1], anchors[2]);
      if (err) return err;
      break;
    }
    case 'box': {
      const [a, b] = anchors;
      const lo = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) };
      const hi = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) };
      for (let x = lo.x; x <= hi.x; x++) {
        for (let y = lo.y; y <= hi.y; y++) {
          for (let z = lo.z; z <= hi.z; z++) {
            // 处在边界的轴数:0=内部 1=面上 2=棱上 3=角上
            const onFace = (x === lo.x || x === hi.x ? 1 : 0)
              + (y === lo.y || y === hi.y ? 1 : 0)
              + (z === lo.z || z === hi.z ? 1 : 0);
            if (fill === 'solid' || (fill === 'outline' ? onFace >= 1 : onFace >= 2)) out.add(x, y, z);
          }
        }
      }
      break;
    }
  }
  return out.cells;
}
