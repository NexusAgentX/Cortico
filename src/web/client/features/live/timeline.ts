/**
 * 时间线 —— 把 session 的 Item 流画成一列"组"。
 *
 * 版式是 `styles.css` 里 `.grp` / `.turn` / `.think` / `.monolog` / `.toolcall` /
 * `.world` 那一整套字面,这里用 `ui.h` 拼既有 class,不发明新皮。
 *
 * 数据是标准 Open Responses Item(`ContextRecord`)。这一页是**实际组装进上下文的
 * 内容**的便利可视化,不是语义化的转述:标签写的就是 role 与工具名。画法按来源分
 * 左右,同一种组结构(头像栏 + 组头 + 内容列)镜像使用:
 *
 * | Item                          | 画成                                             |
 * | ----------------------------- | ------------------------------------------------ |
 * | system / developer message    | 全宽可折叠的系统前缀条(`.syscard`)                |
 * | user message                  | 靠右的 USER 组:一只气泡,一行一条(`.world`)        |
 * | reasoning / assistant message / function_call | 同一 Response 合成一个靠左的 ASSISTANT 组(`.turn`),头像在左栏,卡内按 Item 顺序排;合成的 external_event_frame 调用也在这里,只多一只「合成」框与稀虚线 |
 * | function_call_output          | 按 `call_id` 填回原调用的回执槽;对不上号才单独成卡 |
 * | compaction / item_reference   | 独立卡(`.standalone`)                             |
 *
 * 一个 `.turn` 组对应一段**连续**的同 `responseId` Item;没有 responseId 的连续
 * assistant 侧 Item 也合成一组。夹在中间的回执或输入会结束这一段。组头的
 * 「原始 Item」展开这一段的标准 Item 原文(含 phase / status / 加密载荷),所以
 * 正文里不重复印这些元数据,只按字面报长度(明文按字、加密载荷按字符)。
 *
 * 序号 `#n` 是这条 Item 在 session 记录里的位置(`session.append` 用的 index)。
 * 合成首轮(出线态注入,不落盘)没有序号,用前后两道分隔线标出。
 *
 * 生命周期:打字机走 `lifecycle.frame`(重画即停);滚动粘滞用 `shouldStick`;
 * 监听全带 signal;没有 innerHTML。
 */

import type { ConsoleUi, Disposable } from '../../../shared/client-panel.ts';
import type { Lifecycle } from '../../core/lifecycle.ts';
import { shouldStick } from '../../ui/index.ts';
import { estTok } from './context.ts';
import { S } from './strings.ts';
import type { ContextRecord, Item } from '../../../../protocol/open-responses/context.ts';

/** 距底部在此像素阈值以内时保持尾部粘滞。 */
const STICK_PX = 60;
/** 超过这个长度的正文折起来,折叠行只印字数。 */
const FOLD_CHARS = 500;
/** 打字机每帧推进的字数。 */
const TYPE_CHARS_PER_FRAME = 8;
/** 事件投递帧的工具名(与 core/loop.ts 的 EXTERNAL_EVENT_FRAME 同名;那边不对浏览器包导出)。 */
const EXTERNAL_EVENT_FRAME = 'external_event_frame';
/** bot 头像。不带缓存破坏参数:一条时间线上几十个组共用同一份缓存。 */
const AVATAR_URL = '/api/avatar';

/** 加/去一个 class,不碰 `classList`——那是本仓 DOM 桩不实现的一层。 */
function toggleClass(el: HTMLElement, cls: string, on: boolean): void {
  const set = new Set(el.className.split(' ').filter((s) => s !== ''));
  if (on) set.add(cls);
  else set.delete(cls);
  el.className = [...set].join(' ');
}

type MessageItem = Extract<Item, { type: 'message' }>;
type ReasoningItem = Extract<Item, { type: 'reasoning' }>;
type CallItem = Extract<Item, { type: 'function_call' }>;
type OutputItem = Extract<Item, { type: 'function_call_output' }>;

