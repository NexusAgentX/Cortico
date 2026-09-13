/**
 * 原始 cmd → 归一化产物。三种去向,对应投递分档:
 *
 * - `event`:成一条即时事件,自带 trigger(flush / debounce)。
 * - `count` / `gauge`:只进聚合读数,由 World 按 `piggyback` + 投递成文一起带出。
 *   计数是"这段时间发生了几次",读数是"现在是多少"——后者只留最新值。
 * - `null`:不推。运营挂件、连麦玩法、她自己的语音转写这类,与她的世界无关。
 *
 * 这一层不碰网络也不碰 host,纯函数,便于按真实 jsonl 回归。
 */
import type { TriggerMode } from '../../core/types.ts';
import { giftFrameData } from './gift-frame.ts';

export interface LiveEvent {
  kind: 'event';
  /** 事件词表 type */
  type: string;
  trigger: TriggerMode;
  text: string;
  senderKey?: string;
  meta?: Record<string, unknown>;
  coalesce?: LiveEventCoalescing;
}

type LiveEventCoalescing =
  | { kind: 'danmaku'; key: string; body: string }
  /** `yuan: null` = 这一笔的金额读不出来(见 SEND_GIFT 分支),合并正文里不写 ¥ */
  | { kind: 'gift'; key: string; gift: string; num: number; yuan: number | null };

/** 期间累加的次数 */
export type CountField = 'enter' | 'like' | 'freeGift';
/** 当前值,只留最新 */
export type GaugeField = 'watched' | 'online' | 'popularity' | 'fans' | 'likeTotal';

interface LiveCount {
  kind: 'count';
  field: CountField;
  by: number;
}

interface LiveGauge {
  kind: 'gauge';
  field: GaugeField;
  value: number;
}

export type Normalized = LiveEvent | LiveCount | LiveGauge;

/** 1 元 = 1000 金瓜子 */
const COIN_PER_YUAN = 1000;

/** 明确不推的 cmd:列出来是为了让"没见过的 cmd"能在控制台里被认出来 */
const IGNORED = new Set([
  'COMBO_SEND',
  'COMBO_END',
  'NOTICE_MSG',
  'SYS_MSG',
  'WIDGET_BANNER',
  'RECOMMEND_CARD',
  'GOTO_BUY_FLOW',
  'STOP_LIVE_ROOM_LIST',
  'HOT_ROOM_NOTIFY',
  'POPULAR_RANK_CHANGED',
  'ONLINE_RANK_V3',
  'ONLINE_RANK_TOP3',
  'UNIVERSAL_ASR_TEXT',
  'DM_INTERACTION',
  'LOG_IN_NOTICE',
  'ENTRY_EFFECT_MUST_RECEIVE',
]);

