/**
 * 读取物品的附魔与耐久，支持组件数据和 NBT。
 * 当前 1.20.6 注册表的 maxDurability 数据不完整，耐久上限使用下方原版公式表。
 */

/** 一条附魔:`name` 是原版 id(去掉 minecraft: 前缀),`level` 是她看见的那个罗马数字的值 */
export interface ItemEnchant {
  name: string;
  level: number;
}

/** 剩余耐久与上限,单位是原版的「点」 */
export interface Durability {
  left: number;
  max: number;
}

/** 读得到组件/NBT 的最小物品形状;真件是 prismarine-item,台架给同形 POJO */
export interface ItemLike {
  name: string;
  count?: number;
  componentMap?: Map<string, { type?: string; data?: unknown }>;
  nbt?: unknown;
}

/** 按 id 查名字的注册表口;`bot.registry` 就是这个形状 */
export interface EnchantRegistry {
  enchantments?: Record<number, { name?: string } | undefined>;
}

const TOOL_MAX: Record<string, number> = {
  wooden: 59, stone: 131, iron: 250, golden: 32, diamond: 1561, netherite: 2031,
};
const TOOL_KIND = new Set(['pickaxe', 'axe', 'shovel', 'hoe', 'sword']);

/** 盔甲耐久 = 材质基数 × 部位系数(原版公式) */
const ARMOR_BASE: Record<string, number> = {
  leather: 5, chainmail: 15, iron: 15, golden: 7, diamond: 33, netherite: 37,
};
const ARMOR_SLOT: Record<string, number> = {
  helmet: 11, chestplate: 16, leggings: 15, boots: 13,
};

/** 不按材质×部位算的那几件 */
const WHOLE_MAX: Record<string, number> = {
  shield: 336, bow: 384, crossbow: 465, trident: 250, elytra: 432,
  fishing_rod: 64, flint_and_steel: 64, shears: 238, brush: 64,
  carrot_on_a_stick: 25, warped_fungus_on_a_stick: 100,
  // 海龟壳只有头盔一件,套不进材质×部位那张表
  turtle_helmet: 275,
};

/** 这件东西的耐久上限;不带耐久的物品返回 null */
export function maxDurabilityOf(id: string): number | null {
  const name = id.replace(/^minecraft:/, '');
  const whole = WHOLE_MAX[name];
  if (whole !== undefined) return whole;
  const cut = name.lastIndexOf('_');
  if (cut < 0) return null;
  const head = name.slice(0, cut);
  const tail = name.slice(cut + 1);
  if (TOOL_KIND.has(tail) && TOOL_MAX[head] !== undefined) return TOOL_MAX[head];
  const slot = ARMOR_SLOT[tail];
  const base = ARMOR_BASE[head];
  if (slot !== undefined && base !== undefined) return base * slot;
  return null;
}

function componentData(item: ItemLike, type: string): unknown {
  return item.componentMap?.get(type)?.data;
}

/** NBT compound 里取一个键的裸值;层级对不上就返回 undefined */
function nbtValue(node: unknown, key: string): unknown {
  const v = (node as { value?: Record<string, { value?: unknown }> } | undefined)?.value;
  return v?.[key]?.value;
}

/** 已损耗的耐久点数;读不到返回 null(与「没损耗」是两回事) */
export function readDamage(item: ItemLike): number | null {
  const comp = componentData(item, 'damage');
  if (typeof comp === 'number') return comp;
  const raw = nbtValue(item.nbt, 'Damage');
  return typeof raw === 'number' ? raw : null;
}

/**
 * 剩余耐久;这件东西不带耐久时返回 null。
 * 没损耗过的物品身上没有 damage 组件(NBT 时代同理没有 Damage 键),这是原版的
 * 「零损耗」写法,不是读不到。
 */
export function readDurability(item: ItemLike): Durability | null {
  const max = maxDurabilityOf(item.name);
  if (max === null) return null;
  return { left: Math.max(0, max - (readDamage(item) ?? 0)), max };
}

/**
 * 这件东西身上的附魔。附魔书走 stored_enchantments,别的走 enchantments;
 * 两处形状一样,合起来报。
 */
export function readEnchants(item: ItemLike, registry?: EnchantRegistry | null): ItemEnchant[] {
  const out: ItemEnchant[] = [];
  for (const type of ['enchantments', 'stored_enchantments']) {
    const data = componentData(item, type) as { enchantments?: Array<{ id?: unknown; level?: unknown }> } | undefined;
    for (const e of data?.enchantments ?? []) {
      const name = enchantName(e.id, registry);
      if (name !== null && typeof e.level === 'number') out.push({ name, level: e.level });
    }
  }
  if (out.length > 0) return out;
  for (const key of ['Enchantments', 'StoredEnchantments']) {
    const list = nbtValue(item.nbt, key) as { value?: Array<Record<string, { value?: unknown }>> } | undefined;
    for (const e of list?.value ?? []) {
      const name = enchantName(e.id?.value, registry);
      const lvl = e.lvl?.value;
      if (name !== null && typeof lvl === 'number') out.push({ name, level: lvl });
    }
  }
  return out;
}

/** 附魔 id 可能是字符串(NBT 时代)或注册表序号(组件时代);查不出名字就不报这一条 */
function enchantName(id: unknown, registry?: EnchantRegistry | null): string | null {
  if (typeof id === 'string') return id.replace(/^minecraft:/, '');
  if (typeof id !== 'number') return null;
  return registry?.enchantments?.[id]?.name ?? null;
}

/**
 * 药水内容的注册表序号;不是药水、或读不到时 null。
 *
 * 1.20.6 里水瓶与全部药水的物品 id 都是 `potion`,名字上分不出来,只有这个序号能分。
 * minecraft-data 不带药水注册表,所以只报序号不译名 —— 编一个名字比给个数字更坏。
 */
export function readPotionId(item: ItemLike): number | null {
  const data = componentData(item, 'potion_contents') as { potionId?: unknown } | undefined;
  return typeof data?.potionId === 'number' ? data.potionId : null;
}

/** 一样能喝下去、但不给饱食度的东西 */
interface Drinkable {
  /** 回执里的量词说法:「喝了一桶奶」 */
  label: string;
  /** 喝完剩在包里的空容器物品 id */
  empty: string;
  /** 这一口真正发生的事 —— 不是饱食度,回执不能拿 food 读数当结果 */
  effect: string;
}

/**
 * 能喝、但 minecraft-data 的 foods 表里没有的东西。
 *
 * 那张表只收「给饱食度」的物品,牛奶桶一点饱食度都不给,于是它整个不在表里:
 * `eat` 的前置判据是 `foodsByName[item]`,点名牛奶桶当场被判「不是可进食物品」;
 * 手持它走 `use` 也没用 —— 落进通用兜底(按一下 1.2 秒就松手),而喝完一桶奶要
 * 1.61 秒,那个动作从来没跑完过。两条路都不通,所以奶在这个世界里喝不掉。
 * Mineflayer 的 `consume()` 本身认它(ALWAYS_CONSUMABLES),缺的只是这张表。
 */
export const DRINKABLES: Readonly<Record<string, Drinkable>> = {
  milk_bucket: {
    label: '一桶奶',
    empty: 'bucket',
    effect: '身上的状态效果被清光(增益也一起清掉)',
  },
};
