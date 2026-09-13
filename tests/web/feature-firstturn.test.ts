/**
 * @vitest-environment jsdom
 *
 * 「首轮对话」设置节:三段内容走 /api/prompts(firstTurn.* 三份 docs),
 * 开关走 /api/config 的 `context.firstTurn`。这一页没有自己的端点。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UI = '../../src/web/client/ui/index.ts';
const LIFECYCLE = '../../src/web/client/core/lifecycle.ts';
const ROUTER = '../../src/web/client/core/router.ts';
const FIRSTTURN = '../../src/web/client/features/firstturn/index.ts';

type Any = any;

const { createConsoleUi } = (await import(UI)) as Any;
const { Lifecycle } = (await import(LIFECYCLE)) as Any;
const { Router } = (await import(ROUTER)) as Any;
const { mountFirstTurn } = (await import(FIRSTTURN)) as Any;

const flush = async (n = 30): Promise<void> => { for (let i = 0; i < n; i++) await Promise.resolve(); };

const DOCS = {
  prompts: [
    { key: 'orientation', title: 'ORIENTATION', content: '定向', revision: 'r0' },
    { key: 'firstTurn.reply', title: '首轮·回复', content: '旧回复', revision: 'r3' },
    { key: 'firstTurn.user', title: '首轮·用户输入', content: '旧输入', revision: 'r1' },
    { key: 'firstTurn.thinking', title: '首轮·思维链', content: '', revision: 'r2' },
  ],
};

const CONFIG = {
  groups: [
    {
      group: {
        id: 'core',
        owner: 'core',
        schema: {
          type: 'object',
          title: '合批与 LLM 层',
          properties: {
            'context.firstTurn': { type: 'boolean', title: '合成首轮对话(风格锚)', 'x-hot': true },
          },
        },
      },
      values: { 'context.firstTurn': true },
    },
  ],
};

let calls: Array<{ url: string; method: string; body: Any }> = [];

function stub(opts: { docs?: unknown; config?: unknown } = {}): void {
  vi.stubGlobal('fetch', (url: unknown, init: Any) => {
    const u = String(url);
    const method = String(init?.method ?? 'GET');
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const body = method === 'POST'
      ? { ok: true, result: '已保存', revision: 'r-new' }
      : u === '/api/prompts' ? (opts.docs ?? DOCS)
        : u === '/api/config' ? (opts.config ?? CONFIG)
          : {};
    return Promise.resolve(new Response(JSON.stringify(body ?? {}), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
  });
}

function mkCtx(caps: Record<string, boolean> = { prompts: true, config: true, sessionControl: true }): Any {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const lifecycle = new Lifecycle(() => {});
  const ui = createConsoleUi({
    memo: { get: () => null, set: () => {} },
    overlayHost: document.body,
    signal: lifecycle.signal,
    doc: document,
  });
  return {
    ctx: {
      ui, root, lifecycle, signal: lifecycle.signal,
      capabilities: caps,
      route: { segments: ['settings'] },
      router: new Router({ win: window, onError: () => {} }),
      onError: () => {},
    },
    root,
  };
}

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('首轮对话设置节', () => {
  it('三段各一个文本域,按 user/thinking/reply 排序;开关按配置值勾上', async () => {
    stub();
    const { ctx, root } = mkCtx();
    await mountFirstTurn(ctx);
    await flush();

    const areas = [...root.querySelectorAll('textarea')] as HTMLTextAreaElement[];
    expect(areas).toHaveLength(3);
    expect(areas[0].value).toBe('旧输入');
    expect(areas[1].value).toBe('');
    expect(areas[2].value).toBe('旧回复');
    // 与 firstTurn 无关的 docs 不渲染
    expect(root.textContent).not.toContain('ORIENTATION');

    const check = root.querySelector('input[type=checkbox]') as HTMLInputElement;
    expect(check).toBeTruthy();
    expect(check.checked).toBe(true);
  });

  it('保存只提交改过的段,带 baseRevision;保存后提示重载', async () => {
    stub();
    const { ctx, root } = mkCtx();
    await mountFirstTurn(ctx);
    await flush();

    const areas = [...root.querySelectorAll('textarea')] as HTMLTextAreaElement[];
    areas[0].value = '新输入';
    const save = [...root.querySelectorAll('button')].find((b) => b.textContent === '保存')!;
    save.click();
    await flush();

    const posts = calls.filter((c) => c.method === 'POST' && c.url === '/api/prompts');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ key: 'firstTurn.user', content: '新输入', baseRevision: 'r1' });
    expect(root.textContent).toContain('重载');
  });

  it('拨开关即写 /api/config(x-hot,不用等保存)', async () => {
    stub();
    const { ctx, root } = mkCtx();
    await mountFirstTurn(ctx);
    await flush();

    const check = root.querySelector('input[type=checkbox]') as HTMLInputElement;
    check.checked = false;
    check.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    const posts = calls.filter((c) => c.method === 'POST' && c.url === '/api/config');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ group: 'core', values: { 'context.firstTurn': false } });
  });

  it('Persona没有 firstTurn.* 源时给空态,不渲染表单', async () => {
    stub({ docs: { prompts: [{ key: 'orientation', title: 'O', content: '', revision: 'r' }] } });
    const { ctx, root } = mkCtx();
    await mountFirstTurn(ctx);
    await flush();
    expect(root.querySelectorAll('textarea')).toHaveLength(0);
    expect(root.textContent).toContain('没有提供首轮对话源');
  });

  it('没有 config capability 时不画开关,内容照常可编辑', async () => {
    stub();
    const { ctx, root } = mkCtx({ prompts: true });
    await mountFirstTurn(ctx);
    await flush();
    expect(root.querySelector('input[type=checkbox]')).toBeNull();
    expect(root.querySelectorAll('textarea')).toHaveLength(3);
    // 没有 config 能力就不该有 /api/config 的请求
    expect(calls.some((c) => c.url === '/api/config')).toBe(false);
  });
});
