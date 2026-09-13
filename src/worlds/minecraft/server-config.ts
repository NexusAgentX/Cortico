/**
 * Minecraft 仅在启动时读取 server.properties。停机时的设置写入文件并于下次启动
 * 生效；运行时仅通过控制台命令修改难度和默认游戏模式，不写入该文件。
 *
 * 文件读写保留用户维护的键顺序与注释。
 *
 * 世界生成那几项(level-type / generator-settings / level-seed / generate-structures)
 * 只在存档**第一次生成**时被读;对着已生成的存档改它们不会重塑世界。存档已有的
 * 生成事实由 level.dat 自述,见 `listWorlds` 带回的 `info`。
 *
 * 服务器目录里另一份同样只在启动时读的文件是 `ops.json`(谁有作弊权限),读写在
 * 本文件末尾那一节;它按 UUID 认人,所以还要 `usercache.json` 与离线 UUID 兜底。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { readLevelDat, type LevelDatInfo } from './level-dat.ts';
import { offlineUuid } from './client-launch.ts';

export const GAMEMODES = ['survival', 'creative', 'adventure', 'spectator'] as const;
export const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'] as const;
/** 原版世界类型;单生物群系还要 generator-settings 指定是哪个群系 */
const LEVEL_TYPES = [
  'minecraft:normal',
  'minecraft:flat',
  'minecraft:large_biomes',
  'minecraft:amplified',
  'minecraft:single_biome_surface',
] as const;

type Gamemode = (typeof GAMEMODES)[number];
export type Difficulty = (typeof DIFFICULTIES)[number];
export type LevelType = (typeof LEVEL_TYPES)[number];

/** 世界类型的中文词表:面板铺选项、服务端写回执都取这一份 */
export const LEVEL_TYPE_LABELS: ReadonlyArray<{ value: LevelType; label: string; note: string }> = [
  { value: 'minecraft:normal', label: '默认', note: '原版地形' },
  { value: 'minecraft:flat', label: '超平坦', note: '按生成器细则逐层铺;不填就是原版那三层' },
  { value: 'minecraft:large_biomes', label: '大型生物群系', note: '同样的地形,群系尺度放大' },
  { value: 'minecraft:amplified', label: '放大化', note: '极端高山地形,吃性能' },
  {
    value: 'minecraft:single_biome_surface',
    label: '单一生物群系',
    note: '整个世界一个群系,群系名写在生成器细则里({"biome":"minecraft:desert"})',
  },
];

export function levelTypeLabel(type: LevelType): string {
  return LEVEL_TYPE_LABELS.find((t) => t.value === type)?.label ?? type;
}

/**
 * 超平坦预设:generator-settings 的整份 JSON。
 *
 * `layers` 自下而上,`height` 是层厚。前三个是原版同名预设的层配方,末一个是
 * 本项目自己配的——超平坦默认那三层底下没有石头,挖不到任何矿,拿来试玩挖掘
 * 类技能会一无所获。
 */
export const FLAT_PRESETS: ReadonlyArray<{ id: string; label: string; note: string; json: string }> = [
  {
    id: 'classic',
    label: '经典平坦',
    note: '基岩 + 2 层泥土 + 草方块,平原群系',
    json: '{"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:dirt","height":2},'
      + '{"block":"minecraft:grass_block","height":1}],"biome":"minecraft:plains"}',
  },
  {
    id: 'void',
    label: '虚空',
    note: '只有一层空气,出生点一小块平台',
    json: '{"layers":[{"block":"minecraft:air","height":1}],"biome":"minecraft:the_void"}',
  },
  {
    id: 'tunnelers',
    label: '隧道世界',
    note: '基岩 + 230 层石头,整个世界都是可挖的岩层',
    json: '{"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":230}],'
      + '"biome":"minecraft:windswept_hills"}',
  },
  {
    id: 'minable',
    label: '可挖平坦',
    note: '基岩 + 59 层石头 + 泥土草皮:地表是平的,底下有矿脉',
    json: '{"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":59},'
      + '{"block":"minecraft:dirt","height":3},{"block":"minecraft:grass_block","height":1}],'
      + '"biome":"minecraft:plains"}',
  },
];

