/**
 * Persona自报的 MEMORY 0–4 分层视图与写权限矩阵。服务端逐角色、区域和操作调用 checkAccess 生成矩阵。
 */

import type {
  ConsolePanelContext,
  ConsolePanel,
} from 'cortico/web/shared/client-panel.ts';
import { autoload, dimLine, type FileOp, type MemoryState } from './client.ts';

/** 四条认知路径的中文名。这是本人格实现自己的词表,不是框架概念。 */
const ROLE_LABELS: Record<string, string> = {
  main: '主意识 main',
  dream: '梦 dream',
};

const OP_LABELS: Record<FileOp, string> = {
  read: '读',
  write: '写',
  append: '追加',
  rename: '改名',
  delete: '删除',
};

export const memoryPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    autoload<MemoryState>(ctx, {
      loading: '读取记忆分层…',
      failed: 'Memory 视图不可用',
      load: () => ctx.invoke<MemoryState>('state'),
      render: (st) => [tiersCard(ctx, st), memoCard(ctx, st), matrixCard(ctx, st)],
    });
  },
};

// ---------------------------------------------------------------------------

function tiersCard(ctx: ConsolePanelContext, st: MemoryState): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: 'MEMORY 分层',
    en: 'MEMORY 0–4',
    desc: '半静态段的五层,深→浅。每层装什么由Persona定;这里印的是它此刻真装着的东西。',
  });
  const table = ui.table({ head: ['层', '装的是什么', '此刻'] });
  for (const t of st.tiers) {
    table.addRow([
      { text: `${t.id}·${t.title}`, cls: 'mono' },
      { text: t.detail, cls: 'txt' },
      { text: t.live, cls: 'mono' },
    ]);
  }
  card.body.appendChild(table.el);
  return card.el;
}

function memoCard(ctx: ConsolePanelContext, st: MemoryState): HTMLElement {
  const { ui } = ctx;
  const { memo } = st;
  const card = ui.sheet({
    title: 'memo 三级',
    en: 'resident / active / archived',
    desc: '常驻区全文进前缀,所以有容量上限;active 只列名;archived 只报数。'
      + '上限由记忆工具写入时硬拦(memoCapGuard),不是建议值。',
  });

  card.body.appendChild(ui.statgrid([
    { k: '常驻 memo/', v: memo.resident.length, unit: `/ ${memo.residentCap}`, accent: true },
    { k: 'active/', v: memo.active.length, unit: `/ ${memo.activeCap}` },
    { k: 'archived/', v: memo.archived, unit: '条' },
  ]));

  card.body.appendChild(ui.section('常驻区(全文进前缀,时间序:最旧在前)'));
  card.body.appendChild(fileList(ctx, memo.resident, '常驻区是空的'));
  card.body.appendChild(ui.section('active/(前缀里只出现文件名)'));
  card.body.appendChild(fileList(ctx, memo.active, 'active/ 目前是空的'));
  card.body.appendChild(dimLine(
    ctx,
    memo.archived > 0
      ? `archived/ 里还有 ${memo.archived} 条归档,前缀里只报数量,正文由 agent 主动翻。`
      : 'archived/ 目前是空的。',
  ));
  return card.el;
}

function fileList(ctx: ConsolePanelContext, names: string[], empty: string): HTMLElement {
  const { ui } = ctx;
  if (!names.length) return ui.placeholder(empty);
  const box = ui.h('div', 'ct-chips');
  for (const n of names) box.appendChild(ui.chip(n));
  return box;
}

// ---------------------------------------------------------------------------

function matrixCard(ctx: ConsolePanelContext, st: MemoryState): HTMLElement {
  const { ui } = ctx;
  const { matrix } = st;
  const card = ui.sheet({
    title: '写权限矩阵',
    en: 'checkAccess()',
    desc: '机械硬拦,不做认知判断:哪条路径写不进去,工具层当场拒绝并把理由回给 agent。'
      + '这张表是逐格现算的(每格真跑一次 checkAccess),所以它永远等于代码。',
  });

  const table = ui.table({
    head: ['区域', ...matrix.roles.map((r) => ROLE_LABELS[r] ?? r)],
  });
  for (const row of matrix.rows) {
    table.addRow([
      { text: row.label, cls: 'txt' },
      ...row.cells.map((cell) => ({ el: cellNode(ctx, cell) })),
    ]);
  }
  card.body.appendChild(table.el);
  card.body.appendChild(dimLine(
    ctx,
    '读一律放行(全角色全区域可读),所以「只读」那格的意思是:除了读,什么都不行。'
    + '把鼠标停在格子上能看到被拒时 agent 收到的原话。',
  ));
  return card.el;
}

/**
 * 一格。允许的操作印成 pill;被拒的理由塞进 `title`——那句话就是 agent 会看到的
 * tool result,摊在页面上会把表撑爆,但它是排查"她为什么写不进去"唯一有用的东西。
 */
function cellNode(ctx: ConsolePanelContext, cell: { allowed: FileOp[]; denied: Array<{ op: FileOp; reason: string }> }): HTMLElement {
  const { ui } = ctx;
  const box = ui.h('div', 'ct-cellops');
  const writable = cell.allowed.filter((op) => op !== 'read');
  if (!writable.length) {
    box.appendChild(ui.pill('只读', 'off'));
  } else {
    for (const op of writable) box.appendChild(ui.pill(OP_LABELS[op], 'on'));
  }
  if (cell.denied.length) {
    box.title = cell.denied.map((d) => `${OP_LABELS[d.op]}:${d.reason}`).join('\n');
  }
  return box;
}
