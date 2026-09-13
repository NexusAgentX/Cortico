/**
 * B 站直播间 World 的浏览器扩展。
 *
 * `log` 保留直播间入站诊断。Overlay 编辑器由 World 的回环服务独立承载，
 * 控制台只暴露入口链接。
 *
 * 事件流是**轮询**而不是推送:`WorldConsoleDecl` 只有 `invoke`。服务端的
 * `state` 带 `total`(记过的总条数),这里据此只把自己没见过的那一截 append 进
 * `ui.log`——整份重铺会刷掉尾部粘滞与用户往上翻的位置。
 *
 * 与外界的依赖只有一条:`client-panel.ts` 里的类型。服务端各方法的返回形状在
 * 这里重新声明(而不是 import `world.ts`),那边是 Node 模块,浏览器 bundle 里
 * 不能有它。
 */

import type { ConsoleClientBundle, ConsolePanelContext, ConsolePanel } from '../../../web/shared/client-panel.ts';

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// 服务端 `BilibiliWorld.console().invoke('log', 'state')` 的返回形状
// ---------------------------------------------------------------------------

interface BilibiliLiveStatus {
  /** `stopped` / `connecting` / `connected` / `retrying` */
  phase: string;
  /** 配置里填的房间号(可能是短号) */
  roomId: number;
  /** 换算出的真实房间号;还没握手完就是 null */
  realRoomId: number | null;
  title: string | null;
  living: boolean;
  /** 登录凭证对应的自己的 uid;匿名接入时为 0 */
  selfUid: number;
  lastError: string | null;
}

/** 待带出的人流读数。计数项累加,读数项是最后一次看见的值。 */
interface BilibiliAggregate {
  enter: number;
  like: number;
  freeGift: number;
  watched: number | null;
  online: number | null;
  popularity: number | null;
  fans: number | null;
  likeTotal: number | null;
}

interface BilibiliLogState {
  status: BilibiliLiveStatus | null;
  /** 最近一窗弹幕全都没有 uid——服务端在脱敏,多半是登录凭证过期了 */
  desensitized: boolean;
  aggregate: BilibiliAggregate;
  /** 最近事件的文本，按时间倒序排列。 */
  recent: string[];
  /** 记过的总条数(含已被上限挤掉的) */
  total: number;
  /** cmd → 条数,按条数降序;没进白名单也没进黑名单的 cmd 也在里面 */
  counts: Array<[string, number]>;
  audienceAdmission: {
    trackedViewers: number;
    qualifiedViewers: number;
    crowd: { onlineRankCount: number | null; signalFresh: boolean; active: boolean };
    totals: { input: number; selected: number; dropped: number; limitedBatches: number };
    lastBatch: { limitingActive: boolean; input: number; selected: number } | null;
    persistenceError: string | null;
  };
}

const DESC = '直播间事件与各 cmd 计数。';

const PHASE_TEXT: Record<string, string> = {
  stopped: '未接入',
  connecting: '连接中',
  connected: '已接入',
  retrying: '重连中',
};

const POLL_MS = 2000;
/** 与服务端 `RECENT_CAP` 同一个数:服务端留多少条,这里最多也就能补上多少条 */
const KEEP = 200;

const logPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    const { ui, root } = ctx;
    const card = ui.sheet({ title: '直播间事件', en: 'bilibili live', desc: DESC });
    root.appendChild(card.el);

    const err = ui.msgline();
    const info = ui.h('div');
    const gauges = ui.statgrid();
    const view = ui.log({ max: KEEP, maxHeight: '320px', empty: '(等待直播间消息…)' });
    const counts = ui.table({ head: ['cmd', '条数'] });
    const btnEnd = ui.button('回到底部', { size: 'sm', onClick: () => view.scrollToEnd() });
    const bar = ui.rowbar();
    bar.append(ui.h('span', 'grow'), btnEnd);
    card.body.append(err, info, gauges, bar, view.el, counts.el);

    /** 已经画出来的条数。服务端的 `total` 减去它就是这一拍要补的新行。 */
    let shown = 0;

    const setError = (text: string | null): void => {
      err.textContent = text ?? '';
      err.className = text ? 'msgline bad' : 'msgline';
      err.hidden = !text;
    };
    setError(null);

    const drawInfo = (st: BilibiliLogState): void => {
      const s = st.status;
      const room = s?.realRoomId
        ? `${s.realRoomId}${s.roomId && s.roomId !== s.realRoomId ? `(短号 ${s.roomId})` : ''}`
        : s?.roomId
          ? `${s.roomId}(还没换算出真实房间号)`
          : '未配置';
      info.replaceChildren(ui.kv([
        { k: '接入', v: PHASE_TEXT[s?.phase ?? 'stopped'] ?? s?.phase ?? '未接入' },
        { k: '直播间', v: room },
        { k: '标题', v: s?.title || '—' },
        { k: '开播', v: ui.pill(s?.living ? '直播中' : '未开播', s?.living ? 'on' : 'off') },
        {
          k: '身份',
          v: st.desensitized
            ? ui.pill('脱敏中:观众 uid 被抹成 0,认不出人(登录凭证多半过期了)', 'off')
            : ui.pill(s?.selfUid ? `可认人(登录 uid ${s.selfUid})` : '待观察', s?.selfUid ? 'on' : 'plain'),
        },
        ...(s?.lastError ? [{ k: '最近错误', v: s.lastError }] : []),
      ]));
    };

    /** 待带出的读数。发车刻清空,所以这里看到的是"还没搭上车的那一份"。 */
    const drawGauges = (agg: BilibiliAggregate, admission: BilibiliLogState['audienceAdmission']): void => {
      const num = (v: number | null): string => (v === null ? '—' : ui.fmt.count(v));
      const last = admission.lastBatch;
      const limiter = admission.crowd.active
        ? last?.limitingActive
          ? `筛选中（上批 ${last.selected}/${last.input}）`
          : '拥挤，当前批仍全量'
        : last?.limitingActive
          ? `全量通过（上批曾筛 ${last.selected}/${last.input}）`
          : '全量通过';
      gauges.replaceChildren(
        ui.stat({ k: '待带出 · 进场', v: agg.enter, unit: '人' }),
        ui.stat({ k: '待带出 · 点赞', v: agg.like, unit: '次' }),
        ui.stat({ k: '待带出 · 免费礼物', v: agg.freeGift, unit: '个' }),
        ui.stat({ k: '高能榜', v: num(admission.crowd.onlineRankCount ?? agg.online), unit: '人' }),
        ui.stat({ k: '上下文准入', v: limiter }),
        ui.stat({ k: '重要观众', v: admission.qualifiedViewers, unit: '人' }),
        ui.stat({ k: '累计拦下', v: admission.totals.dropped, unit: '条' }),
        ui.stat({ k: '看过', v: num(agg.watched) }),
        ui.stat({ k: '人气', v: num(agg.popularity) }),
        ui.stat({ k: '粉丝', v: num(agg.fans) }),
      );
    };

    const drawCounts = (rows: BilibiliLogState['counts']): void => {
      counts.clear(rows.length ? undefined : '(还没收到任何 cmd)');
      for (const [cmd, n] of rows) counts.addRow([cmd, n]);
    };

    /** 只 append 没见过的那一截:`recent` 是新→旧,倒过来才是时间序。 */
    const appendNew = (st: BilibiliLogState): void => {
      const fresh = Math.min(st.total - shown, st.recent.length);
      if (fresh <= 0) {
        shown = st.total;
        return;
      }
      const chronological = [...st.recent].reverse();
      for (const line of chronological.slice(chronological.length - fresh)) view.append(line);
      shown = st.total;
    };

    let polling = false;
    const poll = (): void => {
      if (polling) return;
      polling = true;
      void ctx.invoke<BilibiliLogState>('state').then(
        (st) => {
          polling = false;
          if (ctx.signal.aborted) return;
          setError(null);
          drawInfo(st);
          drawGauges(st.aggregate, st.audienceAdmission);
          drawCounts(st.counts);
          appendNew(st);
        },
        (e: unknown) => {
          polling = false;
          if (ctx.signal.aborted) return;
          setError(`取直播间状态失败: ${errText(e)}(下一拍再试)`);
        },
      );
    };

    ctx.interval(poll, POLL_MS);
    poll();
  },
};

const bundle: ConsoleClientBundle = {
  // 键是**局部** panel id,与服务端 `console().panels[].id` 一一对应。
  panels: {
    log: logPanel,
  },
};

export default bundle;
