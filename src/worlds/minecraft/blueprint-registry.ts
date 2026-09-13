/**
 * 蓝图的 Minecraft 侧校验:Java 1.20.6 registry 认不认这个方块、这套属性齐不齐、
 * 执行器能否通过放置或使用物品得到这一格，以及施工要哪个物品。
 *
 * registry 数据从 mineflayer 自带的 minecraft-data 里取(与执行器同一份,不另钉版本),
 * 首次用到时才载入并缓存——纯查表,不起进程不落盘。
 *
 * 直接放置按 registry 的方块—物品对应关系受理；原版功能结构使用执行器有明确
 * 验收口径的动作，包括锄地、铲土径、放液源、播种、点火和切换常见红石状态。
 * `wall_` 变体使用去掉 `wall_` 后的物品名。
 *
 * 支撑与附着(门要完整顶面、作物要耕地、火把要贴得住)的规则表也在这里,一处维护;
 * 按位置核对由 `compileBlueprint` 拿着规则表跑。
 */

import { createRequire } from 'node:module';
import {
  CARDINAL_VECTORS,
  blockIdOf,
  formatBlockState,
  isAirState,
  parseBlockState,
  type Cardinal,
  type NormalizedBlueprint,
  type ParsedBlockState,
} from './blueprint.ts';

export const BLUEPRINT_MC_VERSION = '1.20.6' as const;

interface RegistryStateDefinition {
  name: string;
  type: 'enum' | 'bool' | 'int' | 'direction';
  values?: unknown[];
  num_values: number;
}

interface RegistryBlock {
  name: string;
  defaultState: number;
  states?: RegistryStateDefinition[];
}

interface MinecraftRegistry {
  blocksByName: Record<string, RegistryBlock | undefined>;
  itemsByName: Record<string, { id: number; name: string } | undefined>;
}

interface DecodedBlockState {
  getProperties(): Record<string, boolean | number | string>;
}

interface PrismarineBlock {
  fromStateId(stateId: number, biomeId: number): DecodedBlockState;
}

let cachedRegistry: MinecraftRegistry | null = null;
let cachedBlockFactory: PrismarineBlock | null = null;

/** minecraft-data / prismarine-block 都挂在 mineflayer 下,顺着它解析,版本永远一致 */
function fromMineflayer<T>(moduleName: string): T {
  const localRequire = createRequire(import.meta.url);
  const mineflayerRequire = createRequire(localRequire.resolve('mineflayer'));
  return mineflayerRequire(moduleName) as T;
}

function registry(): MinecraftRegistry {
  if (cachedRegistry === null) {
    const factory = fromMineflayer<(version: string) => MinecraftRegistry>('minecraft-data');
    cachedRegistry = factory(BLUEPRINT_MC_VERSION);
  }
  return cachedRegistry;
}

function blockFactory(): PrismarineBlock {
  if (cachedBlockFactory === null) {
    const factory = fromMineflayer<(version: string) => PrismarineBlock>('prismarine-block');
    cachedBlockFactory = factory(BLUEPRINT_MC_VERSION);
  }
  return cachedBlockFactory;
}

/** `minecraft:oak_planks` → `oak_planks`;别的命名空间返回 null */
function vanillaName(id: string): string | null {
  const [namespace, name] = id.split(':', 2);
  return namespace === 'minecraft' && name ? name : null;
}

// ── 默认状态补齐 ──────────────────────────────────────────────────────────────

interface DefaultStateCompletion {
  state: string;
  /** 这次补上的属性;一条都没补时是空对象 */
  added: Record<string, string>;
}

/**
 * 漏写的属性用 registry 注册的默认状态补齐。
 * 实测这是宽容层里最大的一个动作(benchmark 50 发共补 1141 次)——模型写楼梯
 * 记得写 facing,十有八九忘了 shape。
 */
export function completeBlockStateDefaults(
  state: string,
  path = 'block state',
): DefaultStateCompletion {
  const parsed = parseBlockState(state, path);
  const name = vanillaName(parsed.id);
  if (name === null) return { state, added: {} };
  const block = registry().blocksByName[name];
  if (block === undefined) return { state, added: {} };

  const defaults = blockFactory().fromStateId(block.defaultState, 0).getProperties();
  const added: Record<string, string> = {};
  for (const definition of block.states ?? []) {
    if (parsed.properties[definition.name] !== undefined) continue;
    const value = defaults[definition.name];
    if (value !== undefined) added[definition.name] = String(value);
  }
  return {
    state: formatBlockState({ id: parsed.id, properties: { ...added, ...parsed.properties } }),
    added,
  };
}

