/**
 * 蓝图版本身份与剩余材料保留账。
 *
 * 版本身份绑定规范化内容；材料账只接受已经装载的可执行版本与其剩余 IR，
 * 不把流式草稿算成工程需求。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { NormalizedBlueprint } from './blueprint.ts';
import { billForSteps, type BlueprintStep } from './blueprint-plan.ts';

export interface BlueprintVersionIdentity {
  versionId: string;
  contentHash: string;
}

export function createBlueprintVersionId(): string {
  return `bpv_${randomUUID()}`;
}

export function createBlueprintJobId(): string {
  return `bpj_${randomUUID()}`;
}

/** 规范化矩阵的稳定摘要；标签、保存时间与施工进度不属于设计内容。 */
export function blueprintContentHash(blueprint: NormalizedBlueprint): string {
  const canonical = JSON.stringify({
    site_mode: blueprint.site_mode,
    size_xyz: blueprint.size_xyz,
    axis_order: 'YZX',
    layers: blueprint.layers,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** 新保存版本使用不可复用的 id；内容相同仍是两次独立保存。 */
export function createBlueprintVersion(blueprint: NormalizedBlueprint): BlueprintVersionIdentity {
  return {
    versionId: createBlueprintVersionId(),
    contentHash: blueprintContentHash(blueprint),
  };
}

interface BlueprintReserveProject {
  key: string;
  versionId: string;
  remaining: readonly BlueprintStep[];
}

interface BlueprintResourceOverride {
  id: string;
  reason: string;
  maxBlocks: number;
  spent: number;
  startedAt: number;
  expiresAt: number;
}

interface BlueprintRestockMarker {
  overrideId: string;
  reason: string;
  maxBlocks: number;
  borrowed: Readonly<Record<string, number>>;
  at: number;
}

type BlueprintPlacementDecision =
  | { ok: true; source: 'unreserved' | 'surplus' | 'override' }
  | { ok: false; reason: string };

/**
 * 保留账要读的两份外部事实。都是取值函数:名单与箱子账都会在两次判定之间变，
 * 冻在 `sync` 那一刻就又是一个只有账本自己知道的事实源。
 */
interface BlueprintLedgerFacts {
  /** 当下生效的垫脚名单(World 侧 = `policy.scaffold ?? cfg.scaffoldBlocks`) */
  scaffold?: () => readonly string[];
  /** 当下生效的照明名单(World 侧 = `policy.light ?? 默认 ['torch']`) */
  light?: () => readonly string[];
  /** 箱子账本里本世界的存货(与随身分账;口径是「上次看见」) */
  stored?: () => Readonly<Record<string, number>>;
}

/**
 * 已装载版本的剩余耗材保留账。
 *
 * 每种材料只保护剩余工程需要量，库存高于 reserve 的盈余仍可用于普通垫路。
 * 背包槽触到 reserve 后：逐块放置由 `placementDecision` 硬否决，垫脚名单只降位不删除
 * （见 `orderScaffoldCandidates`）；临时覆盖则逐块扣预算。
 *
 * 两条豁免都在 `reserve()` 里现算,不在 `sync()` 里冻结 —— 她改垫脚名单、往箱子里
 * 补料都不该等到下一次蓝图变动才生效。
 */
export class BlueprintResourceLedger {
  private projects = new Map<string, { versionId: string; bill: Record<string, number> }>();
  private override: BlueprintResourceOverride | null = null;
  private restock: BlueprintRestockMarker[] = [];
  private observedStock: Record<string, number> = {};

  constructor(private readonly facts: BlueprintLedgerFacts = {}) {}

  sync(projects: readonly BlueprintReserveProject[]): boolean {
    const before = this.projectSignature();
    const next = new Map<string, { versionId: string; bill: Record<string, number> }>();
    for (const project of projects) {
      const bill = Object.fromEntries(
        billForSteps(project.remaining).lines
          .filter((line) => line.need > 0)
          .map((line) => [line.item, line.need]),
      );
      next.set(project.key, { versionId: project.versionId, bill });
    }
    this.projects = next;
    return before !== this.projectSignature();
  }

  /**
   * 当前垫脚与照明名单中的物品不进 reserve，即使它们也是蓝图主料。
   * 逐块硬否决仍由 placementDecision 处理，reserve_override 仍按预算生效。
   */
  private scaffoldExempt(): ReadonlySet<string> {
    return new Set([...this.facts.scaffold?.() ?? [], ...this.facts.light?.() ?? []]);
  }

  /**
   * 剩余工程需求 −(垫脚豁免)−(箱子存货)。
   *
   * 箱子里已经囤够的那部分不必再从随身扣:reserve 是「别把将来要用的料现在烧掉」,
   * 而不是「背包里同名的东西一律不许动」。**满足度看 carried+stored,放置可用性仍
   * 只看 carried** —— 手里没有就是放不了,那件事由 `placementDecision` 的 `has` 管。
   */
  reserve(): Record<string, number> {
    const exempt = this.scaffoldExempt();
    const stored = this.facts.stored?.() ?? {};
    const total: Record<string, number> = {};
    for (const project of this.projects.values()) {
      for (const [item, count] of Object.entries(project.bill)) {
        if (exempt.has(item)) continue;
        total[item] = (total[item] ?? 0) + count;
      }
    }
    for (const [item, need] of Object.entries(total)) {
      const left = need - Math.max(0, Math.floor(stored[item] ?? 0));
      if (left > 0) total[item] = left;
      else delete total[item];
    }
    return total;
  }

  protectedItems(): string[] {
    return Object.keys(this.reserve()).sort();
  }

  /**
   * 「装载的工程变了没有」的签名,读原始账单而不是生效 reserve:豁免与箱子抵扣都是
   * 现算的外部事实,同一次 sync 的前后两次读数必然一致,放进签名也照不出变化;
   * 名单变化那一路由 `mc_policy` 自己 retune,箱子变化由 `observe` 的跨线判据接。
   */
  private projectSignature(): string {
    return JSON.stringify([...this.projects]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, project]) => [
        key,
        project.versionId,
        Object.entries(project.bill).sort(([left], [right]) => left.localeCompare(right)),
      ]));
  }

  observe(stock: Readonly<Record<string, number>>, now = Date.now()): {
    retune: boolean;
    borrowed: Readonly<Record<string, number>>;
  } {
    const reserve = this.reserve();
    const before = this.observedStock;
    const borrowed: Record<string, number> = {};
    let retune = false;
    for (const [item, need] of Object.entries(reserve)) {
      const was = Math.max(0, Math.floor(before[item] ?? 0));
      const has = Math.max(0, Math.floor(stock[item] ?? 0));
      if ((was > need) !== (has > need)) retune = true;
      const enteredReserve = Math.max(0, need - has) - Math.max(0, need - was);
      if (enteredReserve <= 0) continue;
      const verdict = this.borrow(item, enteredReserve, now);
      if (verdict.ok) borrowed[item] = enteredReserve;
      else retune = true;
    }
    this.observedStock = Object.fromEntries(
      Object.entries(stock).map(([item, count]) => [item, Math.max(0, Math.floor(count))]),
    );
    if (!this.activeOverride(now)) retune = retune || Object.keys(borrowed).length > 0;
    return { retune, borrowed };
  }

  /**
   * 此刻被蓝图预留收口的材料:有预留账、库存不高于预留量、且没有生效中的临时覆盖。
   *
   * 收口只是「不该主动烧掉」的事实,不代表禁用 —— 判定与呈现共读这一份,
   * 免得寻路器扣的账和她读到的名单变成两个事实源。
   */
  collapsedItems(
    stock: Readonly<Record<string, number>> = this.observedStock,
    now = Date.now(),
  ): string[] {
    const active = this.activeOverride(now);
    if (active && active.spent < active.maxBlocks) return [];
    return Object.entries(this.reserve())
      .filter(([item, need]) => (stock[item] ?? 0) <= need)
      .map(([item]) => item)
      .sort();
  }

  /**
   * 将预留收口的垫脚候选排到末位，不删除候选；硬否决由 placementDecision 处理。
   * 垫脚名单由 scaffoldExempt 豁免，寻路可能消耗同名蓝图主料。
   */
  orderScaffoldCandidates(
    candidates: readonly string[],
    stock: Readonly<Record<string, number>> = this.observedStock,
    now = Date.now(),
  ): string[] {
    const held = new Set(this.collapsedItems(stock, now));
    // sort 在 Node 上是稳定的:可用的那几样保持她写的优先顺序
    return [...candidates].sort((left, right) => Number(held.has(left)) - Number(held.has(right)));
  }

  /** 单块放置许可；实际消耗仍由放置后的库存观察逐块结算。 */
  placementDecision(
    item: string,
    stock: Readonly<Record<string, number>> = this.observedStock,
    now = Date.now(),
  ): BlueprintPlacementDecision {
    const need = this.reserve()[item];
    if (need === undefined) return { ok: true, source: 'unreserved' };
    const has = Math.max(0, Math.floor(stock[item] ?? 0));
    if (has > need) return { ok: true, source: 'surplus' };
    const active = this.activeOverride(now);
    if (active && active.spent < active.maxBlocks) return { ok: true, source: 'override' };
    return {
      ok: false,
      reason: `${item} 的蓝图 reserve 是 ${need},随身只有 ${has};要动它先用 mc_blueprint 的 reserve_override`,
    };
  }

  openOverride(
    spec: { reason: string; ttlMs: number; maxBlocks: number },
    now = Date.now(),
  ): BlueprintResourceOverride {
    const override: BlueprintResourceOverride = {
      id: `bpo_${randomUUID()}`,
      reason: spec.reason,
      maxBlocks: spec.maxBlocks,
      spent: 0,
      startedAt: now,
      expiresAt: now + spec.ttlMs,
    };
    this.override = override;
    return { ...override };
  }

  activeOverride(now = Date.now()): BlueprintResourceOverride | null {
    if (!this.override) return null;
    if (now >= this.override.expiresAt || this.override.spent >= this.override.maxBlocks) {
      this.override = null;
      return null;
    }
    return { ...this.override };
  }

  /** 库存观察确认实际动用保留料后扣预算；超预算或过期时拒绝记账。 */
  borrow(item: string, count: number, now = Date.now()): { ok: true; left: number } | { ok: false; reason: string } {
    const active = this.activeOverride(now);
    if (!active) return { ok: false, reason: '没有有效的蓝图材料临时覆盖' };
    if (!Number.isSafeInteger(count) || count <= 0) return { ok: false, reason: '借料数量必须是正整数' };
    const left = active.maxBlocks - active.spent;
    if (count > left) return { ok: false, reason: `临时覆盖只剩 ${left} 块预算` };
    this.override!.spent += count;
    const marker = this.restock.find((entry) => entry.overrideId === active.id);
    if (marker) {
      const borrowed = { ...marker.borrowed, [item]: (marker.borrowed[item] ?? 0) + count };
      this.restock = this.restock.map((entry) => entry === marker ? { ...entry, borrowed } : entry);
    } else {
      this.restock.push({
        overrideId: active.id,
        reason: active.reason,
        maxBlocks: active.maxBlocks,
        borrowed: { [item]: count },
        at: now,
      });
      if (this.restock.length > 8) this.restock.splice(0, this.restock.length - 8);
    }
    return { ok: true, left: left - count };
  }

  restockMarkers(): readonly BlueprintRestockMarker[] {
    return this.restock.map((entry) => ({ ...entry, borrowed: { ...entry.borrowed } }));
  }
}