/** 控制台露出来的那几项;别的键原样留在文件里 */
export interface GameSettings {
  gamemode: Gamemode;
  difficulty: Difficulty;
  hardcore: boolean;
  pvp: boolean;
  spawnMonsters: boolean;
  /** 空 = 随机 */
  levelSeed: string;
  /** 当前存档目录名 */
  levelName: string;
  /** 世界类型;只在世界第一次生成时起作用 */
  levelType: LevelType;
  /** 生成器细则(超平坦层配方 / 单群系名);空 = 该类型的默认 */
  generatorSettings: string;
  /** 村庄、神殿、要塞这些结构 */
  generateStructures: boolean;
  allowNether: boolean;
  /** 出生点保护半径(格);0 = 不保护 */
  spawnProtection: number;
  viewDistance: number;
  simulationDistance: number;
  /** 世界边界半径(格) */
  maxWorldSize: number;
}

/** 存档目录一份,含 level.dat 自述与占盘 */
export interface WorldInfo {
  name: string;
  /** 目录里有 level.dat = 已经生成过;false 表示配着但还没开出来 */
  generated: boolean;
  /** 最后活跃(ISO):优先 level.dat 的 LastPlayed,退回文件 mtime;没生成为 null */
  modified: string | null;
  /** 存档占盘(字节,含 _nether / _the_end);没生成为 0 */
  sizeBytes: number;
  /** 已生成的附属维度:nether / the_end */
  dimensions: string[];
  /** level.dat 自述;读不出来为 null */
  info: LevelDatInfo | null;
}

/** 一行 properties:注释与空行原样留着 */
type Line = { kind: 'raw'; text: string } | { kind: 'pair'; key: string; value: string };

export function parseProperties(text: string): Line[] {
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return { kind: 'raw', text: line };
    const eq = line.indexOf('=');
    if (eq < 0) return { kind: 'raw', text: line };
    return { kind: 'pair', key: line.slice(0, eq).trim(), value: line.slice(eq + 1) };
  });
}

export function stringifyProperties(lines: Line[]): string {
  return lines.map((l) => (l.kind === 'raw' ? l.text : `${l.key}=${l.value}`)).join('\n');
}

export function readProperty(lines: Line[], key: string): string | null {
  for (const l of lines) if (l.kind === 'pair' && l.key === key) return l.value;
  return null;
}

/** 就地改;没有这个键就追加在末尾 */
export function writeProperty(lines: Line[], key: string, value: string): Line[] {
  const escaped = value.replace(/\\/g, '\\\\').replace(/[\r\n]/g, ' ');
  let hit = false;
  const out = lines.map((l) => {
    if (l.kind === 'pair' && l.key === key) { hit = true; return { kind: 'pair' as const, key, value: escaped }; }
    return l;
  });
  if (!hit) out.push({ kind: 'pair', key, value: escaped });
  return out;
}

function pickEnum<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  const v = (raw ?? '').trim().toLowerCase();
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function pickBool(raw: string | null, fallback: boolean): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

