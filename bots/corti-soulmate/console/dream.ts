/**
 * 手动交接面板，通过 provider invoke 触发 bot 声明的动作，并读取该动作的状态。后台梦整理由 bot 负责。
 */

import type {
  ConsolePanelContext,
  ConsolePanel,
} from 'cortico/web/shared/client-panel.ts';
import { autoload, dimLine, errText, setMsg, type DreamState, type DreamTriggered } from './client.ts';

/** 入梦/截断跨好几轮,盯着看时几秒一问够了。走 `ctx.interval`,离开面板即停。 */
const POLL_MS = 4000;

export const dreamPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    autoload<DreamState>(ctx, {
      loading: '读取潜意识状态…',
      failed: '潜意识状态不可用',
      load: () => ctx.invoke<DreamState>('state'),
      render: (st) => [card(ctx, st)],
    });
  },
};

function card(ctx: ConsolePanelContext, initial: DreamState): HTMLElement {
  const { ui } = ctx;
  const sheet = ui.sheet({
    title: '强制入梦',
    en: 'handoff → dream',
    desc: '正常情况下交接由上下文压力自己决定。这颗按钮是人工插队:'
      + '强制一次交接(她带着交接笔记在新上下文里继续),交接前的快照交给后台的梦 fork 整理 persona/。'
      + '已经在入梦或交接中就不会重复触发。',
  });

  const pills = ui.rowbar();
  const dreamPill = ui.pill('—', 'plain');
  pills.append(ui.h('span', 'ct-dim', '梦'), dreamPill, ui.h('span', 'grow'));

  const msg = ui.msgline('');
  const trigger = ui.button('强制交接并入梦', {
    variant: 'primary',
    onClick: () => { void fire(); },
  });
  const bar = ui.actions();
  bar.append(msg, ui.h('span', 'grow'), trigger);

  sheet.body.append(pills, dimLine(
    ctx,
    '交接本身是 core 原语;"交接后入梦"这个安排归Persona。',
  ), bar);

  const paint = (st: DreamState): void => {
    dreamPill.textContent = st.dreaming ? '进行中' : '空闲';
    dreamPill.className = `pill ${st.dreaming ? 'on' : 'off'}`;
    trigger.disabled = st.dreaming;
    trigger.textContent = st.dreaming ? '入梦中…' : '强制交接并入梦';
  };
  paint(initial);

  const fire = async (): Promise<void> => {
    trigger.disabled = true;
    try {
      const out = await ctx.invoke<DreamTriggered>('trigger');
      setMsg(msg, out.message, !out.ok);
      paint(out.state);
    } catch (err) {
      setMsg(msg, `触发失败: ${errText(err)}`, true);
      trigger.disabled = false;
    }
  };

  // 盯着状态走:轮询登记在 `ctx.interval` 上,离开面板自动停(不是裸 setInterval)。
  ctx.interval(() => {
    void ctx.invoke<DreamState>('state').then(
      (st) => { if (!ctx.signal.aborted) paint(st); },
      () => { /* 一拍问不到不改画面,下一拍再说 */ },
    );
  }, POLL_MS);

  return sheet.el;
}
