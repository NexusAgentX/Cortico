/**
 * 终端对话面板通过 ctx.stream 收发帧、ctx.ui 创建节点，尾部粘滞由 ui.log 管理。
 * 发送 hello{name}、msg{text, images?}；接收 msg{from, text, ts, history?, images?} 或 sys{text}，协议由终端 World 定义。
 * 输入图片以归一化 base64 随 msg 发送；回显与回放通过 blob(handle) 取回字节。ObjectURL 登记到 ctx.own，卸载时释放；缩略图使用 ui.drawer 查看。
 * 流连接退避重连并随卸载停止；昵称通过按 provider:panel 隔离的 ctx.memo 保存。
 */

import type {
  ConsoleLog,
  ConsolePanelContext,
  ConsolePanel,
  ConsolePromptInput,
  ConsoleStreamHandle,
} from '../../../web/shared/client-panel.ts';
import { toDisposable } from '../../../web/shared/client-panel.ts';

/** 与 World 的 `NAME_MAX` / `IMAGES_MAX` 一致:先在本地拦,免得服务端拒了两边显示不一样。 */
const NAME_MAX = 32;
const IMAGES_MAX = 8;

/**
 * 面板文案,两种语言各一张表;`en: typeof zh` 由 tsc 保证键集一致。中文逐字保留现状。
 * 扩展不能 import 控制台内部模块,语言从 `ctx.language` 取,两张表就地二选一。
 */
const zh = {
  title: '对话',
  desc: '直接和她说话,可以附图。消息即时投递(跳过合批的安静窗口);进出场会给她一条在场提示。',
  connecting: '连接中…',
  connected: '已连接',
  reconnecting: '断开,重连中…',
  disconnected: '已断开',
  namePlaceholder: '你的名字',
  empty: '(还没有消息)',
  inputLabel: '终端对话输入',
  inputPlaceholder: '说点什么…',
  inputHint: 'Terminal · Enter 发送 · 可粘贴或拖入图片',
  needName: '先填个名字再说话',
  queued: '通道未连接,已排队待发',
  imageUnavailable: '图片不可用',
};
const en: typeof zh = {
  title: 'Chat',
  desc: 'Talk to her directly, with optional images. Messages are delivered immediately (skipping the batching quiet window); entering and leaving posts a presence hint.',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Disconnected, reconnecting…',
  disconnected: 'Disconnected',
  namePlaceholder: 'Your name',
  empty: '(no messages yet)',
  inputLabel: 'Terminal chat input',
  inputPlaceholder: 'Say something…',
  inputHint: 'Terminal · Enter to send · paste or drop images',
  needName: 'Enter a name before talking',
  queued: 'Channel not connected; queued to send',
  imageUnavailable: 'Image unavailable',
};
const stringsOf = (ctx: ConsolePanelContext): typeof zh => (ctx.language === 'en' ? en : zh);

/** 服务端推来的帧。认识的两种之外一律忽略(World 以后加帧型不该让老面板炸)。 */
interface ChatFrame {
  type?: unknown;
  from?: unknown;
  text?: unknown;
  ts?: unknown;
  history?: unknown;
  images?: unknown;
}

/** 帧里的一张图:只有引用,字节另取。 */
interface FrameImage {
  ref: string;
  mime: string;
  name?: string;
}

function frameImages(raw: unknown): FrameImage[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const img = (item ?? {}) as { ref?: unknown; mime?: unknown; name?: unknown };
    if (typeof img.ref !== 'string' || typeof img.mime !== 'string') return [];
    return [{ ref: img.ref, mime: img.mime, ...(typeof img.name === 'string' ? { name: img.name } : {}) }];
  });
}