function pickInt(raw: string | null, fallback: number, lo: number, hi: number): number {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** 1.19 之前 level-type 是不带命名空间的短名(flat / largeBiomes);两种写法都收 */
function pickLevelType(raw: string | null): LevelType {
  const v = (raw ?? '').trim();
  const short = v.includes(':') ? v.slice(v.indexOf(':') + 1) : v;
  const id = `minecraft:${short.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}`;
  const legacy: Record<string, LevelType> = { 'minecraft:default': 'minecraft:normal' };
  const resolved = legacy[id] ?? id;
  return (LEVEL_TYPES as readonly string[]).includes(resolved) ? (resolved as LevelType) : 'minecraft:normal';
}

export function settingsFrom(lines: Line[]): GameSettings {
  return {
    gamemode: pickEnum(readProperty(lines, 'gamemode'), GAMEMODES, 'survival'),
    difficulty: pickEnum(readProperty(lines, 'difficulty'), DIFFICULTIES, 'easy'),
    hardcore: pickBool(readProperty(lines, 'hardcore'), false),
    pvp: pickBool(readProperty(lines, 'pvp'), true),
    spawnMonsters: pickBool(readProperty(lines, 'spawn-monsters'), true),
    levelSeed: (readProperty(lines, 'level-seed') ?? '').trim(),
    levelName: (readProperty(lines, 'level-name') ?? 'world').trim() || 'world',
    levelType: pickLevelType(readProperty(lines, 'level-type')),
    generatorSettings: (readProperty(lines, 'generator-settings') ?? '').trim(),
    generateStructures: pickBool(readProperty(lines, 'generate-structures'), true),
    allowNether: pickBool(readProperty(lines, 'allow-nether'), true),
    spawnProtection: pickInt(readProperty(lines, 'spawn-protection'), 16, 0, 512),
    viewDistance: pickInt(readProperty(lines, 'view-distance'), 10, 2, 32),
    simulationDistance: pickInt(readProperty(lines, 'simulation-distance'), 10, 2, 32),
    maxWorldSize: pickInt(readProperty(lines, 'max-world-size'), 29_999_984, 1, 29_999_984),
  };
}

export function applySettings(lines: Line[], patch: Partial<GameSettings>): Line[] {
  let out = lines;
  const set = (key: string, value: string | number | boolean | undefined): void => {
    if (value !== undefined) out = writeProperty(out, key, String(value));
  };
  set('gamemode', patch.gamemode);
  set('difficulty', patch.difficulty);
  set('hardcore', patch.hardcore);
  set('pvp', patch.pvp);
  set('spawn-monsters', patch.spawnMonsters);
  set('level-seed', patch.levelSeed);
  set('level-name', patch.levelName);
  set('level-type', patch.levelType);
  set('generator-settings', patch.generatorSettings);
  set('generate-structures', patch.generateStructures);
  set('allow-nether', patch.allowNether);
  set('spawn-protection', patch.spawnProtection);
  set('view-distance', patch.viewDistance);
  set('simulation-distance', patch.simulationDistance);
  set('max-world-size', patch.maxWorldSize);
  return out;
}

/** 存档名用作目录名;拒绝路径分隔符、相对路径和 Windows 保留名称。 */
export function validWorldName(name: string): string | null {
  const n = name.trim();
  if (!n) return '存档名不能为空';
  if (n.length > 64) return '存档名太长(最多 64 字)';
  if (/[\\/:*?"<>|]/.test(n)) return '存档名里不能有 \\ / : * ? " < > |';
  if (n === '.' || n === '..') return '这个名字不能用';
  return null;
}

/** generator-settings 只在非空时校验:必须是一个 JSON 对象,服务器读不了就直接崩 */
export function validGeneratorSettings(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch (err) {
    return `生成器细则不是合法 JSON: ${(err as Error).message}`;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return '生成器细则要是一个 JSON 对象(如 {"layers":[…],"biome":"…"})';
  }
  return null;
}

/** Paper/Bukkit 把下界与末地拆成独立目录,它们不是可选的存档 */
const DIMENSION_SUFFIX = /_(nether|the_end)$/;

/**
 * 目录占盘。存档动辄上万个区块文件,每次开面板全量 stat 一遍要几百毫秒,
 * 所以按 level.dat 的 mtime 缓存——世界没存过盘,占盘也不会变。
 */
const sizeCache = new Map<string, { stamp: number; size: number }>();

function dirSize(dir: string, budget: { left: number }): number {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (budget.left-- <= 0) return total;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(abs, budget);
    else {
      try { total += statSync(abs).size; } catch { /* 扫的过程中被删了 */ }
    }
  }
  return total;
}

function worldSize(serverDir: string, name: string, stamp: number): number {
  const key = join(serverDir, name);
  const hit = sizeCache.get(key);
  if (hit && hit.stamp === stamp) return hit.size;
  const budget = { left: 200_000 };
  let size = dirSize(key, budget);
  for (const suffix of ['_nether', '_the_end']) {
    const dim = join(serverDir, `${name}${suffix}`);
    if (existsSync(dim)) size += dirSize(dim, budget);
  }
  sizeCache.set(key, { stamp, size });
  return size;
}

/** serverDir 下的存档目录:有 level.dat 的算已生成,最近活跃的排在前面 */
export function listWorlds(serverDir: string, current: string): WorldInfo[] {
  const found = new Map<string, WorldInfo>();
  if (serverDir && existsSync(serverDir)) {
    const names = new Set<string>();
    for (const entry of readdirSync(serverDir, { withFileTypes: true })) {
      if (entry.isDirectory()) names.add(entry.name);
    }
    for (const name of names) {
      if (DIMENSION_SUFFIX.test(name)) continue;
      const dat = join(serverDir, name, 'level.dat');
      if (!existsSync(dat)) continue;
      const mtime = statSync(dat).mtimeMs;
      const info = readLevelDat(dat);
      found.set(name, {
        name,
        generated: true,
        // LastPlayed 是服务器自己记的"上次玩到什么时候";文件 mtime 会被备份、
        // 复制这类与游玩无关的动作改写,所以只当退路
        modified: new Date(info?.lastPlayed || mtime).toISOString(),
        sizeBytes: worldSize(serverDir, name, mtime),
        dimensions: ['nether', 'the_end'].filter((d) => names.has(`${name}_${d}`)),
        info,
      });
    }
  }
  // 配着但还没开出来的存档同样要在列表里(generated=false)
  if (current && !found.has(current)) {
    found.set(current, {
      name: current, generated: false, modified: null, sizeBytes: 0, dimensions: [], info: null,
    });
  }
  return [...found.values()].sort((a, b) => {
    const at = a.modified ? Date.parse(a.modified) : -1;
    const bt = b.modified ? Date.parse(b.modified) : -1;
    return bt - at || a.name.localeCompare(b.name);
  });
}

function propertiesPath(serverDir: string): string {
  return join(serverDir, 'server.properties');
}

export function loadProperties(serverDir: string): Line[] {
  const file = propertiesPath(serverDir);
  return existsSync(file) ? parseProperties(readFileSync(file, 'utf8')) : [];
}

export function saveProperties(serverDir: string, lines: Line[]): void {
  writeFileSync(propertiesPath(serverDir), stringifyProperties(lines), 'utf8');
}

/** 世界身份:本地托管报存档名,外部服务器报地址。她的位置类记忆全靠它划界。 */
export interface WorldIdentity {
  key: string;
  local: boolean;
}

/**
 * 从服务器目录认世界身份;读不出存档名(没配目录、配置缺损、连的是外部服务器)
 * 就退到 `address`。两个进程各自读盘得同一个答案:主进程侧的前缀渲染与引擎
 * 子进程侧的记账都走这里。
 */
export function worldIdentityOf(serverDir: string, address: string): WorldIdentity {
  if (serverDir && existsSync(serverDir)) {
    try {
      const name = settingsFrom(loadProperties(serverDir)).levelName;
      if (name) return { key: name, local: true };
    } catch { /* 配置缺损:退回地址 */ }
  }
  return { key: address, local: false };
}

/** 环境提示词中的存档或服务器身份。 */
export function worldEnvLine(world: WorldIdentity): string {
  return world.local ? `当前存档:「${world.key}」` : `当前服务器:${world.key}`;
}

// ---------------------------------------------------------------------------
// 权限与作弊:ops.json 与那几项决定"谁能下命令"的 properties
// ---------------------------------------------------------------------------

/**
 * 专用服没有单人存档里那个「开作弊」开关。同一件事在这里是两半:**谁在
 * ops.json 里**(能不能下 /tp、/gamemode、/spectate 这类指令),以及
 * `op-permission-level`(op 拿到第几级权限,4 才够全部指令)。
 *
 * 托管服务器的控制台 stdin 天生是 4 级,所以 World 经 stdin 下的令不吃这一套;
 * bot 与人在**游戏里**打的命令吃——外部起的服务器没有 stdin,那条退路就是全部。
 *
 * ops.json 与 server.properties 一样只在**启动时**读:停机时改文件,跑着的时候
 * 只能走控制台 op/deop(服务端自己把新名单写回文件)。
 */
export interface AccessSettings {
  /** op 拿到的权限等级(1-4);4 = 全部指令 */
  opPermissionLevel: number;
  /** 命令方块能不能用 */
  enableCommandBlock: boolean;
  /** 创造/旁观之外的飞行不被踢 */
  allowFlight: boolean;
  /** 正版验证;她、摄像机、玩家都是离线账号,开着谁都进不来 */
  onlineMode: boolean;
  /** 白名单;开着而名单里没有这几个名字同样进不来 */
  whiteList: boolean;
}

export function accessFrom(lines: Line[]): AccessSettings {
  return {
    opPermissionLevel: pickInt(readProperty(lines, 'op-permission-level'), 4, 1, 4),
    enableCommandBlock: pickBool(readProperty(lines, 'enable-command-block'), false),
    allowFlight: pickBool(readProperty(lines, 'allow-flight'), false),
    onlineMode: pickBool(readProperty(lines, 'online-mode'), true),
    whiteList: pickBool(readProperty(lines, 'white-list'), false),
  };
}

export function applyAccess(lines: Line[], patch: Partial<AccessSettings>): Line[] {
  let out = lines;
  const set = (key: string, value: string | number | boolean | undefined): void => {
    if (value !== undefined) out = writeProperty(out, key, String(value));
  };
  set('op-permission-level', patch.opPermissionLevel);
  set('enable-command-block', patch.enableCommandBlock);
  set('allow-flight', patch.allowFlight);
  set('online-mode', patch.onlineMode);
  set('white-list', patch.whiteList);
  return out;
}

/** ops.json 的一条。服务端认的是 uuid,name 只是给人看的。 */
interface OpEntry {
  uuid: string;
  name: string;
  level: number;
  bypassesPlayerLimit: boolean;
}

function opsPath(serverDir: string): string {
  return join(serverDir, 'ops.json');
}

export function readOps(serverDir: string): OpEntry[] {
  const file = opsPath(serverDir);
  if (!serverDir || !existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is OpEntry => typeof e === 'object' && e !== null && 'name' in e);
  } catch {
    // 人手改坏了就当没有名单;这里再抛一次只会把面板整个变成错误卡
    return [];
  }
}

export function writeOps(serverDir: string, ops: OpEntry[]): void {
  writeFileSync(opsPath(serverDir), `${JSON.stringify(ops, null, 2)}\n`, 'utf8');
}

/**
 * 名字 → UUID。写错 UUID 的条目服务端根本认不出人,所以先问服务器自己见过谁
 * (usercache.json),没见过的按离线账号算——`online-mode=false` 下所有 UUID 都是
 * md5("OfflinePlayer:<名字>") 那一套,大小写敏感。
 */
export function resolveUuid(serverDir: string, name: string): string {
  const file = join(serverDir, 'usercache.json');
  if (serverDir && existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) {
        const hit = parsed.find(
          (e) => typeof e === 'object' && e !== null && (e as { name?: unknown }).name === name,
        ) as { uuid?: unknown } | undefined;
        if (typeof hit?.uuid === 'string') return hit.uuid;
      }
    } catch {
      /* 缓存读坏了就算离线 UUID */
    }
  }
  return offlineUuid(name);
}

