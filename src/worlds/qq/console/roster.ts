/**
 * 面板 `roster` —— 监听名单:监听哪些群、哪些私聊。
 *
 * 每张卡片可单独开关、改号、删除。任何一次改动都把**整份名单**回传服务端
 * (`roster.set`),再重新取一遍回填——服务端是唯一权威,本地这份只是编辑期的副本。
 * 开关变化会让 World 推一条 `qq.watch` 事件,所以"停用"不是静默的。
 */

import type {
  ConsolePanelContext,
  ConsolePanel,
} from '../../../web/shared/client-panel.ts';
import {
  autoload,
  errText,
  type QQConvNames,
  type QQRoster,
  type QQRosterEntry,
} from './client.ts';

type Kind = 'group' | 'private';

interface RosterView {
  roster: QQRoster;
  names: QQConvNames;
}

const NO_NAMES: QQConvNames = { groups: [], privates: [] };

const WORDS = {
  group: { label: '监听群号', num: '群号', empty: '还没有监听任何群', add: '新群号' },
  private: { label: '监听私聊 QQ 号', num: 'QQ号', empty: '还没有监听任何私聊', add: '新QQ号' },
} as const;

export const rosterPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    autoload<RosterView>(ctx, {
      loading: '加载监听名单…',
      failed: '监听名单不可用(QQ 接入没开启时读不到)',
      load: async () => ({
        roster: await ctx.invoke<QQRoster>('get'),
        // 名字只是好看,取不到不该让整块名单读不出来
        names: await ctx.invoke<QQConvNames>('names').catch(() => NO_NAMES),
      }),
      render: (view, reload) => [sheet(ctx, view, reload)],
    });
  },
};

function sheet(ctx: ConsolePanelContext, view: RosterView, reload: () => void): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: '监听名单',
    en: '群号 + 私聊 QQ 号',
    desc: '每张卡片可单独开关、改号、删除,改动立即生效并写回 config.json;'
      + '开关变化会推一条事件,让 bot 知道自己参与的会话变了。',
  });

  /** 把整份名单回传,不论成败都重新取一遍与服务端对齐。 */
  const save = (action: string): void => {
    void ctx
      .invoke('set', [view.roster.groups, view.roster.privates])
      .then(
        () => { ui.toast(`${action}已保存`); },
        (err: unknown) => { ui.toast(`${action}失败: ${errText(err)}`, 'bad'); },
      )
      .then(() => {
        reload();
        // 监听条数变了 → 页头那个"监听 群 N · 私聊 M"徽标当场过期
        void ctx.refresh();
      });
  };

  for (const kind of ['group', 'private'] as const) {
    card.body.append(ui.section(WORDS[kind].label), list(ctx, view, kind, save));
  }
  return card.el;
}

function list(
  ctx: ConsolePanelContext,
  view: RosterView,
  kind: Kind,
  save: (action: string) => void,
): HTMLElement {
  const { ui } = ctx;
  const box = ui.h('div', 'qq-rosterlist');
  const entries = entriesOf(view.roster, kind);
  if (!entries.length) box.appendChild(ui.placeholder(WORDS[kind].empty));
  for (const entry of entries) box.appendChild(card(ctx, view, kind, entry, save));
  box.appendChild(addRow(ctx, view, kind, save));
  return box;
}

function entriesOf(roster: QQRoster, kind: Kind): QQRosterEntry[] {
  return kind === 'group' ? roster.groups : roster.privates;
}

/** 号码在这份名单里已知的显示名;没有就返回 null(渲染成"等连上/等消息补全")。 */
function nameOf(view: RosterView, kind: Kind, id: number): string | null {
  if (kind === 'group') {
    const g = view.names.groups.find((x) => x.id === id);
    return g ? `${g.name}${g.card ? `(我的群昵称「${g.card}」)` : ''}` : null;
  }
  const p = view.names.privates.find((x) => x.id === id);
  return p && p.name ? p.name : null;
}

