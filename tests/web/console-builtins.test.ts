/**
 * 内置面板的挂载路径。
 *
 * 声明了 `panel.builtin` 的面板由内核那张自带的表提供实现,整条路**不碰扩展加载器**
 * ——这正是外部 npm 包形态的贡献方能用上通用面板的前提:它交不出浏览器产物。
 * 于是"一页的面板全是内置时没有 client 也正常"不是容错,是这条路的定义。
 *
 * 规格存变量的动态 import 与 jsdom 手工建 document 同 `provider-settings-fixture.ts`:
 * 让根 tsconfig 不把这些 DOM 代码拉进 Node 侧的文件表。
 */
import { describe, expect, it, vi } from 'vitest';

const HOST = '../../src/web/client/console-pages/host.ts';
const LOADER = '../../src/web/client/console-pages/loader.ts';
const BUILTINS = '../../src/web/client/console-pages/builtins.ts';
const JSDOM_MODULE = 'jsdom';

type Any = any;

const { ConsolePageHost } = (await import(HOST)) as Any;
const { ConsolePageLoader } = (await import(LOADER)) as Any;
const { BUILTIN_PANELS } = (await import(BUILTINS)) as Any;
const { JSDOM } = (await import(JSDOM_MODULE)) as Any;

const dom = new JSDOM('<!doctype html><body></body>');
/**
 * jsdom 按 realm 校验 `addEventListener` 的 `signal`:Node 全局那个 AbortController
 * 造出来的 signal 会被这份 document 当成非法参数拒收,而页头的页签正是这么挂监听的。
 */
vi.stubGlobal('AbortController', dom.window.AbortController);

/** 内核自带的那张表在测试里换成一张假的:这一组验的是挂载路径,不是某块面板。 */
const FAKE_BUILTINS = {
  'demo-settings': {
    mount: (ctx: Any) => { ctx.root.appendChild(ctx.ui.msgline('内置面板挂上了')); },
  },
};

const BUNDLE_JS = '/assets/providers/llm-beta-A1B2.js';

/** 全是内置面板,**没有** client:这一页压根没构建出浏览器产物。 */
const ALL_BUILTIN = {
  id: 'llm:alpha', kind: 'llm', label: '甲端点', availability: 'active',
  panels: [{ id: 'settings', title: '实例与模型', builtin: 'demo-settings' }],
};
/** 内置 + 自有各一块,两条路在同一页上并存。 */
const MIXED = {
  id: 'llm:beta', kind: 'llm', label: '乙端点', availability: 'active',
  panels: [
    { id: 'settings', title: '实例与模型', builtin: 'demo-settings' },
    { id: 'own', title: '自有面板' },
  ],
  client: { js: BUNDLE_JS },
};
/** 内核不认识的名字。 */
const UNKNOWN_BUILTIN = {
  id: 'llm:gamma', kind: 'llm', label: '丙端点', availability: 'active',
  panels: [{ id: 'settings', title: '实例与模型', builtin: 'nope' }],
};

function stage(pages: unknown[]) {
  const doc = dom.window.document as Any;
  doc.body.replaceChildren();
  const root = doc.createElement('div');
  const overlayHost = doc.createElement('div');
  doc.body.append(root, overlayHost);
  const imported: string[] = [];
  const errors: unknown[] = [];
  const loader = new ConsolePageLoader({
    importModule: async (url: string) => {
      imported.push(url);
      return {
        default: {
          panels: {
            own: { mount: (ctx: Any) => { ctx.root.appendChild(ctx.ui.msgline('自有面板挂上了')); } },
          },
        },
      };
    },
    styleHost: { appendChild: () => {} },
    createLink: () => ({ rel: '', href: '', dataset: {} }),
  });
  const host = new ConsolePageHost({
    doc,
    root,
    overlayHost,
    loader,
    builtins: FAKE_BUILTINS,
    router: { addLeaveGuard: () => ({ dispose: () => {} }), navigate: () => {} },
    fetchManifest: async () => ({
      protocolVersion: 1, providers: pages, framework: { capabilities: {} },
    }),
    memo: { get: (_k: string, fb: unknown): unknown => fb, set: () => {} },
    createSocket: () => ({ close: () => {}, send: () => {} }),
    wsUrl: (p: string) => `ws://test${p}`,
    onError: (err: unknown) => { errors.push(err); },
  });
  return { host, imported, errors, text: (): string => root.textContent };
}

describe('内置面板的挂载', () => {
  it('全是内置面板的页没有 client 也照常挂上,加载器一次都没被调到', async () => {
    const s = stage([ALL_BUILTIN]);
    await s.host.load();
    await s.host.show('llm:alpha', 'settings');
    expect(s.text()).toContain('内置面板挂上了');
    expect(s.imported).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  it('同一页里内置与自有面板各走各的路', async () => {
    const s = stage([MIXED]);
    await s.host.load();
    await s.host.show('llm:beta', 'settings');
    expect(s.text()).toContain('内置面板挂上了');
    expect(s.imported).toEqual([]);

    await s.host.show('llm:beta', 'own');
    expect(s.text()).toContain('自有面板挂上了');
    expect(s.imported).toEqual([BUNDLE_JS]);
  });

  it('未知内置面板显示可用面板列表，其他页面仍可挂载', async () => {
    const s = stage([UNKNOWN_BUILTIN, MIXED]);
    await s.host.load();
    await expect(s.host.show('llm:gamma', 'settings')).resolves.toBeUndefined();
    expect(s.text()).toContain('内置面板「nope」不存在');
    expect(s.text()).toContain('demo-settings');
    expect(s.errors).toHaveLength(1);
    expect(s.imported).toEqual([]);

    await s.host.show('llm:beta', 'settings');
    expect(s.text()).toContain('内置面板挂上了');
    expect(s.text()).not.toContain('nope');
  });
});

describe('内核自带的那张表', () => {
  it('端点表面板在表里,键就是服务端声明的那个名字', () => {
    expect(Object.keys(BUILTIN_PANELS)).toContain('llm-settings');
    expect(typeof BUILTIN_PANELS['llm-settings'].mount).toBe('function');
  });
});
