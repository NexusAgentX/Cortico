/** Aggregate observed consumption and immutable Provider charges. */
import type { UsageRecord } from './types.ts';
import { billingBalances, recordCharges, type BillingBalance } from './billing.ts';

/** 已解析的具体时间粒度(桶宽) */
export type UsageBucketUnit = 'minute' | 'hour' | 'day' | 'week' | 'month';
/** 请求粒度:具体粒度或 'auto'(按范围跨度自适应) */
export type UsageBucketOption = UsageBucketUnit | 'auto';
export type UsageGroupBy = 'role' | 'model' | 'none';

/**
 * 一个累计单元:总量 + 成本三档拆分。
 * series 点、按角色/模型分组、以及每桶内的子拆分共用此形,前端可任选维度堆叠。
 *   - cost = costCacheHit + costCacheMiss + costOutput + costOther(成本按"钱花在哪"三分)
 *   - reasoningTokens 是 completionTokens 的子集(只观察,不单独计费)
 */
export interface UsageAccum {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
  cost: number;
  costCacheHit: number;
  costCacheMiss: number;
  costOutput: number;
  costOther: number;
  unclassifiedInputTokens: number;
  pricedCalls: number;
  unpricedCalls: number;
  unknownUsageCalls: number;
}

export interface UsageSeriesPoint extends UsageAccum {
  /** 本地时区前缀,如 2026-07-19T14:30、2026-07-19 或 2026-07。 */
  bucket: string;
  /** 本桶内按角色的子拆分(键=角色);用于堆叠"按角色"视图 */
  byRole: Record<string, UsageAccum>;
  /** 本桶内按模型的子拆分(键=模型);用于堆叠"按模型"视图 */
  byModel: Record<string, UsageAccum>;
  /**
   * 本桶内按 角色×模型 的交叉子拆分(byRoleModel[role][model])。
   * 前端据此可任意组合 类型/角色/模型 三维堆叠:类型档从任一 accum 的成本/token 分量取,
   * 角色×模型 组合从这里寻址,单角色/单模型仍走 byRole/byModel。
   */
  byRoleModel: Record<string, Record<string, UsageAccum>>;
}

/** 按 role / model 分组的合计 */
export interface UsageGroupStat extends UsageAccum {
  key: string;
  /**
   * 人话名,来自声明方(`UsageRecord.label`)。
   *
   * 控制台**不许**自己拿 key 查一张中文名表:role 是「Persona定义的不透明字符串」
   * (见 `UsageRecord.role` 的注释),换个Persona那批名字就全变了。拿不到时前端
   * 印 key 原文,不猜。与 key 相同时省略。
   */
  label?: string;
  cacheHitRate: number | null;
}

export interface UsageAggregate {
  currency: string;
  basis: 'marginal' | 'equivalent';
  balances: BillingBalance[];
  successful: UsageAccum;
  byInstance: UsageGroupStat[];
  /** 实际使用的粒度(auto 会被解析成具体值) */
  bucket: UsageBucketUnit;
  from: string | null;
  to: string | null;
  /** 时间序列(按 bucket 升序) */
  series: UsageSeriesPoint[];
  /** 全量合计 */
  totals: UsageGroupStat;
  /** 按角色分组(cost 降序) */
  byRole: UsageGroupStat[];
  /** 按模型分组(cost 降序) */
  byModel: UsageGroupStat[];
  /** Failed, aborted and discarded attempts are also included in totals. */
  failed: UsageAccum;
}

function zero(): UsageAccum {
  return {
    calls: 0, promptTokens: 0, completionTokens: 0,
    cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0,
    cost: 0, costCacheHit: 0, costCacheMiss: 0, costOutput: 0, costOther: 0, unclassifiedInputTokens: 0,
    pricedCalls: 0, unpricedCalls: 0, unknownUsageCalls: 0,
  };
}

type MeasuredCost = { cacheHit: number; cacheMiss: number; output: number; total: number; priced: boolean };