// ── registry 校验 ─────────────────────────────────────────────────────────────

export interface BlueprintStateFailure {
  /** 该状态在矩阵里第一次出现的位置 */
  path: string;
  state: string;
  reason: string;
}

interface RegistryValidation {
  valid: boolean;
  minecraft_version: typeof BLUEPRINT_MC_VERSION;
  /** 去重后的状态条数;每种只校验一次 */
  unique_states: number;
  failures: BlueprintStateFailure[];
}

/** 状态 → 它在矩阵里第一次出现的路径;同一状态只校验一次,报错报第一处 */
function firstStatePaths(blueprint: NormalizedBlueprint): Map<string, string> {
  const states = new Map<string, string>();
  for (let y = 0; y < blueprint.layers.length; y++) {
    for (let z = 0; z < blueprint.layers[y].length; z++) {
      for (let x = 0; x < blueprint.layers[y][z].length; x++) {
        const state = blueprint.layers[y][z][x];
        if (!states.has(state)) states.set(state, `layers[${y}][${z}][${x}]`);
      }
    }
  }
  return states;
}

function invalidValueReason(
  definition: RegistryStateDefinition,
  value: string,
): string | null {
  if (definition.type === 'bool') {
    return value === 'true' || value === 'false'
      ? null
      : `${definition.name}=${value} 不合法,只能是 true 或 false`;
  }
  const allowed = definition.values?.map(String);
  if (allowed !== undefined && !allowed.includes(value)) {
    return `${definition.name}=${value} 不合法,只能是 ${allowed.join('、')}`;
  }
  if (definition.type === 'int' && !/^-?\d+$/.test(value)) {
    return `${definition.name}=${value} 不合法,这里要整数`;
  }
  return null;
}

function propertyProblems(parsed: ParsedBlockState, block: RegistryBlock): string[] {
  const definitions = block.states ?? [];
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const problems: string[] = [];

  const missing = definitions
    .map((definition) => definition.name)
    .filter((name) => !(name in parsed.properties));
  if (missing.length > 0) problems.push(`缺属性:${missing.join('、')}`);

  const unknown = Object.keys(parsed.properties).filter((name) => !byName.has(name)).sort();
  if (unknown.length > 0) problems.push(`多了不存在的属性:${unknown.join('、')}`);

  for (const definition of definitions) {
    const value = parsed.properties[definition.name];
    if (value === undefined) continue;
    const problem = invalidValueReason(definition, value);
    if (problem !== null) problems.push(problem);
  }
  return problems;
}

function validateState(state: string, path: string): BlueprintStateFailure | null {
  let parsed: ParsedBlockState;
  try {
    parsed = parseBlockState(state, path);
  } catch (error) {
    return { path, state, reason: error instanceof Error ? error.message : '状态串解析失败' };
  }

  const name = vanillaName(parsed.id);
  if (name === null) {
    return { path, state, reason: `命名空间只收 minecraft,给的是 ${parsed.id}` };
  }
  const block = registry().blocksByName[name];
  if (block === undefined) {
    return { path, state, reason: `Java ${BLUEPRINT_MC_VERSION} 里没有 ${parsed.id} 这个方块` };
  }
  const problems = propertyProblems(parsed, block);
  return problems.length === 0 ? null : { path, state, reason: problems.join(';') };
}

/** 逐个去重状态过 registry:方块存不存在、属性齐不齐、值合不合法 */
export function validateBlueprintRegistry(blueprint: NormalizedBlueprint): RegistryValidation {
  const paths = firstStatePaths(blueprint);
  const failures: BlueprintStateFailure[] = [];
  for (const [state, path] of paths) {
    const failure = validateState(state, path);
    if (failure !== null) failures.push(failure);
  }
  return {
    valid: failures.length === 0,
    minecraft_version: BLUEPRINT_MC_VERSION,
    unique_states: paths.size,
    failures,
  };
}

// ── 状态 → 物品 ───────────────────────────────────────────────────────────────

/**
 * 有同名物品、但那个物品放不出这个方块的几处。逐条写明理由,不靠模式猜。
 * 名单短是有意的:靠"registry 里有没有同名物品"这一条机械事实就能挡掉九成,
 * 剩下的例外只有这几个,一个个说清楚比编一条规则可靠。
 */