export const chatPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    const { ui } = ctx;
    const S = stringsOf(ctx);

    const card = ui.sheet({
      title: S.title,
      en: 'terminal',
      desc: S.desc,
    });

    // ── 顶栏:连接状态 + 昵称 ──────────────────────────────────────────
    //
    // 状态标整颗换掉而不是改它的 class:`ui.pill` 给的是一次性节点,
    // 手写 `el.className = 'pill on'` 等于把控制台的 class 名抄进扩展里。
    const top = ui.rowbar();
    let dot = ui.pill(S.connecting, 'plain');
    const setDot = (text: string, tone: 'on' | 'off' | 'plain'): void => {
      const next = ui.pill(text, tone);
      dot.replaceWith(next);
      dot = next;
    };

    let composer: ConsolePromptInput;
    const nameBox = ui.input({
      value: ctx.memo.get<string>('name', ''),
      placeholder: S.namePlaceholder,
      onChange: (v) => rename(v),
      onCommit: (v) => { rename(v); composer.focus(); },
    });
    top.append(dot, nameBox, ui.h('span', 'grow'));
    card.body.appendChild(top);

    // ── 消息流 ────────────────────────────────────────────────────────
    const view: ConsoleLog = ui.log({
      variant: 'conversation',
      maxHeight: 'calc(100vh - 340px)',
      empty: S.empty,
      max: 600,
    });
    card.body.appendChild(view.el);

    // ── 输入 ──────────────────────────────────────────────────────────
    composer = ui.promptInput({
      label: S.inputLabel,
      placeholder: S.inputPlaceholder,
      hint: S.inputHint,
      images: { max: IMAGES_MAX },
      onSubmit: (text, images) => send(text, images.map((i) => ({ mime: i.mime, base64: i.base64, name: i.name }))),
    });
    card.body.appendChild(composer.el);

    ctx.root.appendChild(card.el);

    // ── 连接 ──────────────────────────────────────────────────────────

    /** 已经报过的名字。断线要清:重连是一条全新的连接,对面不记得你。 */
    let helloSent = '';

    const currentName = (): string => nameBox.value.trim().slice(0, NAME_MAX);

    /** 名字变了(或刚连上)就报一次;同一个名字不重复报。 */
    const sayHello = (): void => {
      const name = currentName();
      if (!name || name === helloSent) return;
      helloSent = name;
      stream.send(JSON.stringify({ type: 'hello', name }));
    };

    const rename = (raw: string): void => {
      const name = raw.trim().slice(0, NAME_MAX);
      if (name !== nameBox.value) nameBox.value = name;
      ctx.memo.set('name', name);
      sayHello();
    };

    const send = (text: string, images: Array<{ mime: string; base64: string; name: string }>): boolean => {
      if (!currentName()) {
        ui.toast(S.needName, 'bad');
        nameBox.focus();
        return false;
      }
      sayHello();
      // 没连上时 `stream.send` 会排队,连上后按序发出——所以这里只提示,不拦。
      if (!stream.open) ui.toast(S.queued);
      stream.send(JSON.stringify({ type: 'msg', text, ...(images.length ? { images } : {}) }));
      composer.focus();
      return true;
    };

    const stream: ConsoleStreamHandle = ctx.stream({
      message: (raw) => renderFrame(ctx, view, raw, imageUrl),
      open: () => {
        setDot(S.connected, 'on');
        helloSent = '';
        sayHello();
      },
      close: (willRetry) => {
        setDot(willRetry ? S.reconnecting : S.disconnected, 'off');
        helloSent = '';
      },
    });

    // ── 取图 ──────────────────────────────────────────────────────────
    //
    // 同一引用只取一次(回放与回显会撞上同一张);object URL 随面板释放。
    const urls = new Map<string, Promise<string>>();
    const imageUrl = (ref: string): Promise<string> => {
      let p = urls.get(ref);
      if (!p) {
        p = ctx.invokeBinary('blob', [ref]).then((blob) => {
          const url = URL.createObjectURL(blob);
          ctx.own(toDisposable(() => URL.revokeObjectURL(url)));
          return url;
        });
        urls.set(ref, p);
      }
      return p;
    };
  },
};

/** 一帧 → 一行。认不出的帧静默丢掉(不是错误:World 可以先于面板长出新帧型)。 */
function renderFrame(
  ctx: ConsolePanelContext,
  view: ConsoleLog,
  raw: string,
  imageUrl: (ref: string) => Promise<string>,
): void {
  let frame: ChatFrame;
  try {
    frame = JSON.parse(raw) as ChatFrame;
  } catch {
    return;
  }
  if (!frame || typeof frame !== 'object') return;

  if (frame.type === 'sys') {
    const text = typeof frame.text === 'string' ? frame.text : '';
    if (text) view.append(text, 'dim');
    return;
  }
  if (frame.type === 'msg') {
    const from = typeof frame.from === 'string' ? frame.from : '?';
    const text = typeof frame.text === 'string' ? frame.text : '';
    // 历史回放退到次要配色:一进来那 30 行不该和刚说的话一样重。
    const row = view.append(`[${ctx.ui.fmt.clock(frame.ts)}] ${from}: ${text}`, frame.history ? 'dim' : 'plain');
    const images = frameImages(frame.images);
    if (images.length > 0) row.appendChild(imageStrip(ctx, images, imageUrl));
  }
}

/** 一条消息下面的缩略图条。图取回前先占位,取不回就留一个带引用名的空格子。 */
function imageStrip(
  ctx: ConsolePanelContext,
  images: readonly FrameImage[],
  imageUrl: (ref: string) => Promise<string>,
): HTMLElement {
  const { ui } = ctx;
  const S = stringsOf(ctx);
  const strip = ui.h('div', 'attachstrip');
  for (const image of images) {
    const label = image.name ?? image.ref;
    const cell = ui.h('button', 'attachcell');
    cell.type = 'button';
    cell.title = label;
    cell.disabled = true;
    strip.appendChild(cell);
    imageUrl(image.ref).then(
      (url) => {
        const thumb = ui.h('img');
        thumb.src = url;
        thumb.alt = label;
        cell.appendChild(thumb);
        cell.disabled = false;
        cell.addEventListener('click', () => {
          const big = ui.h('img', 'imgzoom');
          big.src = url;
          big.alt = label;
          ui.drawer(label, big);
        }, { signal: ctx.signal });
      },
      () => { cell.classList.add('missing'); cell.textContent = S.imageUnavailable; },
    );
  }
  return strip;
}