/** 名单里已有这个名字的那条(按 uuid 或原样的名字认) */
function findOp(ops: OpEntry[], name: string, uuid: string): OpEntry | undefined {
  return ops.find((e) => e.uuid === uuid || e.name === name);
}

export function isOp(ops: OpEntry[], serverDir: string, name: string): OpEntry | undefined {
  return findOp(ops, name, resolveUuid(serverDir, name));
}

/** 加进名单(已在里面就只把等级抬到 level);返回改过的名单与是否真改了 */
export function grantOp(
  ops: OpEntry[], serverDir: string, name: string, level = 4,
): { ops: OpEntry[]; changed: boolean } {
  const uuid = resolveUuid(serverDir, name);
  const hit = findOp(ops, name, uuid);
  if (hit) {
    if (hit.level >= level) return { ops, changed: false };
    return { ops: ops.map((e) => (e === hit ? { ...e, level } : e)), changed: true };
  }
  return { ops: [...ops, { uuid, name, level, bypassesPlayerLimit: false }], changed: true };
}

export function revokeOp(ops: OpEntry[], serverDir: string, name: string): { ops: OpEntry[]; changed: boolean } {
  const uuid = resolveUuid(serverDir, name);
  const rest = ops.filter((e) => e.uuid !== uuid && e.name !== name);
  return { ops: rest, changed: rest.length !== ops.length };
}

/**
 * 停机时把这几个名字补进 ops.json(已在名单里的不动)。返回补进去的名字。
 * 服务器跑着的时候别调它:那会儿服务端手里有自己的一份名单,退出时整份写回,
 * 这里写的东西会被原样盖掉。
 */
export function ensureOps(serverDir: string, names: readonly string[], level = 4): string[] {
  if (!serverDir || !existsSync(serverDir)) return [];
  let ops = readOps(serverDir);
  const added: string[] = [];
  for (const name of names) {
    if (!name.trim()) continue;
    const next = grantOp(ops, serverDir, name, level);
    if (next.changed) added.push(name);
    ops = next.ops;
  }
  if (added.length) writeOps(serverDir, ops);
  return added;
}