/** 内容数组的可读投影:文本原样,其余部件只留类型标记。 */
function partsText(content: MessageItem['content'] | OutputItem['output']): string {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    const p = part as { type?: string; text?: string; refusal?: string };
    if (typeof p.text === 'string') return p.text;
    if (typeof p.refusal === 'string') return p.refusal;
    return `[${p.type ?? 'part'}]`;
  }).join('\n');
}

function isAssistantSide(item: Item): boolean {
  return item.type === 'reasoning' || item.type === 'function_call'
    || (item.type === 'message' && item.role === 'assistant');
}

function isPrefix(item: Item): boolean {
  return item.type === 'message' && (item.role === 'system' || item.role === 'developer');
}

function isEventFrame(item: Item): boolean {
  return item.type === 'function_call' && item.name === EXTERNAL_EVENT_FRAME;
}

interface Turn {
  responseId: string;
  grp: HTMLElement;
  body: HTMLElement;
  status: HTMLElement;
  entries: ContextRecord[];
}

/** 合成首轮的 Item 没有 session 序号。 */
type Ordinal = number | null;

export interface TimelineDeps {
  ui: ConsoleUi;
  lifecycle: Lifecycle;
  signal: AbortSignal;
}

export interface TimelineView {
  /** 整块(滚动区 + 思考条 + 回到底部),调用方 append 到自己的根里 */
  el: HTMLElement;
  /**
   * 整份重画。`note` 是顶上一条分隔说明,`banner` 是置顶横幅(fork 视图用)。
   *
   * `keepScroll` 给轮询用:用户正往上翻历史时,一次例行重画不该把他弹回底部。
   */
  rebuild(
    messages: readonly ContextRecord[],
    opts?: {
      note?: string | null;
      banner?: HTMLElement | null;
      empty?: string;
      keepScroll?: boolean;
      /**
       * 合成首轮对话(出线态注入,不落盘)。与 session 里的 Item 画法相同,前后各一道
       * 分隔线,插在开头的 system 卡之后——与实际请求体里的位置一致。空数组/不传=不画。
       */
      firstTurn?: readonly ContextRecord[] | null;
    },
  ): void;
  /** 追加一条(实时帧)。`live` 决定要不要动画与打字机。 */
  append(m: ContextRecord, index: number, live: boolean): void;
  /** 说话人展示名。头像图片加载不到时,ASSISTANT 组左栏的占位圆里印它的首字;下一次画到组时生效。 */
  setSpeaker(name: string): void;
}

