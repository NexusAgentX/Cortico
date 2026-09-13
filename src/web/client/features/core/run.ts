/**
 * 运行态概览与暂停/继续控制。操作失败通过 ui.toast 展示，忙碌期间使用 ui.disable 并恢复控件各自原状态。
 */

import type { ConsoleUi } from '../../../shared/client-panel.ts';
import { post } from '../../core/api.ts';
import { loopOf, type StatusSnapshot } from '../live/protocol.ts';
import { S } from './strings.ts';

export interface RunViewDeps {
  ui: ConsoleUi;
  signal: AbortSignal;
  /** `/api/run/*` 挂了没有。没挂就不画那颗按钮,而不是画出来再拿 503 当界面。 */
  canPause: boolean;
  /** 动作完成后重新拉一次状态 */
  refresh(): Promise<void>;
  onError(err: unknown): void;
}

export interface RunView {
  el: HTMLElement;
  render(st: StatusSnapshot | null): void;
}

export function createRunView(deps: RunViewDeps): RunView {
  const { ui } = deps;
  const sheet = ui.sheet({
    title: S.runTitle,
    en: 'loop status',
    desc: S.runDesc,
  });
  const grid = ui.statgrid();
  let paused = false;

  const bar = ui.actions();
  bar.className += ' run-actions';
  const pauseBtn = ui.button(S.pause, {
    variant: 'primary',
    size: 'sm',
    onClick: () => void toggle(),
  });
  const hint = ui.msgline('');
  if (deps.canPause) {
    bar.append(hint, ui.h('span', 'grow'), pauseBtn);
  }
  sheet.body.appendChild(grid);
  if (deps.canPause) sheet.body.append(bar);

  async function toggle(): Promise<void> {
    const off = ui.disable(pauseBtn);
    try {
      const out = await post<{ error?: string; paused?: boolean }>(
        paused ? '/api/run/resume' : '/api/run/pause',
        {},
        { signal: deps.signal },
      );
      if (out?.error) throw new Error(out.error);
      setPaused(!!out?.paused);
      await deps.refresh();
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') return;
      deps.onError(err);
      ui.toast(S.actionFailed(String((err as Error)?.message ?? err)), 'bad');
    } finally {
      off.dispose();
    }
  }

  function setPaused(p: boolean): void {
    paused = p;
    pauseBtn.textContent = p ? S.resume : S.pause;
    hint.textContent = p ? S.pausedHint : S.runningHint;
  }
  setPaused(false);

  return {
    el: sheet.el,
    render(st) {
      while (grid.children.length) grid.children[0].remove();
      if (!st) {
        grid.appendChild(ui.placeholder(S.noStatus));
        return;
      }
      const loop = loopOf(st);
      const u = loop.lastUsage ?? {};
      setPaused(!!loop.paused);
      const cache =
        u.promptTokens ? ui.fmt.percent((u.cacheHitTokens || 0) / u.promptTokens) : '—';
      const cards = [
        { k: S.statContext, v: ui.fmt.count(loop.estTokens), unit: 'tok', accent: true },
        { k: S.statMessages, v: loop.messageCount ?? '—', unit: S.unitMsgs },
        { k: S.statCache, v: cache },
        { k: S.statRounds, v: loop.roundsLastBatch ?? '—' },
        { k: S.statBatches, v: loop.batchesHandled ?? '—' },
        { k: S.statEvents, v: st.eventCount ?? '—', unit: S.unitEvents },
        { k: S.statOnline, v: st.terminalOnline ?? '—', unit: S.unitPeople },
        {
          k: S.statRun,
          v: loop.paused ? S.runPaused : loop.scheduleBlocked ? S.runBlocked : S.runRunning,
          accent: !!(loop.paused || loop.scheduleBlocked),
        },
      ];
      for (const c of cards) grid.appendChild(ui.stat(c));
    },
  };
}