const ITEM_EXISTS_BUT_UNPLACEABLE: Record<string, string> = {
  farmland: '耕地是拿锄头锄出来的,不是放出来的',
  dirt_path: '土径是拿锹铲出来的,不是放出来的',
  wheat: '小麦方块是种子长出来的(wheat 物品是食材)',
};

/**
 * 没有同名物品、但确实有一个物品能放出来的几处。原版规则,写死无妨。
 * `wall_` 变体走通用规则(去掉 `wall_` 就是它的物品),不列在这里。
 */
const ITEM_ALIAS: Record<string, string> = {
  redstone_wire: 'redstone',
  tripwire: 'string',
  cocoa: 'cocoa_beans',
};

type BlockItemLookup =
  | { item: string }
  | { item: null; reason: string };

export type BlueprintPlacementMethod =
  | {
      kind: 'place';
      item: string;
      /** 放置后通过右键调到的功能状态。 */
      postUse?: { property: string; value: string; maxUses: number };
    }
  | {
      kind: 'use';
      item: string;
      target: 'self' | 'below';
      /** 该动作要求保持的功能属性；其余属性仍按 state 尽力口径。 */
      verify?: { property: string; value: string };
      /**
       * 能就地加工成目标的全部源方块；`[0]` 是账单与补基材时用的那一样。
       * 已经是其中任何一样就不必补 —— 锄头对它们产出的目标完全相同。
       */
      baseItem?: readonly string[];
      /** 工具不会按施工格数消耗，整段只要求一件。 */
      reusable?: true;
    };

type BlueprintPlacementResult =
  | BlueprintPlacementMethod
  | { item: null; reason: string };

/**
 * 施工方式里用族名点到的工具:'hoe' 是随便哪把锄。库存对账时只有这两个名字
 * 按 `_hoe`/`_shovel` 后缀认;耗材(dirt、carrot……)必须按原名精确对——
 * 后缀模糊会把 golden_carrot 记成能种的胡萝卜、dirt_path 记成基材泥土。
 */
export const BLUEPRINT_TOOL_FAMILIES: ReadonlySet<string> = new Set(['hoe', 'shovel']);

/**
 * 锄头翻出来是什么。粗泥/根泥翻成普通泥土,草方块与泥土翻成耕地;本来就是耕地的
 * 再翻一次原版什么都不发生,那一格已经是她要的样子。
 * (把握:grass_block/dirt 确定;dirt_path/coarse_dirt/rooted_dirt 比较确定。
 * 灰化土与菌丝记不真切,不入表 —— 犹豫本身就是"这一格该退回现状"的证据。)
 */
export const HOE_TILLED: Readonly<Record<string, string>> = {
  grass_block: 'farmland',
  dirt: 'farmland',
  dirt_path: 'farmland',
  farmland: 'farmland',
  coarse_dirt: 'dirt',
  rooted_dirt: 'dirt',
};

/** 锹右键能压成土径的地表。 */
export const SHOVEL_PATH: Readonly<Record<string, string>> = {
  grass_block: 'dirt_path',
  dirt: 'dirt_path',
  coarse_dirt: 'dirt_path',
  mycelium: 'dirt_path',
  podzol: 'dirt_path',
  rooted_dirt: 'dirt_path',
  dirt_path: 'dirt_path',
};

/** 可由该工具加工成 target 的全部源方块；canonical 排首位，供账单与补基材使用。 */
function sourcesFor(table: Readonly<Record<string, string>>, target: string, canonical: string): string[] {
  return [canonical, ...Object.keys(table).filter((k) => table[k] === target && k !== canonical)];
}

const FARMLAND_SOURCES = sourcesFor(HOE_TILLED, 'farmland', 'dirt');
const DIRT_PATH_SOURCES = sourcesFor(SHOVEL_PATH, 'dirt_path', 'dirt');

const CROP_ITEM: Record<string, string> = {
  wheat: 'wheat_seeds',
  beetroots: 'beetroot_seeds',
  carrots: 'carrot',
  potatoes: 'potato',
  melon_stem: 'melon_seeds',
  pumpkin_stem: 'pumpkin_seeds',
  torchflower_crop: 'torchflower_seeds',
  nether_wart: 'nether_wart',
};

/**
 * 目标状态的施工方式。直接放置之外只收执行器已有明确验收口径的原版动作。
 */
