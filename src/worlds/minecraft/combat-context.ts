/**
 * 上下文图(context steering,Fray,Game AI Pro 2 ch.18)的纯逻辑层。
 * 从战斗台架原样搬入(scratch/mc-bench/combat/context.ts,300+ 场实测),别按直觉改。
 *
 * 为什么不用 if/else 模式机:台架前四轮里每加一条战术就打断另一条——避障行为
 * 为了鲁棒必须独占运行,于是主导了全部移动,加优先级或权重只是让某个行为喊得更大声。
 * 根因不是实现差,是「行为返回决策」这件事本身:框架手里没有信息可以合并决策。
 *
 * 解法:行为不返回决策,只往两张共享的图里写「上下文」——
 *   interest 图:我多想往这个方向走
 *   danger   图:往这个方向走有多糟
 * 由一个统一的处理器裁决。硬约束走 masking,不走权重。
 *
 * 这一层不碰 mineflayer,方向数学的符号错误不会报错,只会让人朝反方向走,
 * 在战斗数据里表现成「这条战术没用」——最难查的那类,靠断言钉住(combat-context.test)。
 */

/** 槽数。次槽插值之后 16 槽足够给出连续方向 */
export const SLOTS = 16;

/** 硬危险:永远排除,不参与「最低危险 + 容差」的比较。地形/苦力怕圈用它 */
export const HARD = 1e6;

export type Map16 = Float64Array;

export function newMap(): Map16 {
  return new Float64Array(SLOTS);
}

/** 槽 i 对应的世界方向(x,z 平面单位向量) */
export function slotDir(i: number): { x: number; z: number } {
  const a = (i / SLOTS) * Math.PI * 2;
  return { x: Math.cos(a), z: Math.sin(a) };
}

/** 世界方向落在哪个槽(可为小数) */
export function dirSlot(dx: number, dz: number): number {
  const a = Math.atan2(dz, dx);
  const s = (a / (Math.PI * 2)) * SLOTS;
  return ((s % SLOTS) + SLOTS) % SLOTS;
}

/**
 * 往图里写一个朝 (dx,dz) 的瓣。
 *
 * 合并一律取 max,不求和也不平均——「不会因为后面还有第二个障碍物就少躲第一个」。
 * sharpness 控制瓣宽:1 ≈ 180° 的余弦瓣,4 ≈ 窄瓣。
 */
export function write(map: Map16, dx: number, dz: number, strength: number, sharpness = 1): void {
  const len = Math.hypot(dx, dz);
  if (len < 1e-9 || strength <= 0) return;
  const ux = dx / len, uz = dz / len;
  for (let i = 0; i < SLOTS; i++) {
    const d = slotDir(i);
    const dot = d.x * ux + d.z * uz;
    if (dot <= 0) continue;
    const v = strength * Math.pow(dot, sharpness);
    if (v > map[i]) map[i] = v;
  }
}

/** 单槽硬写(地形那类硬约束) */
export function writeSlot(map: Map16, i: number, v: number): void {
  const k = ((i % SLOTS) + SLOTS) % SLOTS;
  if (v > map[k]) map[k] = v;
}

/** 1-2-1 环形模糊。抹掉尖刺,让方向选择别在相邻槽之间跳 */
export function blur(map: Map16): void {
  const src = Float64Array.from(map);
  for (let i = 0; i < SLOTS; i++) {
    const a = src[(i - 1 + SLOTS) % SLOTS];
    const b = src[i];
    const c = src[(i + 1) % SLOTS];
    // 硬危险不参与模糊,否则会渗到相邻槽把出路也堵死
    if (b >= HARD) { map[i] = b; continue; }
    const av = a >= HARD ? b : a;
    const cv = c >= HARD ? b : c;
    map[i] = (av + 2 * b + cv) / 4;
  }
}

/**
 * 与上一 tick 的图混合 = 全局滞回。
 * 不需要任何 per-behavior 状态就消掉抖动——台架前几轮给「换目标」「横移方向」
 * 各自单独加粘性,正是 Fray 点名的死路。
 */
export function blend(prev: Map16, cur: Map16, alpha: number): void {
  for (let i = 0; i < SLOTS; i++) {
    if (cur[i] >= HARD || prev[i] >= HARD) { cur[i] = Math.max(cur[i], prev[i] >= HARD ? 0 : cur[i]); }
    if (cur[i] >= HARD) continue;
    cur[i] = alpha * cur[i] + (1 - alpha) * prev[i];
  }
}

interface Choice {
  /** 连续方向(次槽插值之后) */
  x: number;
  z: number;
  /** 胜出槽的 interest 强度;速度按它给 */
  strength: number;
  slot: number;
}

/**
 * 裁决:先按危险 masking,再在活下来的槽里挑最想去的。
 *
 * 1. 硬危险的槽直接排除(地形)
 * 2. 找剩下里最低的危险,把高于「最低 + tol」的也 mask 掉
 * 3. 在没被 mask 的槽里取 interest 最大
 * 4. 用左右邻槽的 interest 做抛物线顶点,得到次槽偏移 → 连续方向
 *
 * 全被硬危险堵死时返回 null(调用方自己决定站住还是硬闯)。
 */
export function decide(interest: Map16, danger: Map16, tol = 0.2): Choice | null {
  let min = Infinity;
  for (let i = 0; i < SLOTS; i++) if (danger[i] < HARD && danger[i] < min) min = danger[i];
  if (!Number.isFinite(min)) return null;

  const cut = min + tol;
  let best = -1;
  let bestV = -Infinity;
  for (let i = 0; i < SLOTS; i++) {
    if (danger[i] >= HARD || danger[i] > cut) continue;
    if (interest[i] > bestV) { bestV = interest[i]; best = i; }
  }
  if (best < 0) return null;

  // 次槽插值:只用同样没被 mask 掉的邻槽,否则会被墙里的槽拉偏
  const li = (best - 1 + SLOTS) % SLOTS;
  const ri = (best + 1) % SLOTS;
  const ok = (i: number): boolean => danger[i] < HARD && danger[i] <= cut;
  const a = ok(li) ? interest[li] : bestV;
  const c = ok(ri) ? interest[ri] : bestV;
  const denom = a - 2 * bestV + c;
  let off = 0;
  if (Math.abs(denom) > 1e-9) off = (0.5 * (a - c)) / denom;
  if (!Number.isFinite(off) || Math.abs(off) > 1) off = 0;

  const ang = ((best + off) / SLOTS) * Math.PI * 2;
  return { x: Math.cos(ang), z: Math.sin(ang), strength: bestV, slot: best };
}