export function createTimeline(deps: TimelineDeps): TimelineView {
  const { ui, lifecycle, signal } = deps;

  const el = ui.h('div', 'tlwrap');
  const scroll = ui.h('div', 'tlscroll');
  const inner = ui.h('div', 'tlinner');
  scroll.appendChild(inner);
  const think = ui.h('div', 'tlthink hidden');
  think.append(ui.h('span', 'pulse'), ui.h('span', null, S.thinking));
  const jump = ui.button(S.jumpBottom, {
    size: 'sm',
    onClick: () => {
      autoScroll = true;
      stick(true);
    },
  });
  jump.className = 'btn sm tljump hidden';
  el.append(scroll, think, jump);

  /** call_id → 那颗卡上等结果的槽位。每次重画清空。 */
  const toolCalls = new Map<string, HTMLElement>();
  /** 正在往里添 Item 的那个 ASSISTANT 组。任何非 assistant 侧的 Item 都会结束它。 */
  let turn: Turn | null = null;
  /** 头像占位圆里的字。 */
  let speakerInitial = 'B';
  let autoScroll = true;
  /** 正在跑的打字机。重画时全部收掉——否则它们会往脱离文档的节点里继续写。 */
  const typing = new Set<Disposable>();

  const stick = (force?: boolean): void => {
    if (autoScroll || force) scroll.scrollTop = scroll.scrollHeight;
  };

  scroll.addEventListener(
    'scroll',
    () => {
      autoScroll = shouldStick(scroll.scrollTop, scroll.scrollHeight, scroll.clientHeight, STICK_PX);
      toggleClass(jump, 'hidden', autoScroll);
    },
    { signal },
  );

  const stopTyping = (): void => {
    for (const t of [...typing]) t.dispose();
    typing.clear();
  };

  /**
   * 打字机。点一下立即写完(长思考不必等)。
   *
   * `frame` 返回的句柄同时登记在 `lifecycle` 上,所以三条退出路径——写完、用户点、
   * 页面离开——最终都收在同一个地方。
   */
  const typewriter = (target: HTMLElement, text: string): void => {
    toggleClass(target, 'typing', true);
    let i = 0;
    let handle: Disposable | null = null;
    const finish = (): void => {
      target.textContent = text;
      toggleClass(target, 'typing', false);
      if (handle) {
        typing.delete(handle);
        handle.dispose();
        handle = null;
      }
      stick();
    };
    handle = lifecycle.frame(() => {
      i += TYPE_CHARS_PER_FRAME;
      if (i >= text.length) {
        finish();
        return false;
      }
      target.textContent = text.slice(0, i);
      stick();
      return undefined;
    });
    typing.add(handle);
    target.addEventListener('click', finish, { signal });
  };

  // ── 小零件 ─────────────────────────────────────────────────────────

  /** 折叠容器(`.clps` 的两层:外层控高度,内层裁切)。 */
  const clps = (body: HTMLElement, open: boolean): HTMLElement => {
    const w = ui.h('div', open ? 'clps open' : 'clps');
    const b = ui.h('div');
    b.appendChild(body);
    w.appendChild(b);
    return w;
  };

  /** 点标题展开/收起,顺带翻转小箭头。 */
  const bindToggle = (head: HTMLElement, box: HTMLElement, chev?: HTMLElement | null): void => {
    head.addEventListener(
      'click',
      () => {
        const open = !box.className.split(' ').includes('open');
        toggleClass(box, 'open', open);
        if (chev) toggleClass(chev, 'up', open);
      },
      { signal },
    );
  };

  /** 短的直接铺,长的折起来,折叠行上只印字数。 */
  const foldedPre = (content: string): HTMLElement => {
    const box = ui.h('div');
    if ((content || '').length <= FOLD_CHARS) {
      box.appendChild(ui.h('pre', 'mono', content));
      return box;
    }
    const head = ui.h('div', 'foldhead', S.foldHead(false, content.length));
    const pre = ui.h('pre', 'mono', content);
    const wrap = clps(pre, false);
    head.addEventListener(
      'click',
      () => {
        const open = !wrap.className.split(' ').includes('open');
        toggleClass(wrap, 'open', open);
        head.textContent = S.foldHead(open, content.length);
      },
      { signal },
    );
    box.append(head, wrap);
    return box;
  };

  /** 每个画出来的块都带上它的 Item 身份,时间线上任何一块都能对回记录。 */
  const tag = (node: HTMLElement, entry: ContextRecord): HTMLElement => {
    node.setAttribute('data-item-type', entry.item.type ?? 'item_reference');
    node.setAttribute('data-item-id', entry.item.id ?? '');
    return node;
  };

  const prettyArgs = (raw: string): string => {
    try {
      return JSON.stringify(JSON.parse(raw || '{}'), null, 2);
    } catch {
      return raw; // 参数还在流式拼装中就可能不是合法 JSON;照原文显示
    }
  };

  /** 序号:这条 Item 在 session 记录里的位置。合成首轮没有序号,返回 null。 */
  const ordinal = (index: Ordinal): HTMLElement | null => {
    if (index === null) return null;
    const s = ui.h('span', 'meta ordinal', `#${index}`);
    s.title = S.ordinalTitle(index);
    return s;
  };

  /**
   * 键值框:键名用框的颜色,值用正文色。`value` 省略就是只有键名的标记框
   * (比如合成调用对上的「合成」)。class 带上键名,测试与样式都能按键找;
   * `label` 是印出来的键名,省略就印键本身。
   */
  const kv = (key: string, value?: string, label?: string): HTMLElement => {
    const box = ui.h('span', `kv kv-${key}`);
    box.appendChild(ui.h('span', 'kv-k', label ?? key));
    if (value !== undefined) box.appendChild(ui.h('span', 'kv-v', value));
    return box;
  };

  /** 组的左/右栏:头像(ASSISTANT)或一枚记号(USER / 合成调用对)。 */
  const gutterGlyph = (glyph: string, title: string): HTMLElement => {
    const box = ui.h('div', 'gutter');
    box.appendChild(ui.h('span', 'glyph', glyph));
    box.title = title;
    return box;
  };

  /** ASSISTANT 组左栏的头像:图片加载到就用图片,否则占位圆里印说话人首字。 */
  const avatar = (): HTMLElement => {
    const box = ui.h('div', 'gutter avatar');
    const image = ui.h('img', 'avatar-image hidden');
    image.alt = '';
    const fallback = ui.h('span', 'avatar-fallback', speakerInitial);
    image.addEventListener('load', () => {
      toggleClass(image, 'hidden', false);
      toggleClass(fallback, 'hidden', true);
    }, { signal });
    image.addEventListener('error', () => {
      toggleClass(image, 'hidden', true);
      toggleClass(fallback, 'hidden', false);
    }, { signal });
    image.src = AVATAR_URL;
    box.append(image, fallback);
    return box;
  };

  /**
   * 一个组:左栏 + 内容列(`right` 时镜像:内容列在前、右栏在后)。
   * 返回组与内容列,调用方往内容列里放组头与正文。
   */
  const group = (cls: string, gutter: HTMLElement, right: boolean): { grp: HTMLElement; col: HTMLElement } => {
    const grp = ui.h('div', right ? `${cls} grp r` : `${cls} grp`);
    const col = ui.h('div', right ? 'gcol r' : 'gcol');
    if (right) grp.append(col, gutter);
    else grp.append(gutter, col);
    return { grp, col };
  };

  // ── 每一种 Item ────────────────────────────────────────────────────

  const renderSystem = (entry: ContextRecord, live: boolean): HTMLElement => {
    const item = entry.item as MessageItem;
    const text = partsText(item.content);
    const card = tag(ui.h('div', live ? 'tcard syscard anim-in' : 'tcard syscard'), entry);
    const head = ui.h('div', 'cardhead');
    const chev = ui.h('span', 'chev', '▼');
    // 折叠时露正文第一行(CSS 截断),不写任何说明
    const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
    head.append(
      ui.h('span', 'badge', item.role.toUpperCase()),
      ui.h('span', 'headtxt', firstLine),
      ui.h('span', 'meta', `~${ui.fmt.count(estTok(text))} tok`),
      chev,
    );
    const box = clps(ui.h('pre', 'mono', text || S.empty), false);
    bindToggle(head, box, chev);
    card.append(head, box);
    return card;
  };

  /** user 消息＝内部系统文本(事件到达通知这类),靠右的 USER 组。 */
  const renderWorld = (entry: ContextRecord, index: Ordinal, live: boolean): HTMLElement => {
    const item = entry.item as MessageItem;
    const { grp, col } = group(
      live ? 'usergrp anim-in' : 'usergrp',
      gutterGlyph('>_', S.userGlyphTitle),
      true,
    );
    tag(grp, entry);
    const head = ui.h('div', 'ghead');
    const ord = ordinal(index);
    if (ord) head.appendChild(ord);
    head.appendChild(ui.h('span', 'badge', 'USER'));
    const world = ui.h('div', 'world');
    for (const line of partsText(item.content).split('\n')) {
      world.appendChild(ui.h('div', live ? 'world-line slide-in' : 'world-line', line));
    }
    col.append(head, world);
    return grp;
  };

  /**
   * 一条 reasoning Item 一个思考块。明文、摘要、加密载荷三样分别呈现:明文是正文,
   * 摘要另起一小节,加密载荷只在头上留一枚锁(它本来就读不出内容)。三样都没有的
   * 空 reasoning 不画。
   */
  const renderReasoning = (entry: ContextRecord, live: boolean): HTMLElement | null => {
    const item = entry.item as ReasoningItem;
    const text = (item.content ?? [])
      .map((part) => (part.type === 'reasoning_text' ? part.text : `[${part.type}]`)).join('\n\n');
    const summary = item.summary
      .map((part) => (part.type === 'summary_text' ? part.text : `[${part.type}]`)).join('\n\n');
    const body = text || summary;
    if (!body && item.encrypted_content == null) return null;
    // 头上按字面报长度:明文按字数,加密载荷按字符数(上下文记录里没有逐条 token 数)
    const block = tag(ui.h('div', 'think'), entry);
    const head = ui.h('div', 'think-head');
    if (body) head.appendChild(ui.h('span', 'think-label', S.visibleReasoning(body.length)));
    if (item.encrypted_content != null) {
      if (body) head.appendChild(ui.h('span', 'meta', '·'));
      head.appendChild(ui.h('span', 'think-label think-enc', S.encryptedReasoning(item.encrypted_content.length)));
    }
    if (!body) {
      block.appendChild(head);
      return block;
    }
    const chev = ui.h('span', 'chev up', '▼');
    head.appendChild(chev);
    const content = ui.h('div');
    const main = ui.h('div', 'think-body');
    content.appendChild(main);
    if (text && summary) {
      const sub = ui.h('div', 'think-sub');
      sub.append(ui.h('span', 'think-label', S.summary), ui.h('div', 'think-body', summary));
      content.appendChild(sub);
    }
    const box = clps(content, true);
    bindToggle(head, box, chev);
    block.append(head, box);
    if (live) typewriter(main, body);
    else main.textContent = body;
    return block;
  };

  /**
   * assistant 正文＝模型的直接输出,画成靠左的气泡。每个内容部件一个气泡;只有拒绝
   * 与非 final_answer 的 phase 才印小标签。它没有外送到任何出口,这点放 hover。
   */
  const renderMonolog = (entry: ContextRecord): HTMLElement[] => {
    const item = entry.item as MessageItem;
    const phase = 'phase' in item && typeof item.phase === 'string' ? item.phase : '';
    const parts = typeof item.content === 'string'
      ? [{ type: 'output_text', text: item.content }]
      : item.content;
    const out: HTMLElement[] = [];
    for (const part of parts) {
      const p = part as { type: string; text?: string; refusal?: string };
      const refusal = typeof p.refusal === 'string';
      const text = typeof p.text === 'string' ? p.text : refusal ? p.refusal! : '';
      if (!text.trim()) continue;
      const mono = tag(ui.h('div', refusal ? 'monolog refusal' : 'monolog'), entry);
      mono.title = S.monologTitle(phase);
      const label = refusal ? S.refusal : p.type !== 'output_text' ? p.type : phase && phase !== 'final_answer' ? phase : '';
      if (label) mono.appendChild(ui.h('div', 'monolog-label', label));
      mono.appendChild(ui.h('div', 'monolog-body', text));
      out.push(mono);
    }
    return out;
  };

  /** 工具卡:卡头是 tool_name / call_id 两只键值框(合成调用对再加一只「合成」),参数折叠,回执槽等结果。 */
  const toolCard = (entry: ContextRecord, cls: string, synthetic: boolean): HTMLElement => {
    const item = entry.item as CallItem;
    const card = tag(ui.h('div', cls), entry);
    const head = ui.h('div', 'toolhead');
    head.append(kv('tool_name', item.name || '?'), kv('call_id', item.call_id));
    // class 键钉死为「合成」(styles.css 的 `.kv-合成` 与测试都按它找),只有印出来的字随语言走
    if (synthetic) head.appendChild(kv('合成', undefined, S.synthetic));
    if (item.status && item.status !== 'completed') head.appendChild(ui.h('span', 'meta', item.status));
    const ab = ui.h('div', 'toolargs');
    ab.appendChild(foldedPre(prettyArgs(item.arguments)));
    const slot = ui.h('div', 'toolresult pending', '…');
    card.append(head, ab, slot);
    toolCalls.set(item.call_id, slot);
    return card;
  };

  /**
   * 事件投递帧(core 合成的一对 external_event_frame 调用/回执)与普通工具调用
   * 画在同一个 ASSISTANT 组里,只靠「合成」框与稀虚线识别。
   */
  const renderToolCall = (entry: ContextRecord, live: boolean): HTMLElement => {
    const synthetic = isEventFrame(entry.item);
    const cls = ['toolcall'];
    if (synthetic) cls.push('evframe');
    if (live) cls.push('anim-in');
    return toolCard(entry, cls.join(' '), synthetic);
  };

  /** 工具回执:能对上号就填回那颗卡的槽位(返回 null 表示不新建卡片)。 */
  const renderToolResult = (entry: ContextRecord, index: Ordinal, live: boolean): HTMLElement | null => {
    const item = entry.item as OutputItem;
    const text = partsText(item.output);
    const slot = toolCalls.get(item.call_id);
    if (slot) {
      toggleClass(slot, 'pending', false);
      slot.textContent = '';
      tag(slot, entry);
      slot.appendChild(foldedPre(text || S.empty));
      stick();
      return null;
    }
    const card = tag(ui.h('div', live ? 'tcard standalone anim-in' : 'tcard standalone'), entry);
    const head = ui.h('div', 'cardhead');
    head.append(ui.h('span', 'badge', 'function_call_output'), kv('call_id', item.call_id));
    const ord = ordinal(index);
    if (ord) head.appendChild(ord);
    card.append(head, foldedPre(text || S.empty));
    return card;
  };

  const renderOther = (entry: ContextRecord, index: Ordinal, live: boolean): HTMLElement => {
    const item = entry.item;
    const card = tag(ui.h('div', live ? 'tcard standalone anim-in' : 'tcard standalone'), entry);
    const head = ui.h('div', 'cardhead');
    head.appendChild(ui.h('span', 'badge', (item.type ?? 'item_reference').toUpperCase()));
    const ord = ordinal(index);
    if (ord) head.appendChild(ord);
    card.appendChild(head);
    if (item.type === 'compaction') {
      head.appendChild(ui.h('span', 'think-label think-enc', S.encryptedPayload(item.encrypted_content.length)));
    } else {
      card.appendChild(foldedPre(JSON.stringify(item, null, 2)));
    }
    return card;
  };

  /**
   * 同一 Response 的 assistant 侧 Item 共用一个组;没有 responseId 的连续 assistant
   * 侧 Item 也合成一组(合成首轮就是这样)。组头印 ASSISTANT、序号、状态(只在不是
   * completed 时)与一枚「原始 Item」开关——展开这一段的标准 Item 原文。
   */
  const ensureTurn = (entry: ContextRecord, index: Ordinal, live: boolean): Turn => {
    const responseId = entry.context.responseId ?? '';
    if (turn && turn.responseId === responseId) return turn;
    const { grp, col } = group(live ? 'tcard turn anim-in' : 'tcard turn', avatar(), false);
    if (responseId) grp.setAttribute('data-response-id', responseId);
    const head = ui.h('div', 'ghead turnhead');
    const status = ui.h('span', 'meta turnstatus');
    head.appendChild(ui.h('span', 'badge', 'ASSISTANT'));
    const ord = ordinal(index);
    if (ord) head.appendChild(ord);
    head.appendChild(status);
    head.appendChild(ui.h('span', 'grow'));
    const rawToggle = ui.h('span', 'meta rawtoggle', S.rawItems);
    rawToggle.setAttribute('role', 'button');
    head.appendChild(rawToggle);
    const body = ui.h('div', 'turnbody');
    const rawPre = ui.h('pre', 'mono');
    const rawBox = clps(rawPre, false);
    toggleClass(rawBox, 'turnraw', true);
    col.append(head, body, rawBox);
    const next: Turn = { responseId, grp, body, status, entries: [] };
    rawToggle.addEventListener('click', () => {
      const open = !rawBox.className.split(' ').includes('open');
      if (open) rawPre.textContent = JSON.stringify(next.entries.map((e) => e.item), null, 2);
      toggleClass(rawBox, 'open', open);
    }, { signal });
    inner.appendChild(grp);
    turn = next;
    return next;
  };

  const renderOne = (entry: ContextRecord, index: Ordinal, live: boolean): void => {
    const item = entry.item;
    if (isAssistantSide(item)) {
      if (live) hideThinking();
      const t = ensureTurn(entry, index, live);
      t.entries.push(entry);
      const status = entry.context.responseStatus;
      t.status.textContent = status && status !== 'completed' ? status : '';
      if (item.type === 'reasoning') {
        const block = renderReasoning(entry, live);
        if (block) t.body.appendChild(block);
      } else if (item.type === 'function_call') t.body.appendChild(renderToolCall(entry, live));
      else t.body.append(...renderMonolog(entry));
      // 一段里全是空 Item(空 reasoning、空正文)时组头孤零零一行,标个「空」
      toggleClass(t.grp, 'empty', t.body.children.length === 0);
      stick();
      return;
    }
    turn = null;
    let node: HTMLElement | null;
    if (item.type === 'message' && item.role === 'user') {
      node = renderWorld(entry, index, live);
      if (live) showThinking();
    } else if (isPrefix(item)) node = renderSystem(entry, live);
    else if (item.type === 'function_call_output') node = renderToolResult(entry, index, live);
    else node = renderOther(entry, index, live);
    if (node) inner.appendChild(node);
    stick();
  };

  /** 合成首轮:画法与 session 里的 Item 完全一样,前后各一道轻分隔线。 */
  const renderFirstTurn = (entries: readonly ContextRecord[]): void => {
    turn = null;
    inner.appendChild(ui.h('div', 'divider firstturn', S.firstTurnStart));
    for (const entry of entries) renderOne(entry, null, false);
    turn = null;
    inner.appendChild(ui.h('div', 'divider firstturn', S.firstTurnEnd));
  };

  function showThinking(): void {
    toggleClass(think, 'hidden', false);
    stick();
  }
  function hideThinking(): void {
    toggleClass(think, 'hidden', true);
  }

  return {
    el,
    rebuild(messages, opts) {
      const wasStuck = autoScroll;
      const keepTop = scroll.scrollTop;
      stopTyping();
      hideThinking();
      toolCalls.clear();
      turn = null;
      inner.replaceChildren();
      if (opts?.banner) inner.appendChild(opts.banner);
      if (opts?.note) inner.appendChild(ui.h('div', 'divider', opts.note));
      if (!messages.length) {
        inner.appendChild(ui.placeholder(opts?.empty ?? S.sessionEmpty));
        return;
      }
      // 合成首轮插在开头的 system 卡之后(与请求体里的位置一致)。
      const firstTurn = opts?.firstTurn?.length ? opts.firstTurn : null;
      let firstTurnDone = !firstTurn;
      messages.forEach((entry, i) => {
        if (!firstTurnDone && !isPrefix(entry.item)) {
          renderFirstTurn(firstTurn!);
          firstTurnDone = true;
        }
        renderOne(entry, i, false);
      });
      if (!firstTurnDone) renderFirstTurn(firstTurn!);
      if (opts?.keepScroll && !wasStuck) {
        scroll.scrollTop = keepTop;
        return;
      }
      autoScroll = true;
      toggleClass(jump, 'hidden', true);
      stick(true);
    },
    append(entry, index, live) {
      renderOne(entry, index, live);
    },
    setSpeaker(name) {
      speakerInitial = name.trim().slice(0, 1).toUpperCase() || 'B';
    },
  };
}