function add(a: UsageAccum, r: UsageRecord, c: MeasuredCost): void {
  a.calls += 1;
  if (c.priced) a.pricedCalls++; else a.unpricedCalls++;
  if (r.attempt && (r.attempt.meters.input === null || r.attempt.meters.output === null || r.attempt.meters.cachedInput === null)) a.unknownUsageCalls++;
  a.promptTokens += r.promptTokens;
  a.completionTokens += r.completionTokens;
  a.cacheHitTokens += r.cacheHitTokens;
  a.cacheMissTokens += r.cacheMissTokens;
  a.reasoningTokens += r.reasoningTokens;
  a.cost += c.total;
  a.costCacheHit += c.cacheHit;
  a.costCacheMiss += c.cacheMiss;
  a.costOutput += c.output;
  a.costOther += c.total - c.cacheHit - c.cacheMiss - c.output;
  a.unclassifiedInputTokens += Math.max(0, r.promptTokens - r.cacheHitTokens - r.cacheMissTokens);
}

function upsert(m: Map<string, UsageAccum>, key: string, r: UsageRecord, c: MeasuredCost): void {
  let a = m.get(key);
  if (!a) { a = zero(); m.set(key, a); }
  add(a, r, c);
}

function mapToObj(m: Map<string, UsageAccum>): Record<string, UsageAccum> {
  const o: Record<string, UsageAccum> = {};
  for (const [k, v] of m) o[k] = v;
  return o;
}

function nestedMapToObj(m: Map<string, Map<string, UsageAccum>>): Record<string, Record<string, UsageAccum>> {
  const o: Record<string, Record<string, UsageAccum>> = {};
  for (const [k, inner] of m) o[k] = mapToObj(inner);
  return o;
}

function statOf(key: string, a: UsageAccum, label?: string): UsageGroupStat {
  const out: UsageGroupStat = { key, ...a, cacheHitRate: cacheHitRate(a) };
  if (label && label !== key) out.label = label;
  return out;
}

/** 一天 = 该日期(YYYY-MM-DD)所在 ISO 周的周一(用 UTC 计算,避免时区漂移) */
function weekStart(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y || 1970, (m || 1) - 1, d || 1));
  const dow = (dt.getUTCDay() + 6) % 7; // 周一=0 … 周日=6
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
}

/** 取某条记录在给定粒度下的桶键(本地时区 ISO 前缀直接切,周单独算) */
function bucketKeyOf(ts: string, unit: UsageBucketUnit): string {
  switch (unit) {
    case 'minute': return ts.slice(0, 16); // YYYY-MM-DDTHH:MM
    case 'hour': return ts.slice(0, 13);   // YYYY-MM-DDTHH
    case 'day': return ts.slice(0, 10);    // YYYY-MM-DD
    case 'week': return weekStart(ts.slice(0, 10));
    case 'month': return ts.slice(0, 7);   // YYYY-MM
  }
}

/** from/to(YYYY-MM-DD,含端)之间的整天跨度(含首尾);任一为空→NaN */
function daySpan(from?: string | null, to?: string | null): number {
  if (!from || !to) return NaN;
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.abs(b - a) / 86400000 + 1;
}

/**
 * 自适应粒度:按范围跨度挑一个"桶数适中"的粒度。
 *   ≤2 天→时 / ≤62 天→天 / ≤366 天→周 / 更长→月。
 * 范围开放(缺 from/to)时保守用天。分钟粒度只由用户显式选择(auto 不会挑它)。
 */
export function resolveBucket(from?: string | null, to?: string | null): UsageBucketUnit {
  const span = daySpan(from, to);
  if (Number.isNaN(span)) return 'day';
  if (span <= 2) return 'hour';
  if (span <= 62) return 'day';
  if (span <= 366) return 'week';
  return 'month';
}

/**
 * 聚合原始记录:按 from/to(日期前缀 YYYY-MM-DD,含端)筛选,
 * 按 bucket 粒度出时间序列,并给出总计 + 按角色/模型分组。
 * 每条记录的成本按其 model 单独取价,混用模型也准。
 * 每个 series 点额外带 byRole/byModel 子拆分与成本三档,供前端任选维度堆叠。
 */
