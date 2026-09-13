/**
 * 「首轮对话」设置节 —— 合成风格锚的开关与三段内容。
 *
 * 数据面完全复用既有链路,这一页没有自己的端点:
 *  - 三段内容 = Persona自报的三份 promptDocs(key 前缀 `firstTurn.`),
 *    读写走 `/api/prompts`(revision 乐观锁、原子写都是那条链路的现成货);
 *  - 开关 = `context.firstTurn`(core 配置组,`x-hot`),读写走 `/api/config`;
 *  - 保存后提示重载——注入内容随 system 前缀重建刷新,与「系统提示词」页同一心智。
 *
 * 与提示词页不同,这里**不是**前缀的一部分:内容在出线态插进消息数组
 * (system 之后、真实历史之前),只进请求、不落盘。
 */
import { get, post } from '../../core/api.ts';
import type { FeatureContext } from '../feature.ts';
import type { ConfigGroupEntry } from '../config/view.ts';
import { S } from './strings.ts';

/** `/api/prompts` 条目里这一页用得到的字段。 */
interface FirstTurnDoc {
  key: string;
  title: string;
  description?: string;
  content?: string;
  revision?: string;
}

/** 三段的固定顺序(后端 list 顺序不保证)。 */
const DOC_ORDER = ['firstTurn.user', 'firstTurn.thinking', 'firstTurn.reply'] as const;

export async function mountFirstTurn(ctx: FeatureContext): Promise<void> {
  const { ui, root } = ctx;
  const sheet = ui.sheet({
    title: S.title,
    en: 'first turn',
    desc: S.desc,
  });
  sheet.body.appendChild(ui.placeholder(S.loading));
  root.appendChild(sheet.el);

  const status = ui.msgline('');
  const setStatus = (text: string, bad?: boolean): void => {
    status.className = bad ? 'msgline bad' : 'msgline';
    status.textContent = text;
  };

  // ── 数据 ──────────────────────────────────────────────────────────
  let docs: FirstTurnDoc[] = [];
  let configGroupId: string | null = null;
  let enabled = true;
  try {
    const d = await get<{ prompts?: FirstTurnDoc[] }>('/api/prompts', { signal: ctx.signal });
    docs = (d.prompts ?? []).filter((doc) => doc.key.startsWith('firstTurn.'));
    docs.sort((a, b) => DOC_ORDER.indexOf(a.key as typeof DOC_ORDER[number])
      - DOC_ORDER.indexOf(b.key as typeof DOC_ORDER[number]));
    if (ctx.capabilities.config === true) {
      const c = await get<{ groups?: ConfigGroupEntry[] }>('/api/config', { signal: ctx.signal });
      for (const entry of c.groups ?? []) {
        if ('context.firstTurn' in (entry.group.schema.properties ?? {})) {
          configGroupId = entry.group.id;
          enabled = entry.values?.['context.firstTurn'] !== false;
          break;
        }
      }
    }
  } catch (err) {
    if ((err as { name?: string } | null)?.name === 'AbortError') return;
    ctx.onError(err);
    sheet.body.replaceChildren(ui.placeholder(S.loadFailed(String((err as Error)?.message ?? err))));
    return;
  }
  if (ctx.signal.aborted) return;

  if (docs.length === 0) {
    sheet.body.replaceChildren(ui.placeholder(S.noSources));
    return;
  }

  sheet.body.replaceChildren();

  // ── 开关(x-hot,改了就存) ─────────────────────────────────────────
  if (configGroupId) {
    const groupId = configGroupId;
    const check = ui.checkbox(S.enable, {
      checked: enabled,
      onChange: (next) => {
        void post<{ error?: string }>(
          '/api/config',
          { group: groupId, values: { 'context.firstTurn': next } },
          { signal: ctx.signal },
        ).then(() => {
          setStatus(next ? S.enabledNote : S.disabledNote);
        }).catch((err: unknown) => {
          if ((err as { name?: string } | null)?.name === 'AbortError') return;
          ctx.onError(err);
          check.setChecked(!next);
          setStatus(S.toggleFailed(String((err as Error)?.message ?? err)), true);
        });
      },
    });
    sheet.body.appendChild(check.el);
  }

  // ── 三段内容 ──────────────────────────────────────────────────────
  const editors = new Map<string, { area: HTMLTextAreaElement; doc: FirstTurnDoc }>();
  for (const doc of docs) {
    const area = ui.textarea({ cls: 'mono', rows: 6 });
    area.value = doc.content ?? '';
    const label = doc.description ? `${doc.title} — ${doc.description}` : doc.title;
    sheet.body.appendChild(ui.field(label, area));
    editors.set(doc.key, { area, doc });
  }

  // ── 保存与重载 ────────────────────────────────────────────────────
  const save = async (): Promise<void> => {
    const changed = [...editors.values()].filter(({ area, doc }) => area.value !== (doc.content ?? ''));
    if (changed.length === 0) {
      setStatus(S.noChanges);
      return;
    }
    setStatus(S.saving);
    for (const item of changed) {
      try {
        const out = await post<{ error?: string; revision?: string }>(
          '/api/prompts',
          { key: item.doc.key, content: item.area.value, baseRevision: item.doc.revision },
          { signal: ctx.signal },
        );
        if (out?.error) throw new Error(out.error);
        item.doc.content = item.area.value;
        item.doc.revision = out?.revision;
      } catch (err) {
        if ((err as { name?: string } | null)?.name === 'AbortError') return;
        ctx.onError(err);
        setStatus(S.saveFailed(item.doc.title, String((err as Error)?.message ?? err)), true);
        return;
      }
    }
    setStatus(ctx.capabilities.sessionControl === true ? S.savedReload : S.savedNext);
  };

  const bar = ui.actions();
  bar.appendChild(status);
  bar.appendChild(ui.h('span', 'grow'));
  if (ctx.capabilities.sessionControl === true) {
    bar.appendChild(ui.button(S.saveAndReload, {
      size: 'sm',
      onClick: () => {
        void save().then(async () => {
          if (status.className.includes('bad')) return; // 保存失败就别接着重载
          setStatus(S.reloading);
          try {
            const out = await post<{ result?: string }>(
              '/api/session/reload-prefix', undefined, { signal: ctx.signal },
            );
            setStatus(out?.result || S.reloaded);
          } catch (err) {
            if ((err as { name?: string } | null)?.name === 'AbortError') return;
            ctx.onError(err);
            setStatus(S.reloadFailed(String((err as Error)?.message ?? err)), true);
          }
        });
      },
    }));
  }
  bar.appendChild(ui.button(S.save, { size: 'sm', variant: 'primary', onClick: () => void save() }));
  sheet.body.appendChild(bar);
}
