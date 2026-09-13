/**
 * 同 id 的几件里点名哪一件:挑选词。
 *
 * 物品 id 说不全一件东西是什么。五本 `enchanted_book` 在工具口长得一模一样,而她在
 * 清单里读到的是「附魔书（无限I·抢夺II）」——分辨所需的字一直都印着,缺的只是把它
 * 写回工具口的路。挑选词就是那个括号里的字:拿她读到的那份渲染做子串匹配,英文附魔
 * id 与阿拉伯数字等级一并认。
 *
 * **按内容匹配,不按位置**。位置序号在多步之间会前移:「五本存四本」拆成四步,第一步
 * 存完之后剩下几件的序号已经不是她读到的那几个,而串位是静默的。挑选词落空则当场受阻。
 *
 * 挑选词是**筛子不是指针**:命中几件就是几件,动几件由 count 决定。
 */
import { roman, zhEnchant, zhName } from './names.ts';
import { readEnchants, type EnchantRegistry, type ItemEnchant, type ItemLike } from './item-facts.ts';
import { enchantSuffix } from './terrain.ts';

/** 匹配只认这两样;她读到的那份渲染全由它们拼出来 */
export interface PickTarget {
  name: string;
  enchantments?: readonly ItemEnchant[];
}

/** 清单里那一条的完整标签:「附魔书（无限I·抢夺II）」 */
export function pickLabel(it: PickTarget): string {
  return `${zhName(it.name)}${enchantSuffix(it.enchantments)}`;
}

/** 服务端发来的那件东西转成匹配用的形状 */
export function pickTargetOf(item: ItemLike, registry?: EnchantRegistry | null): PickTarget {
  return { name: item.name, enchantments: readEnchants(item, registry) };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

/** 一件东西上挑选词够得着的全部字面 */
function facets(it: PickTarget): string[] {
  const out = [zhName(it.name), it.name, pickLabel(it)];
  for (const e of it.enchantments ?? []) {
    const zh = zhEnchant(e.name);
    out.push(zh, `${zh}${roman(e.level)}`, `${zh}${e.level}`, e.name, `${e.name}${e.level}`);
  }
  return out;
}

/** 这件东西是不是她点的那一件。空挑选词 = 没挑,一律不筛 */
export function matchesPick(pick: string | undefined, it: PickTarget): boolean {
  if (!pick) return true;
  const q = normalize(pick);
  return q.length > 0 && facets(it).some((f) => normalize(f).includes(q));
}

/** 服务端物品直接过筛;附魔要现读,所以要 registry */
export function itemMatchesPick(
  pick: string | undefined,
  item: ItemLike,
  registry?: EnchantRegistry | null,
): boolean {
  return pick ? matchesPick(pick, pickTargetOf(item, registry)) : true;
}

/** 一件东西身上用来分辨的那几个字;没附魔的说「没有附魔」 */
function pickFacts(it: PickTarget): string {
  return enchantSuffix(it.enchantments).replace(/[（）]/g, '') || '没有附魔';
}

/**
 * 挑选词一件都没命中时的原话:同 id 的那几件各自是什么,原样摆出来。
 * 她下一步要么改挑选词要么改主意,两条都需要这份清单。
 */
export function pickMissText(
  where: string,
  id: string,
  pick: string,
  sameId: readonly PickTarget[],
): string {
  return `${where}有 ${sameId.length} 件${zhName(id)},没有一件带「${pick}」:`
    + `${sameId.map(pickFacts).join(' / ')}`;
}

/** 回执里点名挑中的是哪几件;同样的标签只说一遍 */
export function pickedText(picked: readonly PickTarget[]): string {
  return [...new Set(picked.map(pickLabel))].join('、');
}