function card(
  ctx: ConsolePanelContext,
  view: RosterView,
  kind: Kind,
  entry: QQRosterEntry,
  save: (action: string) => void,
): HTMLElement {
  const { ui } = ctx;
  const row = ui.h('div', entry.enabled ? 'qq-rcard' : 'qq-rcard off');

  // `ctx.ui` 没有勾选框原语,用按钮表达同一件事:按钮上写的是**当前状态**,
  // 点一下切到另一边。
  const toggle = ui.button(entry.enabled ? '监听中' : '已停用', {
    size: 'sm',
    variant: entry.enabled ? 'primary' : 'plain',
    onClick: () => {
      entry.enabled = !entry.enabled;
      save(entry.enabled ? '开启监听' : '停用');
    },
  });
  toggle.title = entry.enabled ? '点击停用(号码仍保留,可再开)' : '点击开启监听';

  const idInput = ui.input({ value: String(entry.id), cls: 'mono', placeholder: WORDS[kind].num });
  idInput.inputMode = 'numeric';
  // `onInput` 是逐次击键触发的,拿它提交等于边打字边存;改号要的是"敲完再说",
  // 所以这里自己听 change/Enter——监听带 `ctx.signal`,面板一卸就摘。
  idInput.addEventListener('change', () => {
    const n = Number(idInput.value.trim());
    const list = entriesOf(view.roster, kind);
    if (!Number.isInteger(n) || n <= 0) { idInput.value = String(entry.id); return; }
    if (n === entry.id) return;
    if (list.some((e) => e !== entry && e.id === n)) {
      ui.toast('这个号码已经在名单里了', 'bad');
      idInput.value = String(entry.id);
      return;
    }
    entry.id = n;
    save('修改号码');
  }, { signal: ctx.signal });
  idInput.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key === 'Enter') idInput.blur();
  }, { signal: ctx.signal });

  const known = nameOf(view, kind, entry.id);
  const name = ui.h(
    'span',
    'qq-rc-name',
    known ?? (kind === 'group' ? '(群信息未知,连上后自动补全)' : '(等消息到达后自动补名)'),
  );
  name.title = name.textContent ?? '';

  const del = ui.button('✕', {
    size: 'sm',
    variant: 'danger',
    onClick: () => { void remove(ctx, view, kind, entry, save); },
  });
  del.title = '删除(不只是停用)';

  row.append(toggle, idInput, name, del);
  return row;
}

async function remove(
  ctx: ConsolePanelContext,
  view: RosterView,
  kind: Kind,
  entry: QQRosterEntry,
  save: (action: string) => void,
): Promise<void> {
  const ok = await ctx.ui.confirm({
    title: `${kind === 'group' ? '删除群' : '删除私聊'} ${entry.id}?`,
    body: '整条从名单里去掉。只是想暂时不听的话,用"停用"。',
    danger: true,
  });
  if (!ok) return;
  const list = entriesOf(view.roster, kind);
  const i = list.indexOf(entry);
  if (i >= 0) list.splice(i, 1);
  save('删除');
}

function addRow(
  ctx: ConsolePanelContext,
  view: RosterView,
  kind: Kind,
  save: (action: string) => void,
): HTMLElement {
  const { ui } = ctx;
  const row = ui.h('div', 'qq-rcadd');
  const field = ui.input({ cls: 'mono', placeholder: WORDS[kind].add });
  const doAdd = (): void => {
    const n = Number(field.value.trim());
    if (!Number.isInteger(n) || n <= 0) {
      ui.toast(`请输入有效的${WORDS[kind].num}`, 'bad');
      return;
    }
    const list = entriesOf(view.roster, kind);
    if (list.some((e) => e.id === n)) {
      ui.toast('这个号码已经在名单里了', 'bad');
      return;
    }
    list.push({ id: n, enabled: true });
    field.value = '';
    save('添加');
  };
  field.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key === 'Enter') doAdd();
  }, { signal: ctx.signal });
  row.append(ui.h('span'), field, ui.button('＋ 添加', { size: 'sm', variant: 'primary', onClick: doAdd }));
  return row;
}