export function blueprintPlacementMethod(state: string): BlueprintPlacementResult {
  const parsed = parseBlockState(state);
  const name = vanillaName(parsed.id);
  if (name === null) return { item: null, reason: `命名空间只收 minecraft,给的是 ${parsed.id}` };

  if (name === 'farmland') {
    return { kind: 'use', item: 'hoe', target: 'self', baseItem: FARMLAND_SOURCES, reusable: true };
  }
  if (name === 'dirt_path') {
    return { kind: 'use', item: 'shovel', target: 'self', baseItem: DIRT_PATH_SOURCES, reusable: true };
  }
  if (name === 'water' || name === 'lava') {
    if (parsed.properties.level !== '0') {
      return { item: null, reason: `${name} 只收 level=0 的源方块,流动状态由游戏自己生成` };
    }
    return {
      kind: 'use', item: `${name}_bucket`, target: 'below',
      verify: { property: 'level', value: '0' },
    };
  }
  if (name === 'pitcher_crop') {
    return { item: null, reason: 'pitcher_crop 会随生长阶段从一格变两格，蓝图不伪造它的过程状态' };
  }
  const cropItem = CROP_ITEM[name];
  if (cropItem !== undefined) {
    if (parsed.properties.age !== undefined && parsed.properties.age !== '0') {
      return { item: null, reason: `${name} 蓝图只收 age=0;成熟度由生长过程产生` };
    }
    return { kind: 'use', item: cropItem, target: 'below' };
  }
  if (name === 'fire' && parsed.properties.age !== undefined && parsed.properties.age !== '0') {
    return { item: null, reason: 'fire 蓝图只收 age=0；后续火势由游戏演化' };
  }
  if (name === 'fire' || name === 'soul_fire') {
    return { kind: 'use', item: 'flint_and_steel', target: 'below', reusable: true };
  }

  const direct = blockStateItem(state);
  if (direct.item === null) return direct;
  let postUse: Extract<BlueprintPlacementMethod, { kind: 'place' }>['postUse'];
  if ((name === 'iron_door' || name === 'iron_trapdoor') && parsed.properties.open === 'true') {
    return { item: null, reason: `${name} 不能徒手切到 open=true;请把蓝图终态画成关闭状态` };
  }
  if (name === 'lever') {
    postUse = { property: 'powered', value: parsed.properties.powered ?? 'false', maxUses: 1 };
  }
  if (name === 'repeater') {
    postUse = { property: 'delay', value: parsed.properties.delay ?? '1', maxUses: 4 };
  }
  if (name === 'comparator') {
    postUse = { property: 'mode', value: parsed.properties.mode ?? 'compare', maxUses: 2 };
  }
  if ((name.endsWith('_door') || name.endsWith('_trapdoor') || name.endsWith('_fence_gate'))
    && name !== 'iron_door' && name !== 'iron_trapdoor') {
    postUse = { property: 'open', value: parsed.properties.open ?? 'false', maxUses: 1 };
  }
  return { kind: 'place', item: direct.item, ...(postUse ? { postUse } : {}) };
}

/**
 * 放出这一格要哪个物品。空气族返回 null 且理由是"不用放"——调用方应当先过滤掉。
 *
 * 只认"直接放这个物品就得到这个方块"。属性能不能一模一样不在这里管:
 * 放置保真度的口径是 type 忠实、state 尽力、drift 如实报。
 */
export function blockStateItem(state: string): BlockItemLookup {
  if (isAirState(state)) return { item: null, reason: '空气格不用放东西' };

  const id = blockIdOf(state);
  const name = vanillaName(id);
  if (name === null) return { item: null, reason: `命名空间只收 minecraft,给的是 ${id}` };

  const unplaceable = ITEM_EXISTS_BUT_UNPLACEABLE[name];
  if (unplaceable !== undefined) return { item: null, reason: unplaceable };

  const items = registry().itemsByName;
  const alias = ITEM_ALIAS[name];
  if (alias !== undefined && items[alias]) return { item: alias };
  if (items[name]) return { item: name };

  if (name.includes('wall_')) {
    const wallless = name.replace('wall_', '');
    if (items[wallless]) return { item: wallless };
  }
  return { item: null, reason: `没有能直接放出 ${id} 的物品` };
}

// ── 支撑与附着 ────────────────────────────────────────────────────────────────

/**
 * 支撑格要满足的条件。`block` 是"只长得住在某个方块上"(作物与耕地);
 * `sturdy` 要一整格完整顶面(门);`attach` 只要求那一格不是空气、也不是本身
 * 托不住东西的那一类(火把、床)。
 */
type BlueprintSupportRequirement =
  | { kind: 'block'; id: string }
  | { kind: 'sturdy' }
  | { kind: 'attach' };