export interface NormalizeOptions {
  /** 礼物提到 flush 的门槛(元) */
  giftFlushYuan: number;
  /** 换算越界等「宁缺毋假」场合的告警口;纯函数不落日志,由调用方接 host.log.warn */
  warn?: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * GUARD_BUY 金额的合理区间（元）。data.price 的单位尚未实证，换算结果超出区间时省略金额；单位需以真实原帧和平台逐笔金额核对。
 */
const GUARD_YUAN_MIN = 1;
const GUARD_YUAN_MAX = 30000;

export function normalize(msg: Record<string, unknown>, opts: NormalizeOptions): Normalized | null {
  // DANMU_MSG:4:0:2:2:2:0 这种带后缀,取冒号前那截
  const cmd = String(msg.cmd ?? '').split(':')[0];
  if (IGNORED.has(cmd)) return null;
  const data = obj(msg.data);

  switch (cmd) {
    case 'DANMU_MSG':
    case 'DANMU_MSG_MIRROR':
      return danmaku(msg);

    case 'SUPER_CHAT_MESSAGE': {
      const user = obj(data.user_info);
      const uid = audienceUid(data);
      const uname = str(user.uname) || '某位观众';
      const yuan = num(data.price);
      return {
        kind: 'event',
        type: 'bilibili.superchat',
        trigger: 'flush',
        text: `[醒目留言 ¥${yuan}|${uname}] ${str(data.message)}`,
        senderKey: senderKeyOf(uid),
        meta: {
          uid,
          uname,
          yuan,
          messageId: data.id,
          avatarUrl: imageUrl(user.face),
          guardLevel: num(user.guard_level),
          isAdmin: bool(user.manager),
        },
      };
    }

    case 'SUPER_CHAT_MESSAGE_DELETE':
      return {
        kind: 'event',
        type: 'bilibili.superchat-del',
        trigger: 'piggyback',
        text: '[醒目留言被删除]',
        meta: { ids: data.ids },
      };

    case 'GUARD_BUY': {
      const uid = audienceUid(data);
      const uname = str(data.username) || '某位观众';
      const gift = str(data.gift_name) || '大航海';
      const n = num(data.num) || 1;
      // 对照 SUPER_CHAT 分支:price 是本代码库已知的字段名,这里只是历史上漏读。
      // 先按金瓜子口径 /1000 换算;单位未实证,越界即不填(见 GUARD_YUAN_MIN 注释)。
      const price = num(data.price);
      const yuan = price / COIN_PER_YUAN;
      const yuanKnown = price > 0 && yuan >= GUARD_YUAN_MIN && yuan <= GUARD_YUAN_MAX;
      if (price > 0 && !yuanKnown) {
        opts.warn?.('GUARD_BUY price 换算越界,金额不入账', { price, yuan });
      }
      const guardLevel = num(data.guard_level);
      return {
        kind: 'event',
        type: 'bilibili.guard',
        trigger: 'flush',
        text: yuanKnown
          ? `[上舰 ¥${trim(yuan)}|${uname}] 开通了 ${gift}×${n}`
          : `[上舰|${uname}] 开通了 ${gift}×${n}`,
        senderKey: senderKeyOf(uid),
        meta: {
          uid,
          uname,
          gift,
          num: n,
          ...(yuanKnown ? { yuan } : {}),
          ...(guardLevel > 0 ? { guardLevel } : {}),
        },
      };
    }

    // V1/V2 按各自已知字段布局读取；缺失时省略，不使用角色或等级兜底值。仅在帧明确写明续费时断言续费。
    case 'USER_TOAST_MSG': {
      const sender = obj(data.sender_uinfo);
      const base = obj(sender.base);
      const uid = audienceUid(data);
      const uname = str(data.username) || str(base.name) || '某位观众';
      const role = str(data.role_name);
      const guardLevel = num(data.guard_level) || num(sender.guard_level);
      const renew = str(data.toast_msg).includes('续费');
      return guardToast({ uid, uname, role, guardLevel, renew, face: base.face });
    }

    case 'USER_TOAST_MSG_V2': {
      // V2 把 V1 的顶层字段拆进 sender_uinfo / guard_info，顶层同名字段不再下发。
      const sender = obj(data.sender_uinfo);
      const base = obj(sender.base);
      const guard = obj(data.guard_info);
      const uid = audienceUid(data);
      const uname = str(base.name) || '某位观众';
      const role = str(guard.role_name);
      const guardLevel = num(guard.guard_level);
      const renew = str(data.toast_msg).includes('续费');
      return guardToast({ uid, uname, role, guardLevel, renew, face: base.face });
    }

    case 'SEND_GIFT':
    case 'SEND_GIFT_V2': {
      // V2 的字段全在 data.pb 的 protobuf 里,先摆回 V1 的名字(见 gift-frame.ts)
      const frame = giftFrameData(data, opts.warn);
      const sender = obj(frame.sender_uinfo);
      const base = obj(sender.base);
      const uid = audienceUid(frame);
      const uname = str(frame.uname) || str(base.name) || '某位观众';
      const gift = str(frame.giftName) || str(frame.gift_name) || '礼物';
      const n = num(frame.num) || 1;
      const coinType = str(frame.coin_type);
      // 明确读到银瓜子类型时才计入免费礼物聚合。coin_type 读取失败仍生成事件并告警，不能按非 gold 值将未知金额归为免费。
      if (coinType && coinType !== 'gold') return { kind: 'count', field: 'freeGift', by: n };
      const totalCoin = num(frame.total_coin);
      // 金额读不出就整项省略,正文也不写 ¥(与 GUARD_BUY 的 yuanKnown 同一口径)
      const yuanKnown = coinType === 'gold' && totalCoin > 0;
      const yuan = totalCoin / COIN_PER_YUAN;
      if (!yuanKnown) {
        opts.warn?.('礼物帧读不出金额,按未知金额成事件', { cmd, gift, uname, coinType });
      }
      const guardLevel = num(frame.guard_level);
      const tid = str(frame.tid);
      return {
        kind: 'event',
        type: 'bilibili.gift',
        // 金额未知时不插队:插队是给"确实是大额"留的,拿读不出来的东西打断她
        // 只会把一次读失败放大成一次打断。照样成事件,下一批就到。
        trigger: yuanKnown && yuan >= opts.giftFlushYuan ? 'flush' : 'debounce',
        text: yuanKnown
          ? `[礼物 ¥${trim(yuan)}|${uname}] ${gift}×${n}`
          : `[礼物|${uname}] ${gift}×${n}`,
        senderKey: senderKeyOf(uid),
        meta: {
          uid,
          uname,
          gift,
          num: n,
          ...(yuanKnown ? { yuan } : {}),
          avatarUrl: imageUrl(base.face),
          guardLevel,
          isAdmin: bool(frame.is_admin),
          ...(tid ? { tid } : {}),
        },
        coalesce: {
          kind: 'gift',
          // 金额未知的与已知的不并成一条:并了就没法说清这笔总额是多少
          key: JSON.stringify([gift, yuanKnown ? unitCoinKey(totalCoin, n) : '金额未知']),
          gift,
          num: n,
          yuan: yuanKnown ? yuan : null,
        },
      };
    }

    case 'ENTRY_EFFECT': {
      // 舰长进场特效。copy_writing 形如 "欢迎舰长 <%昵称%> 进入直播间"
      const line = str(data.copy_writing).replace(/<%|%>/g, '').trim();
      if (!line) return null;
      return {
        kind: 'event',
        type: 'bilibili.enter-guard',
        trigger: 'debounce',
        text: `[进场] ${line}`,
        senderKey: senderKeyOf(audienceUid(data)),
        meta: { uid: audienceUid(data) },
      };
    }

    case 'INTERACT_WORD':
    case 'INTERACT_WORD_V2':
      // V2 是 protobuf,分不出进场/关注/分享,一律按进场计数
      return { kind: 'count', field: 'enter', by: 1 };

    case 'LIKE_INFO_V3_CLICK':
      return { kind: 'count', field: 'like', by: 1 };

    case 'LIKE_INFO_V3_UPDATE':
      return { kind: 'gauge', field: 'likeTotal', value: num(data.click_count) };

    case 'WATCHED_CHANGE':
      return { kind: 'gauge', field: 'watched', value: num(data.num) };

    case 'ONLINE_RANK_COUNT':
      return { kind: 'gauge', field: 'online', value: num(data.count) };

    case 'POPULARITY_CHANGE':
      return { kind: 'gauge', field: 'popularity', value: num(data.popularity) };

    case 'ROOM_REAL_TIME_MESSAGE_UPDATE':
      return { kind: 'gauge', field: 'fans', value: num(data.fans) };

    // LIVE/PREPARING 明确陈述平台状态及其后果，区分直播状态与留场聊天；不添加行为指令。
    case 'LIVE':
      return {
        kind: 'event',
        type: 'bilibili.room',
        trigger: 'flush',
        text: '[直播间] 平台已推送开播指令:直播画面已对观众可见',
      };

    case 'PREPARING':
      return {
        kind: 'event',
        type: 'bilibili.room',
        trigger: 'flush',
        text: '[直播间] 平台已推送下播指令:直播已结束,观众已经看不到直播画面;'
          + '此后的弹幕来自仍留在房间页的人,不代表直播还在进行',
      };

    case 'ROOM_CHANGE':
      return {
        kind: 'event',
        type: 'bilibili.room',
        trigger: 'debounce',
        text: `[直播间] 标题/分区变更为「${str(data.title)}」(${str(data.area_name)})`,
        meta: { title: data.title, area: data.area_name },
      };

    case 'ROOM_SILENT_ON':
      return { kind: 'event', type: 'bilibili.room', trigger: 'flush', text: '[直播间] 已开启全员禁言' };

    case 'ROOM_SILENT_OFF':
      return { kind: 'event', type: 'bilibili.room', trigger: 'flush', text: '[直播间] 已关闭全员禁言' };

    case 'ROOM_BLOCK_MSG': {
      const uname = str(data.uname) || str(msg.uname) || '某位观众';
      return {
        kind: 'event',
        type: 'bilibili.block',
        trigger: 'debounce',
        text: `[房管] ${uname} 被禁言`,
        meta: { uname },
      };
    }

    case 'WARNING':
      return {
        kind: 'event',
        type: 'bilibili.warning',
        trigger: 'flush',
        text: `[平台警告] ${str(msg.msg) || '直播间收到一条超管警告'}`,
      };

    case 'CUT_OFF':
      return {
        kind: 'event',
        type: 'bilibili.warning',
        trigger: 'flush',
        text: `[直播被切断] ${str(msg.msg) || '直播已被平台切断'}`,
      };

    default:
      return null;
  }
}

/**
 * 弹幕的字段位置(实测):正文 `info[1]`,发言人 `info[2][0..1]`,
 * 粉丝牌 `info[3]`(等级、名字),大航海等级 `info[7]`。
 * 匿名连接下服务端会把 uid 抹成 0 并给昵称打码,此时没有稳定的人身份键。
 */
function danmaku(msg: Record<string, unknown>): LiveEvent | null {
  const info = Array.isArray(msg.info) ? (msg.info as unknown[]) : null;
  if (!info) return null;
  const text = str(info[1]).trim();
  if (!text) return null;
  const sender = Array.isArray(info[2]) ? (info[2] as unknown[]) : [];
  const uid = num(sender[0]);
  const uname = str(sender[1]) || '某位观众';
  const medal = Array.isArray(info[3]) ? (info[3] as unknown[]) : [];
  const userLevel = Array.isArray(info[4]) ? (info[4] as unknown[]) : [];
  const rich = obj(Array.isArray(info[0]) ? (info[0] as unknown[])[15] : undefined);
  const richUser = obj(rich.user);
  const richBase = obj(richUser.base);
  const guardLevel = num(info[7]);
  const badge = guardLevel > 0 ? '·舰长' : '';
  return {
    kind: 'event',
    type: 'bilibili.danmaku',
    trigger: 'debounce',
    text: `[弹幕|${uname}${badge}] ${text}`,
    senderKey: senderKeyOf(uid),
    meta: {
      uid,
      uname,
      guardLevel,
      isAdmin: bool(sender[2]),
      vip: bool(sender[3]),
      svip: bool(sender[4]),
      rank: num(sender[5]),
      nameColor: str(sender[7]),
      userLevel: num(userLevel[0]),
      avatarUrl: imageUrl(richBase.face),
      medal: medal.length
        ? {
            level: num(medal[0]),
            name: str(medal[1]),
            anchorName: str(medal[2]),
            roomId: num(medal[3]),
            color: num(medal[4]),
          }
        : null,
      body: text,
    },
    coalesce: { kind: 'danmaku', key: text, body: text },
  };
}

/**
 * 大航海 TOAST 的成品事件。字段读取按 V1/V2 各自的 case 做,这里只负责组装:
 * `role`/`guardLevel` 读不到就整项省略;`renew` 只有帧里明说续费才为 true,
 * 判不了就用中性措辞——没有证据不断言续费。
 */
function guardToast(fields: {
  uid: number;
  uname: string;
  role: string;
  guardLevel: number;
  renew: boolean;
  face: unknown;
}): LiveEvent {
  const { uid, uname, role, guardLevel, renew } = fields;
  const roleText = role || '大航海';
  return {
    kind: 'event',
    type: 'bilibili.guard-renew',
    trigger: 'debounce',
    text: renew ? `[续费|${uname}] 续费了 ${roleText}` : `[上舰|${uname}] 上了 ${roleText}`,
    senderKey: senderKeyOf(uid),
    meta: {
      uid,
      uname,
      ...(role ? { role } : {}),
      ...(guardLevel > 0 ? { guardLevel } : {}),
      ...(renew ? { renew: true } : {}),
      avatarUrl: imageUrl(fields.face),
    },
  };
}

/** uid 为 0 = 服务端脱敏,没有可用的身份键;宁可缺这一项,也不要拿打码昵称冒充稳定键 */
function senderKeyOf(uid: number): string | undefined {
  return uid > 0 ? String(uid) : undefined;
}

/** 付费事件的 uid 在不同 cmd 版本中所处层级不同。 */
function audienceUid(data: Record<string, unknown>): number {
  const values = [
    num(data.uid),
    num(obj(data.user_info).uid),
    num(obj(data.sender_uinfo).uid),
  ];
  return values.find((value) => value > 0) ?? 0;
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function bool(v: unknown): boolean {
  return v === true || v === 1;
}

function imageUrl(v: unknown): string {
  const raw = str(v);
  if (raw.startsWith('//')) return `https:${raw}`;
  return /^https?:\/\//i.test(raw) ? raw : '';
}

function unitCoinKey(totalCoin: number, count: number): string {
  let a = Math.abs(Math.round(totalCoin));
  let b = Math.abs(Math.round(count));
  const numerator = Math.round(totalCoin);
  const denominator = Math.round(count);
  while (b !== 0) [a, b] = [b, a % b];
  const divisor = a || 1;
  return `${numerator / divisor}/${denominator / divisor}`;
}

/** ¥ 显示:整数不带小数点,小数留两位 */
function trim(yuan: number): string {
  return Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2);
}
