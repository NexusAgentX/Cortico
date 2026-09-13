/**
 * 从实体元数据里读得出来的几件事实。与 `piglin.ts` 同一条路子:元数据的下标随协议
 * 版本走 `registry.entitiesByName[..].metadataKeys`,不把 1.20.6 的数值写死。
 *
 * 这里只回答"现在是什么样",不回答"该不该做"——判断留给她。
 */

interface NamedStack { name?: string }

interface FactEntity {
  name?: string;
  metadata?: unknown[];
}

interface FactBot {
  entity?: { uuid?: string } | null;
  /** 自己的 UUID 的可靠来源:mineflayer 从不给自己的 entity 设 uuid,login 时只设 bot.player/_client */
  player?: { uuid?: string } | null;
  _client?: { uuid?: string } | null;
  inventory?: { slots?: Array<NamedStack | null | undefined> };
  registry?: {
    entitiesByName?: Record<string, { metadataKeys?: string[] } | undefined>;
  };
}

function metaOf(bot: FactBot, entity: FactEntity, key: string): unknown {
  const name = entity.name;
  if (!name) return undefined;
  const keys = bot.registry?.entitiesByName?.[name]?.metadataKeys ?? [];
  const at = keys.indexOf(key);
  return at >= 0 ? entity.metadata?.[at] : undefined;
}

/** 可驯服实体与对应道具。消耗道具只能证明使用发生，驯服结果须读取主人元数据。 */
export const TAME_ITEMS: Readonly<Record<string, readonly string[]>> = {
  wolf: ['bone'],
  cat: ['cod', 'salmon'],
  ocelot: ['cod', 'salmon'],
  parrot: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds', 'torchflower_seeds', 'pitcher_pod'],
};

/**
 * 喂得进去的那几种×食物。原版的规矩是**喂不进去就不消耗**(未成年、刚繁殖过冷却中、
 * 或者根本不吃这个),所以"手上少没少"是一个精确信号——它只说"这一口被接受了",
 * 不说"生出小的了":繁殖要两只都进入求偶状态。
 * (把握:牛羊猪鸡兔确定;哞菇同牛,山羊同牛。)
 */
export const FEED_ITEMS: Readonly<Record<string, readonly string[]>> = {
  cow: ['wheat'],
  mooshroom: ['wheat'],
  sheep: ['wheat'],
  goat: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'],
  rabbit: ['carrot', 'golden_carrot', 'dandelion'],
  chicken: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds', 'torchflower_seeds', 'pitcher_pod'],
  // 1.20.5 起狼的食物是 #wolf_food 物品标签:全部生熟肉(含腐肉)+全部鱼类
  wolf: ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'rotten_flesh', 'cod', 'salmon', 'cooked_cod', 'cooked_salmon', 'tropical_fish', 'pufferfish'],
  cat: ['cod', 'salmon', 'tropical_fish', 'pufferfish'],
  horse: ['golden_carrot', 'golden_apple', 'hay_block'],
  donkey: ['golden_carrot', 'golden_apple', 'hay_block'],
  llama: ['hay_block'],
  armadillo: ['spider_eye'],
  panda: ['bamboo'],
  turtle: ['seagrass'],
  fox: ['sweet_berries', 'glow_berries'],
  bee: ['dandelion', 'poppy', 'sunflower'],
  frog: ['slime_ball'],
  sniffer: ['torchflower_seeds'],
  camel: ['cactus'],
  strider: ['warped_fungus'],
  hoglin: ['crimson_fungus'],
  axolotl: ['tropical_fish_bucket'],
};

/** 这只活物现在的主人 UUID;没被驯服/读不到元数据返回 null。 */
export function readTamedBy(bot: FactBot, entity: FactEntity): string | null {
  const raw = metaOf(bot, entity, 'owneruuid');
  // 协议把"没有主人"编成缺席的 optional;不同版本的 protodef 分别给 undefined/null/''
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'string') return raw;
  // OptionalUUID 有时解成 { present, value } 或者裸的 UUID 对象
  const obj = raw as { value?: unknown; present?: unknown };
  if (obj.present === false) return null;
  const inner = obj.value ?? raw;
  return typeof inner === 'string' && inner !== '' ? inner : null;
}

/**
 * 主人 UUID 与当前玩家一致时返回 true；缺少任一身份时返回 false。
 * 登录阶段 bot.entity.uuid 可能缺失，优先使用 bot.player.uuid，并保留实体与协议客户端来源。
 */
export function tamedByMe(bot: FactBot, entity: FactEntity): boolean {
  const owner = readTamedBy(bot, entity);
  const me = bot.player?.uuid ?? bot.entity?.uuid ?? bot._client?.uuid;
  return owner !== null && typeof me === 'string' && me !== '' && owner === me;
}

/**
 * 驯服族的坐/立:`flags` 元数据(TamableAnimal 的共享位)的 0x01 位是 sitting。
 * 读不到(不是驯服族、元数据缺席)返回 null —— 这一层不猜。
 */
export function readSitting(bot: FactBot, entity: FactEntity): boolean | null {
  const raw = metaOf(bot, entity, 'flags');
  if (typeof raw !== 'number') return null;
  return (raw & 0x01) !== 0;
}

/**
 * 身上有没有鞍。猪/炽足兽在元数据 'saddle'(布尔);马科(horse/donkey/mule)在
 * 'flags' 的 0x04 位(0x02 是驯服)。读不到返回 null —— 这一层不猜。
 */
export function readSaddled(bot: FactBot, entity: FactEntity): boolean | null {
  const direct = metaOf(bot, entity, 'saddle');
  if (typeof direct === 'boolean') return direct;
  if (typeof direct === 'number') return direct !== 0;
  if (entity.name === 'horse' || entity.name === 'donkey' || entity.name === 'mule') {
    const flags = metaOf(bot, entity, 'flags');
    return typeof flags === 'number' ? (flags & 0x04) !== 0 : null;
  }
  return null;
}

/** 马科的「驯服」位:'flags' 的 0x02。不是马科或读不到返回 null。 */
export function readHorseTamed(bot: FactBot, entity: FactEntity): boolean | null {
  if (entity.name !== 'horse' && entity.name !== 'donkey' && entity.name !== 'mule') return null;
  const flags = metaOf(bot, entity, 'flags');
  return typeof flags === 'number' ? (flags & 0x02) !== 0 : null;
}

/** 羊毛元数据的低四位是颜色,第五位(0x10)是"剪过了"。 */
const WOOL_COLORS = [
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black',
] as const;

/** 染料 item 名 → 颜色名;不是染料返回 null。 */
export function dyeColorOf(item: string | null | undefined): string | null {
  if (!item || !item.endsWith('_dye')) return null;
  const color = item.slice(0, -'_dye'.length);
  return (WOOL_COLORS as readonly string[]).includes(color) ? color : null;
}

/** 这只羊现在的颜色;读不到返回 null。 */
export function readSheepColor(bot: FactBot, entity: FactEntity): string | null {
  const raw = metaOf(bot, entity, 'wool');
  if (typeof raw !== 'number') return null;
  return WOOL_COLORS[raw & 0x0f] ?? null;
}