interface BlueprintSupportRule {
  /** 支撑格相对这一格的位移(蓝图局部坐标:X 西→东、Y 下→上、Z 北→南) */
  offset: readonly [number, number, number];
  requirement: BlueprintSupportRequirement;
  /** 对支撑格的要求,一句人话;失败与"这一格靠图外现场"两种回执都拿它开头 */
  demand: string;
}

const BELOW = [0, -1, 0] as const;

const FARMLAND_ID = 'minecraft:farmland';

/** 作物长在什么上面。地狱疣是灵魂沙,其余都是耕地。 */
const CROP_SOIL: Record<string, { id: string; label: string }> = {
  wheat: { id: FARMLAND_ID, label: '耕地' },
  beetroots: { id: FARMLAND_ID, label: '耕地' },
  carrots: { id: FARMLAND_ID, label: '耕地' },
  potatoes: { id: FARMLAND_ID, label: '耕地' },
  melon_stem: { id: FARMLAND_ID, label: '耕地' },
  pumpkin_stem: { id: FARMLAND_ID, label: '耕地' },
  torchflower_crop: { id: FARMLAND_ID, label: '耕地' },
  nether_wart: { id: 'minecraft:soul_sand', label: '灵魂沙' },
};

const STANDING_TORCHES: ReadonlySet<string> = new Set(['torch', 'soul_torch', 'redstone_torch']);
const WALL_TORCHES: ReadonlySet<string> = new Set([
  'wall_torch', 'soul_wall_torch', 'redstone_wall_torch',
]);

/**
 * 这一格要靠哪一格撑住。从部件(门的上半格、床头)不出施工步,也就不在这里要支撑。
 *
 * 只覆盖门、作物、火把、床这几族——不复刻原版整套 canSurvive:点不到的一律放行,
 * 漏报一处,好过挡下一张本来盖得起来的图。
 */
export function blueprintSupportRules(state: string): BlueprintSupportRule[] {
  const parsed = parseBlockState(state);
  const name = vanillaName(parsed.id);
  if (name === null) return [];

  const soil = CROP_SOIL[name];
  if (soil !== undefined) {
    return [{
      offset: BELOW,
      requirement: { kind: 'block', id: soil.id },
      demand: `要种在${soil.label}上`,
    }];
  }
  if (name.endsWith('_door') && parsed.properties.half !== 'upper') {
    return [{ offset: BELOW, requirement: { kind: 'sturdy' }, demand: '底下要一格顶面完整的方块' }];
  }
  if (STANDING_TORCHES.has(name)) {
    return [{ offset: BELOW, requirement: { kind: 'attach' }, demand: '要立在一格托得住它的方块上' }];
  }
  if (WALL_TORCHES.has(name)) {
    const facing = parsed.properties.facing;
    if (facing === undefined || !Object.hasOwn(CARDINAL_VECTORS, facing)) return [];
    // 取负别落出 -0(它和 0 相等但深比较不认)
    const neg = (value: number): number => (value === 0 ? 0 : -value);
    const [dx, dy, dz] = CARDINAL_VECTORS[facing as Cardinal];
    return [{
      offset: [neg(dx), neg(dy), neg(dz)],
      requirement: { kind: 'attach' },
      demand: '要贴在旁边一格方块的侧面上',
    }];
  }
  // 1.20.6 里只有床有 part;床头是从部件,由床脚那一步一起长出来
  if (parsed.properties.part === 'foot') {
    return [{ offset: BELOW, requirement: { kind: 'attach' }, demand: '底下要一格托得住它的方块' }];
  }
  return [];
}

/** 这一格的施工要先把底下锄成耕地——账单据此把锄算进去。 */
export function blueprintNeedsTilledSoil(state: string): boolean {
  return blueprintSupportRules(state).some(
    (rule) => rule.requirement.kind === 'block' && rule.requirement.id === FARMLAND_ID,
  );
}

/**
 * 顶上托不住东西的方块。原版判据是上表面完整不完整,这里只列确定托不住的这些族。
 */
const NO_TOP_SUPPORT_EXACT: Record<string, string> = {
  farmland: '耕地只种得住作物',
  dirt_path: '土径的上表面不完整',
  iron_bars: '铁栏杆顶上托不住东西',
  ladder: '梯子顶上托不住东西',
  chain: '锁链顶上托不住东西',
  rail: '铁轨顶上托不住东西',
  scaffolding: '脚手架的上表面不完整',
  snow: '雪片顶上托不住东西',
  vine: '藤蔓顶上托不住东西',
  redstone_wire: '红石线顶上托不住东西',
  water: '水里放不住东西',
  lava: '岩浆里放不住东西',
};

