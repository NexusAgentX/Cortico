/**
 * 面板 `reset`(bot 级)—— 统一重置:persona 回滚到某存档点 + 按序清空全部存储。
 *
 * 归属:这一次事务跨两个 owner(persona 的介质归Persona,存储清单归框架),
 * 所以**由 bot 编排**,框架不提供通用 transaction 原语。
 *
 * **顺序要紧**:persona 先回滚,`session` 那项(order 10)最后清——清完即用回滚后的
 * persona 重建前缀,保证"重开"落在那个存档点的世界上。顺序在服务端排,不在这里。
 *
 * 面板上先摊开"到底会清掉哪些东西",再给按钮。清单不齐时按钮直接不给按:
 * 半次重置(persona 回到出厂态、session 还活在回滚前的世界)比不重置危险得多。
 */

import type {
  ConsolePanelContext,
  ConsolePanel,
} from 'cortico/web/shared/client-panel.ts';
import {
  autoload, errText, gitLine, setMsg,
  type ResetResult, type ResetState,
} from './client.ts';

export const resetPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    autoload<ResetState>(ctx, {
      loading: '读取重置范围…',
      failed: '统一重置不可用',
      load: () => ctx.invoke<ResetState>('state'),
      render: (st, reload) => [runCard(ctx, st, reload), scopeCard(ctx, st)],
    });
  },
};

function runCard(ctx: ConsolePanelContext, st: ResetState, reload: () => void): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: '统一重置',
    en: 'rollback + clear all',
    desc: '把 persona/ 回滚到选定存档点,再按序清空全部 core 存储。'
      + '这不是"撤销上一步",是从那个存档点的干净态整个重开。',
  });

  const bar = ui.rowbar();
  bar.append(ui.pill(gitLine(st.status), st.status.repo ? 'on' : 'off'), ui.h('span', 'grow'));
  card.body.appendChild(bar);

  if (!st.ready) {
    card.body.appendChild(ui.placeholder(st.reason ?? '重置暂不可用'));
    return card.el;
  }
  if (!st.checkpoints.length) {
    card.body.appendChild(ui.placeholder('还没有存档点可以回滚到——先去「存档点」面板建一个'));
    return card.el;
  }

  const pick = ui.select({
    options: st.checkpoints.map((c) => ({
      value: c.name,
      label: `${c.name} · ${c.hash}${c.message ? ` · ${c.message}` : ''}`,
    })),
  });
  const msg = ui.msgline('');
  const run = ui.button('回滚并清空', {
    variant: 'danger',
    onClick: () => { void execute(ctx, pick.value, msg, run, reload); },
  });
  const line = ui.actions();
  line.append(msg, ui.h('span', 'grow'), run);
  card.body.append(ui.field('回滚到', pick), line);
  return card.el;
}

async function execute(
  ctx: ConsolePanelContext,
  checkpoint: string,
  msg: HTMLElement,
  btn: HTMLButtonElement,
  reload: () => void,
): Promise<void> {
  const { ui } = ctx;
  const first = await ui.confirm({
    title: `回滚到存档点「${checkpoint}」并清空全部存储?`,
    body: '① persona/(记忆)恢复到该存档点;② 清空全部 core 数据。'
      + 'persona 还能从 git 找回来,core 数据不可恢复。',
    danger: true,
  });
  if (!first) return;
  const second = await ui.confirm({
    title: '再确认',
    body: `将从「${checkpoint}」的干净态重开,当前经历全部清空。继续?`,
    danger: true,
  });
  if (!second) return;

  const busy = ui.busy('正在重置', '回滚 persona 并按序清空存储,这期间别动别的。');
  btn.disabled = true;
  try {
    const out = await ctx.invoke<ResetResult>('run', [checkpoint]);
    const bad = out.results.filter((r) => !r.ok);
    setMsg(
      msg,
      `${out.ok ? '✓ ' : '部分失败: '}${out.persona};清理 ${out.results.length} 项`
      + (bad.length ? `(${bad.map((r) => r.key).join('、')} 失败)` : ''),
      bad.length > 0,
    );
    if (bad.length) {
      ui.drawer('逐项结果', out.results.map((r) => `${r.ok ? '✓' : '✗'} ${r.key}: ${r.result}`).join('\n'));
    }
    reload();
  } catch (err) {
    setMsg(msg, `重置失败: ${errText(err)}`, true);
  } finally {
    busy.dispose();
    btn.disabled = false;
  }
}

function scopeCard(ctx: ConsolePanelContext, st: ResetState): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: '会被清掉的东西',
    en: 'storage parts',
    desc: '按这个清单逐项清除,顺序由各项自己声明(session 最后清,清完即重建前缀)。',
  });
  if (!st.parts.length) {
    card.body.appendChild(ui.placeholder('拿不到存储清单'));
    return card.el;
  }
  const table = ui.table({ head: ['项', '位置', '清掉之后'] });
  for (const p of st.parts) {
    const name = ui.h('span', null, p.label);
    const cell = ui.h('div', 'ct-cellops');
    cell.append(name);
    if (p.danger) cell.appendChild(ui.pill('不可恢复', 'off'));
    table.addRow([
      { el: cell },
      { text: p.location ?? (p.kind === 'memory' ? '(内存)' : '—'), cls: 'mono' },
      { text: p.note ?? '—', cls: 'txt' },
    ]);
  }
  card.body.appendChild(table.el);
  return card.el;
}
