/**
 * `SEND_GIFT_V2` 的 protobuf 帧 → V1 的 JSON 字段形状。
 *
 * 此层将 protobuf 字段映射到 V1 的 JSON 名称，使 normalize、overlay/project 共用处理路径，并支持 V1/V2 共存及帧回放。
 *
 * 字段号依据实采帧推断，未有官方 schema；映射如下：
 *
 * ```
 * 顶层
 *    1  uid          送礼人
 *    2  uname
 *    3  face         头像 URL
 *    8  medal        粉丝牌:5=等级 6=牌名。**可能是别的房间的牌子**
 *   10  gift         礼物体,见下
 *   15  sender       送礼人完整档案(1=uid,2={1=名字,2=头像})
 * 礼物体(顶层 10)
 *    1  giftId    2 giftName   3 num   4 giftType(动画礼物=2)
 *  5/6/7 金瓜子三槽,见 coinTotal
 *    8  coin_type("gold"=付费,"silver"=免费)
 *    9  tid(这一笔的交易号,V1 同名字段同形)
 *   12  combo_id  14 连击累计金瓜子(100/200/400/600 这样递增,**不是单笔**)
 *   18  动作词("投喂")
 * ```
 *
 * 以下字段不填：
 *
 * - `guard_level`:粉丝牌里那个档位(medal.12)是**牌子所属房间**的舰长等级,
 *   不能作为本房间的舰长等级。
 * - `is_admin`:pb 里没有对得上的字段,宁可不显示房管标记。
 */
import { pbFromBase64, pbInt, pbSub, pbText, type PbField } from './protobuf.ts';

/** 告警口。纯函数不落日志,由调用方接 host.log.warn。 */
type GiftFrameWarn = (message: string, data?: Record<string, unknown>) => void;

/**
 * 送礼帧的 `data`。V1 原样返回;V2 返回补齐 V1 字段名的副本;两种都读不出
 * 就原样返回,让下游按"读不出来"处理(它会成事件 + 告警,而不是悄悄记成免费)。
 */
export function giftFrameData(
  data: Record<string, unknown>,
  warn?: GiftFrameWarn,
): Record<string, unknown> {
  // V1 字段还在就走 V1。迁移期双发、平台回滚、历史 jsonl 回放都靠这一行。
  if (text(data.giftName) || text(data.gift_name)) return data;
  const top = pbFromBase64(data.pb);
  const gift = pbSub(top, 10);
  const giftName = pbText(gift, 2);
  if (!gift || !giftName) {
    // pb 不在、解不动、或者解出来找不到礼物体:布局又变了。半份数据不端出去。
    if (data.pb !== undefined) {
      warn?.('SEND_GIFT_V2 的 pb 读不出礼物名,按读不出处理', {
        decoded: top !== null,
        giftBody: gift !== null,
      });
    }
    return data;
  }
  const sender = pbSub(top, 15);
  const senderBase = pbSub(sender, 2);
  const uid = pbInt(top, 1) ?? pbInt(sender, 1);
  const uname = pbText(top, 2) || pbText(senderBase, 1);
  const face = pbText(top, 3) || pbText(senderBase, 2);
  const num = pbInt(gift, 3);
  const coinType = pbText(gift, 8);
  const totalCoin = coinTotal(gift, num, giftName, warn);
  const giftId = pbInt(gift, 1);
  const tid = pbText(gift, 9);
  return {
    ...data,
    ...(uid !== undefined ? { uid } : {}),
    ...(uname ? { uname } : {}),
    giftName,
    ...(giftId !== undefined ? { giftId } : {}),
    ...(num !== undefined ? { num } : {}),
    ...(coinType ? { coin_type: coinType } : {}),
    ...(totalCoin !== undefined ? { total_coin: totalCoin } : {}),
    ...(tid ? { tid } : {}),
    sender_uinfo: senderUinfo(top, uid, uname, face),
  };
}

function senderUinfo(
  top: readonly PbField[] | null,
  uid: number | undefined,
  uname: string,
  face: string,
): Record<string, unknown> {
  const medal = pbSub(top, 8);
  const medalLevel = pbInt(medal, 5);
  const medalName = pbText(medal, 6);
  const hasMedal = medalLevel !== undefined || medalName !== '';
  return {
    ...(uid !== undefined ? { uid } : {}),
    base: {
      ...(uname ? { name: uname } : {}),
      ...(face ? { face } : {}),
    },
    ...(hasMedal
      ? {
          medal: {
            ...(medalLevel !== undefined ? { level: medalLevel } : {}),
            ...(medalName ? { name: medalName } : {}),
          },
        }
      : {}),
  };
}

/**
 * 这一笔花掉的金瓜子。
 *
 * 5 / 6 / 7 三槽在现有真帧里恒等(24 帧全是 num=1),谁是 total_coin、谁是
 * price、谁是 discount_price 分不出来。取三者最大值:按 B 站口径
 * `total_coin = price × num ≥ price ≥ discount_price`,num=1 时三者相等,
 * num>1 时最大的那个才是真花的钱——所以最大值在两种情形下都不会少记。
 *
 * 只要偏离"num=1 且三槽恒等"这个已验证的常态就 warn 一条:那正是能把槽位
 * 钉死的帧。看见告警就去 `bilibili-raw-samples.jsonl` 捞这一帧(采样器对读不出
 * 名字与三槽不一致的帧都会留样),按真值把这里改成定死的字段号。
 */
function coinTotal(
  gift: readonly PbField[],
  num: number | undefined,
  giftName: string,
  warn?: GiftFrameWarn,
): number | undefined {
  const slots = [5, 6, 7]
    .map((field) => pbInt(gift, field))
    .filter((value): value is number => value !== undefined && value > 0);
  if (slots.length === 0) return undefined;
  const total = Math.max(...slots);
  const settled = slots.every((value) => value === total) && (num ?? 1) === 1;
  if (!settled) {
    warn?.('SEND_GIFT_V2 金瓜子槽位还没定死,按最大值入账', { gift: giftName, slots, num });
  }
  return total;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