export function aggregateUsage(
  records: UsageRecord[],
  opts: { from?: string | null; to?: string | null; bucket: UsageBucketOption; currency?: string; basis?: 'marginal' | 'equivalent' },
): UsageAggregate {
  const { from = null, to = null } = opts;
  const unit: UsageBucketUnit = opts.bucket === 'auto' ? resolveBucket(from, to) : opts.bucket;
  const series = new Map<string, { total: UsageAccum; roles: Map<string, UsageAccum>; models: Map<string, UsageAccum>; roleModels: Map<string, Map<string, UsageAccum>> }>();
  const roles = new Map<string, UsageAccum>();
  /** role → 声明方给的人话名;同 role 出现多次时以最后一条为准。 */
  const roleLabels = new Map<string, string>();
  const models = new Map<string, UsageAccum>();
  const totals = zero();
  const failed = zero();
  const successful = zero();
  const instances = new Map<string, UsageAccum>();
  const selected = records.filter(r => r && typeof r.ts === 'string' && (!from || r.ts.slice(0,10) >= from) && (!to || r.ts.slice(0,10) <= to));
  const balances = billingBalances(selected);
  const basis = opts.basis ?? 'marginal';
  const currency = opts.currency ?? balances.find(balance => balance.basis === basis)?.currency ?? 'USD';

  for (const r of selected) {
    const charge = recordCharges(r).find(charge => charge.quote.currency === currency && charge.quote.basis === basis);
    const cost: MeasuredCost = { cacheHit: 0, cacheMiss: 0, output: 0, total: charge?.knownAmount ?? 0, priced: charge?.amount != null };
    for (const line of charge?.lines ?? []) {
      if (line.meter === 'cachedInput') cost.cacheHit += line.amount ?? 0;
      if (line.meter === 'uncachedInput' || line.meter === 'input') cost.cacheMiss += line.amount ?? 0;
      if (line.meter === 'output') cost.output += line.amount ?? 0;
    }
    const outcome = r.attempt?.outcome;
    if (r.outcome !== undefined || (outcome !== undefined && outcome !== 'completed' && outcome !== 'incomplete')) add(failed, r, cost);
    else if (r.attempt?.purpose !== 'diagnostic') add(successful, r, cost);
    upsert(instances, r.attempt?.origin.instance ?? 'unknown', r, cost);
    const role = r.role ?? 'unknown';
    const model = r.model || 'unknown';
    const bk = bucketKeyOf(r.ts, unit);
    let bucketAcc = series.get(bk);
    if (!bucketAcc) { bucketAcc = { total: zero(), roles: new Map(), models: new Map(), roleModels: new Map() }; series.set(bk, bucketAcc); }
    add(bucketAcc.total, r, cost);
    upsert(bucketAcc.roles, role, r, cost);
    upsert(bucketAcc.models, model, r, cost);
    let rm = bucketAcc.roleModels.get(role);
    if (!rm) { rm = new Map(); bucketAcc.roleModels.set(role, rm); }
    upsert(rm, model, r, cost);
    upsert(roles, role, r, cost);
    if (r.label) roleLabels.set(role, r.label);
    upsert(models, model, r, cost);
    add(totals, r, cost);
  }

  const seriesOut: UsageSeriesPoint[] = [...series.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([b, acc]) => ({ bucket: b, ...acc.total, byRole: mapToObj(acc.roles), byModel: mapToObj(acc.models), byRoleModel: nestedMapToObj(acc.roleModels) }));
  const groupOut = (m: Map<string, UsageAccum>, labels?: Map<string, string>): UsageGroupStat[] =>
    [...m.entries()].map(([k, a]) => statOf(k, a, labels?.get(k))).sort((x, y) => y.cost - x.cost);

  return {
    currency, basis, balances, successful, byInstance: groupOut(instances),
    bucket: unit,
    from,
    to,
    series: seriesOut,
    totals: statOf('total', totals),
    byRole: groupOut(roles, roleLabels),
    byModel: groupOut(models),
    failed,
  };
}

export function cacheHitRate(u: { cacheHitTokens: number; cacheMissTokens: number }): number | null {
  const total = u.cacheHitTokens + u.cacheMissTokens;
  return total > 0 ? u.cacheHitTokens / total : null;
}
