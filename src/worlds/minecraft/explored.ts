/**
 * 探索覆盖账本：按世界与维度分别记录 8 个方向的历史最远距离与末端群系。
 *
 * 只回答“这张世界的这一维度哪边去过、去到多远”。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeDimension } from './escape.ts';
import { zhBiome, zhDimension } from './names.ts';
import { DIRECTION_ZH, type Direction } from './terrain.ts';

interface ExploreRecord {
  distance: number;
  biome: string;
  at: number;
}

type ExploreMap = Partial<Record<Direction, ExploreRecord>>;

interface ExploreLedger {
  version: 2;
  currentRealm: string;
  realms: Record<string, Record<string, ExploreMap>>;
}

const COMPASS_ORDER: Direction[] = [
  'north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest',
];

/** 一张维度地图 → 环境提示词；一处没去过返回空串。 */
export function renderExploredSummary(map: ExploreMap): string {
  const seen: string[] = [];
  const unseen: string[] = [];
  for (const dir of COMPASS_ORDER) {
    const r = map[dir];
    if (r) seen.push(`${DIRECTION_ZH[dir]}${r.distance}${r.biome === 'unknown' ? '' : `(${zhBiome(r.biome)})`}`);
    else unseen.push(DIRECTION_ZH[dir]);
  }
  if (seen.length === 0) return '';
  const head = `探过:${seen.join('/')}`;
  return unseen.length > 0 ? `${head};${unseen.join('、')}没去过` : head;
}

/** 冷代理不知道游戏当前在哪个维度，因此把当前世界有记录的维度逐一标明。 */
export function renderExploredLedger(ledger: ExploreLedger): string {
  const realm = ledger.realms[ledger.currentRealm] ?? {};
  return Object.entries(realm)
    .map(([dimension, map]) => {
      const line = renderExploredSummary(map);
      return line ? `[${zhDimension(dimension)}] ${line}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function cleanMap(data: unknown): ExploreMap {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const raw = data as Record<string, ExploreRecord>;
  const map: ExploreMap = {};
  for (const dir of COMPASS_ORDER) {
    const v = raw[dir];
    if (v && typeof v.distance === 'number' && v.distance > 0) {
      map[dir] = {
        distance: Math.round(v.distance),
        biome: typeof v.biome === 'string' && v.biome !== '' ? v.biome : 'unknown',
        at: typeof v.at === 'number' ? v.at : 0,
      };
    }
  }
  return map;
}

/** 落盘文件 → 账本；读不出 v2 的形状就当空账本。 */
export function loadExplored(file: string | null): ExploreLedger {
  const empty = (): ExploreLedger => ({ version: 2, currentRealm: '', realms: {} });
  if (!file || !existsSync(file)) return empty();
  let data: unknown;
  try {
    const raw = readFileSync(file, 'utf8').trim();
    if (!raw) return empty();
    data = JSON.parse(raw);
  } catch {
    return empty();
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return empty();
  const body = data as Record<string, unknown>;
  if (body.version !== 2 || !body.realms || typeof body.realms !== 'object') return empty();
  const realms: Record<string, Record<string, ExploreMap>> = {};
  for (const [realm, dimensions] of Object.entries(body.realms as Record<string, unknown>)) {
    if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions)) continue;
    const scoped: Record<string, ExploreMap> = {};
    for (const [dimension, map] of Object.entries(dimensions as Record<string, unknown>)) {
      const cleaned = cleanMap(map);
      if (Object.keys(cleaned).length > 0) scoped[normalizeDimension(dimension)] = cleaned;
    }
    if (Object.keys(scoped).length > 0) realms[realm] = scoped;
  }
  return {
    version: 2,
    currentRealm: typeof body.currentRealm === 'string' ? body.currentRealm : '',
    realms,
  };
}

export class ExploreBook {
  private ledger: ExploreLedger;

  constructor(private readonly file: string | null) {
    this.ledger = loadExplored(file);
  }

  useRealm(realm: string): void {
    if (this.ledger.currentRealm === realm) return;
    this.ledger.currentRealm = realm;
    this.save();
  }

  record(dimension: string, direction: Direction, distance: number, biome: string, now = Date.now()): void {
    const d = Math.round(distance);
    if (d <= 0) return;
    const realm = this.ledger.currentRealm;
    const dim = normalizeDimension(dimension);
    const dimensions = this.ledger.realms[realm] ??= {};
    const map = dimensions[dim] ??= {};
    const prev = map[direction];
    map[direction] = !prev || d >= prev.distance
      ? { distance: d, biome, at: now }
      : { ...prev, at: now };
    this.save();
  }

  summary(dimension: string): string {
    const map = this.ledger.realms[this.ledger.currentRealm]?.[normalizeDimension(dimension)] ?? {};
    return renderExploredSummary(map);
  }

  stat(): string {
    const scoped = Object.values(this.ledger.realms)
      .flatMap((dimensions) => Object.values(dimensions))
      .reduce((n, map) => n + Object.keys(map).length, 0);
    if (!this.file || !existsSync(this.file)) return scoped === 0 ? '(无文件)' : `${scoped} 个已归属方向(未落盘)`;
    const kb = (statSync(this.file).size / 1024).toFixed(1);
    return `${scoped} 个已归属方向 / ${kb}KB`;
  }

  clear(): string {
    const n = Object.values(this.ledger.realms)
      .flatMap((dimensions) => Object.values(dimensions))
      .reduce((sum, map) => sum + Object.keys(map).length, 0);
    this.ledger = { version: 2, currentRealm: this.ledger.currentRealm, realms: {} };
    this.save();
    return n === 0 ? '探索账本是空的' : `探索账本已清空(${n} 个方向)`;
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.ledger)}\n`, 'utf8');
  }
}