const NO_TOP_SUPPORT_SUFFIX: ReadonlyArray<readonly [string, string]> = [
  ['_door', '门的上表面不完整'],
  ['_trapdoor', '活板门的上表面不完整'],
  ['_fence_gate', '栅栏门的上表面不完整'],
  ['torch', '火把顶上托不住东西'],
  ['_bed', '床顶上托不住东西'],
  ['_carpet', '地毯顶上托不住东西'],
  ['_button', '按钮顶上托不住东西'],
  ['_pressure_plate', '压力板顶上托不住东西'],
  ['_sapling', '树苗顶上托不住东西'],
  ['_sign', '告示牌顶上托不住东西'],
  ['_banner', '旗帜顶上托不住东西'],
  ['_rail', '铁轨顶上托不住东西'],
];

/** 顶面撑得住火把、床,却撑不住门的那几族 */
const NO_STURDY_TOP_SUFFIX: ReadonlyArray<readonly [string, string]> = [
  ['_fence', '栅栏的顶面不是完整一格'],
  ['_wall', '墙的顶面不是完整一格'],
];

function noSupportReason(parsed: ParsedBlockState, name: string, sturdy: boolean): string | null {
  const exact = NO_TOP_SUPPORT_EXACT[name];
  if (exact !== undefined) return exact;
  if (CROP_SOIL[name] !== undefined) return '作物顶上托不住东西';
  for (const [suffix, why] of NO_TOP_SUPPORT_SUFFIX) if (name.endsWith(suffix)) return why;
  if (!sturdy) return null;
  for (const [suffix, why] of NO_STURDY_TOP_SUFFIX) if (name.endsWith(suffix)) return why;
  if (name.endsWith('_slab') && parsed.properties.type === 'bottom') {
    return '下半砖的顶面只到半格高';
  }
  return null;
}

/** 支撑格不满足要求时的说明;满足、或规则表点不到那个方块时给 null。 */
export function blueprintSupportViolation(
  rule: BlueprintSupportRule,
  supportState: string,
): string | null {
  if (isAirState(supportState)) return '图里那一格是空的';
  const id = blockIdOf(supportState);
  if (rule.requirement.kind === 'block') {
    return id === rule.requirement.id ? null : `图里那一格是 ${id}`;
  }
  const parsed = parseBlockState(supportState);
  const name = vanillaName(parsed.id);
  if (name === null) return null;
  const why = noSupportReason(parsed, name, rule.requirement.kind === 'sturdy');
  return why === null ? null : `图里那一格是 ${id},${why}`;
}

/**
 * 画图时那几条撑与贴的规矩。跟上面的规则表放在一处,校验与提示词不会各说各的。
 */
export const BLUEPRINT_SUPPORT_DOC = [
  '· 作物图自带耕地层:melon_stem/pumpkin_stem/小麦/胡萝卜这些的正下方要画'
    + ' minecraft:farmland(它会自动垫泥土再锄出来);图里没有那一层,种子就一直放不下去;',
  '· 门、床、火把、作物这些要贴着别的方块才立得住:支撑格要么画进图里,要么确认现场已经有。'
    + '门底下要一格顶面完整的方块——栅栏、栅栏门、墙、下半砖、另一扇门都撑不住门;',
  '· 想保留现场原样的格(河道、树干、已有墙体)画 minecraft:structure_void,别画成 minecraft:air'
    + '——air 是"这一格必须清空"。',
].join('\n');

interface PlaceabilityValidation {
  valid: boolean;
  failures: BlueprintStateFailure[];
}

/**
 * 逐个去重状态核对"这一格放得出来吗";放不出来的点名报,理由带上。
 * 多部件的从部件(门的上半格、床头)在这里照样过——它们的物品就是主部件那一个;
 * 从部件孤立无主的情形由 IR 编译按位置查(`compileBlueprint`)。
 */
export function validateBlueprintPlaceability(
  blueprint: NormalizedBlueprint,
): PlaceabilityValidation {
  const failures: BlueprintStateFailure[] = [];
  for (const [state, path] of firstStatePaths(blueprint)) {
    if (isAirState(state)) continue;
    const lookup = blueprintPlacementMethod(state);
    if (lookup.item === null) failures.push({ path, state, reason: lookup.reason });
  }
  return { valid: failures.length === 0, failures };
}
