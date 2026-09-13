/**
 * 新增 IO / 人格时 `src/web/**` 零 diff 的硬验收，机械化。
 *
 * ```
 * 新增 IO：     改 src/worlds/new/**、bot 装配、 World 目录、配置默认值
 *              diff src/web/**  → EMPTY
 * 新增 Persona：改 bots/new/**、launcher 注册
 *              diff src/web/**  → EMPTY
 * ```
 *
 * 在此之前这两条只是文档里的一段话。写成测试有一个陷阱要绕开：**用假件与静态断言
 * 是验不出边界的**——假件可以被特殊对待，静态断言只能证明"某个字符串没出现"。
 * 所以这份测试选了更贵但更真的做法：
 *
 * 1. **在真仓库里真的造出两个 provider 目录**（`src/worlds/zzz-acceptance/console/client.ts`
 *    与 `bots/zzz-acceptance/console/client.ts`），跑完在 `finally` 里删干净。验的
 *    因此是真实的目录约定发现，而不是临时仓骨架里的一份模仿。
 * 2. **逐段走完真链路**：构建发现（`discoverEntries`）→ 装配适配
 *    （`ioPageContribution` / `personaPageContribution` + `mergePersonaContributions`）
 *    → 协议校验（`validateContributions`）→ 真 esbuild 出产物 → 真 `WebApp` 起服务
 *    → `GET /api/console/manifest` → `POST` 打面板。中间没有一步是 mock。
 * 3. **零 diff 的证明方式是内容哈希**，不是 `git status`。仓库本来就可能有未提交
 *    改动，`git diff --name-only src/web` 会把它们一并算进来，那条断言就只能在
 *    干净工作树上成立——**验收不该依赖工作树状态**。这里改成：测试开始前把
 *    `src/web/**` 每个文件的 sha256 记下来，链路跑完再算一次，断言两次完全相同。
 *
 *    这条断言的已知局限，写在明处：它只能证明**这条链路没有逼着谁去改框架**，
 *    不能证明"没人偷偷改过框架"。真去改了 `src/web/**` 再让新 provider 跑通的话，
 *    改动会先落在提交里，快照的两次都包含它——这里照样绿。那种情形归
 *    `tests/web/architecture.test.ts` 的 Guard A/B（框架源码里不许出现具体 World 名）
 *    与人工评审管，两者是互补的，不是重复的。同理，若另一个执行者在本文件跑的
 *    这两三秒内正好写了 `src/web/**`，这条会红——那是误报，看一眼 git 就能分辨。
 *
 * 另外两组是"硬化那一路点名缺的"：
 *
 * - **验收件 World 的贯通**：`src/worlds/console-fixture` 是仓库里的活体验收件，先前只活在
 *   单测的引用里，没人验证它真的能被构建发现、真的能产出 asset 条目。
 * - **前端对结构性坏 manifest 的容忍**：服务端已经挡住这些形状（`validateContributions`
 *   会把整个 provider 丢掉），但**前端拿到时会怎样**从来没定义过。这里驱动真的
 *   `ConsolePageHost` 把它喂进去，记录现状。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildWeb, discoverEntries } from '../../scripts/build-web.ts';
import type { ConsoleAssetManifest } from '../../src/web/shared/console-protocol.ts';
import { WebApp, type WebAppDeps } from '../../src/web/server.ts';
import {
  deriveConsolePageSources,
  ioPageContribution,
  mergePersonaContributions,
  personaPageContribution,
} from '../../src/bot.ts';
import { WorldAssembly } from '../../src/world.ts';
import {
  panelRoute,
  pageIdFor,
  validateContributions,
  type ConsoleManifest,
  type ConsolePageContribution,
} from '../../src/web/shared/console-protocol.ts';
import type {
  World, WorldConsoleDecl, PersonaConsoleDecl, Persona, ToolDef,
} from '../../src/core/types.ts';
import { ConsoleFixtureWorld } from '../../src/worlds/console-fixture/world.ts';
import { nullLogger } from '../../src/core/util.ts';
import { FakeStore } from './fakes.ts';

const REPO = resolve(import.meta.dirname, '../..');

/**
 * 临时 provider 的名字。`zzz-` 前缀有两个作用：目录排序时永远在最后（不打断
 * 真 World 的顺序），以及一眼看得出它不是真东西。
 */
const IO_NAME = 'zzz-acceptance';
const BOT_NAME = 'zzz-acceptance';
const IO_PROVIDER = pageIdFor('world', IO_NAME);
const PERSONA_PROVIDER = pageIdFor('persona', BOT_NAME);
/** 仓库里那个常驻的活体验收件。 */
const FIXTURE_PROVIDER = pageIdFor('world', 'console-fixture');

const IO_DIR = join(REPO, 'src', 'worlds', IO_NAME);
const BOT_DIR = join(REPO, 'bots', BOT_NAME);
const IO_ENTRY = join(IO_DIR, 'console', 'client.ts');
const BOT_ENTRY = join(BOT_DIR, 'console', 'client.ts');

// ---------------------------------------------------------------------------
// 临时 provider 的源码
// ---------------------------------------------------------------------------

/**
 * 扩展源码。刻意写成与真 provider 一模一样的形状：只 `import type` 一份契约、
 * 只经 `ctx` 借东西——`tests/web/architecture.test.ts` 的 Guard F 会在它存在的
 * 这几秒里一起扫到它，写歪了那边就红，那正是"它是真 provider"的另一个证据。
 */
const bundleSource = (contractPath: string, mark: string): string =>
  `/**
 * 临时验收 provider 的浏览器扩展。由 tests/web/acceptance-zero-diff.test.ts 造出来，
 * 跑完即删。它不属于任何 bot，也不会被激活。
 */
import type { ConsoleClientBundle, ConsolePanelContext } from '${contractPath}';

const bundle: ConsoleClientBundle = {
  panels: {
    hello: {
      mount(ctx: ConsolePanelContext) {
        ctx.root.appendChild(ctx.ui.msgline('${mark}'));
      },
    },
  },
};

export default bundle;
`;

const writeFile = (abs: string, text: string): void => {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
};

const dropTempProviders = (): void => {
  for (const d of [IO_DIR, BOT_DIR]) rmSync(d, { recursive: true, force: true });
};

// ---------------------------------------------------------------------------
// src/web/** 的内容指纹
// ---------------------------------------------------------------------------

const WEB_ROOT = join(REPO, 'src', 'web');

/** 一个文件一行：`相对路径  sha256`。排序后可直接 `toEqual`，差异一眼能读。 */
function webFingerprint(dir = WEB_ROOT): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...webFingerprint(abs));
    } else if (e.isFile()) {
      const rel = relative(WEB_ROOT, abs).split(sep).join('/');
      out.push(`${rel}  ${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
    }
  }
  return out.sort();
}

/** 造 provider 之前的那一份。链路跑完必须还是它。 */
let webBefore: string[] = [];

const expectWebUntouched = (): void => {
  expect(webFingerprint()).toEqual(webBefore);
};

// ---------------------------------------------------------------------------
// 真构建：把发现到的那几个入口用真 esbuild 打一遍
// ---------------------------------------------------------------------------

/**
 * 构建在**临时根**里做，不在真仓库里做。
 *
 * `buildWeb` 的第一件事是 `rm -rf <root>/dist/web` 再全量重打——对着真仓库跑，
 * 等于测试顺手把开发者的构建产物换成一份含临时 provider 的、马上就会过期的产物。
 * 临时根里放的是**`discoverEntries(真仓库)` 真找到的那几个入口文件本身**，
 * 所以走的仍是真发现 + 真 esbuild，只有落盘位置是临时的。
 */
let buildRoot: string;
let built: ConsoleAssetManifest;
const builtDist = (): string => join(buildRoot, 'dist', 'web');

async function buildDiscovered(keys: Set<string>): Promise<ConsoleAssetManifest> {
  for (const e of discoverEntries(REPO)) {
    if (!keys.has(e.key)) continue;
    const dest = join(buildRoot, relative(REPO, e.entry));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(e.entry, dest);
  }
  return buildWeb(buildRoot);
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 上一次跑崩了可能留下残骸;先清干净,否则基线快照会把它们算进"本来就有的"。
  dropTempProviders();
  webBefore = webFingerprint();

  writeFile(IO_ENTRY, bundleSource('../../web/shared/client-panel.ts', '新 IO 的面板挂上了'));
  writeFile(BOT_ENTRY, bundleSource('../../../src/web/shared/client-panel.ts', '新人格的面板挂上了'));

  buildRoot = mkdtempSync(join(tmpdir(), 'cortico-acceptance-build-'));
  built = await buildDiscovered(new Set([IO_PROVIDER, PERSONA_PROVIDER, FIXTURE_PROVIDER]));
}, 60_000);

afterAll(() => {
  dropTempProviders();
  if (buildRoot) rmSync(buildRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 起一个只挂 consolePageSources 的最小控制台(与 tests/web/providers.test.ts 同款)
// ---------------------------------------------------------------------------

async function withApp(
  extra: Partial<WebAppDeps>,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'cortico-acceptance-app-'));
  const deps: WebAppDeps = {
    store: new FakeStore(),
    memoryDir: dir,
    dataDir: dir,
    webDistDir: builtDist(),
    getStatus: () => ({}),
    log: nullLogger(),
    ...extra,
  };
  const app = new WebApp(deps);
  const port = await app.start(0);
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const manifestOf = async (base: string): Promise<ConsoleManifest> =>
  (await (await fetch(`${base}/api/console/manifest`)).json()) as ConsoleManifest;

const byId = (m: ConsoleManifest, id: string) => m.providers.find((p) => p.id === id);

/** `deriveConsolePageSources` 只要 core 的可见性事实。 */
const facts = (visibility: Record<string, boolean> = {}) => ({
  worldVisibility: () => ({ visibility, driftedWorlds: [] as string[] }),
});

/** 新 World 的环境提示词模板:契约要求文本住在文件里,新 World 也不例外。 */
const NEW_IO_TEMPLATE = join(mkdtempSync(join(tmpdir(), 'zzz-worlds-tpl-')), 'ENV_PROMPT.md');
writeFileSync(NEW_IO_TEMPLATE, '一个刚被装上的 World。', 'utf8');

/** 一个新 World 该写的全部东西:契约方法 + 一份 `console()` 声明。 */
class NewWorld implements World {
  readonly id = IO_NAME;
  calls: Array<{ panel: string; method: string; args: unknown[] }> = [];

  envPromptVars(): Record<string, string> {
    return {};
  }

  tools(): ToolDef[] {
    return [];
  }

  console(): WorldConsoleDecl {
    return {
      badges: [{ label: '状态', value: '刚装上', tone: 'on' }],
      panels: [{ id: 'hello', title: '打招呼', description: '新 World 自带的面板' }],
      invoke: async (panel, method, args) => {
        this.calls.push({ panel, method, args });
        return { from: this.id, panel, method, args };
      },
      promptDocs: [
        {
          key: `worlds.${this.id}.envPrompt`,
          title: '新 World · 环境提示词',
          description: '新 World 的常驻事实。',
          path: NEW_IO_TEMPLATE,
          role: 'envPrompt',
        },
      ],
    };
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

// 新增一个 IO

describe('新增一个 IO,src/web/** 零 diff', () => {
  it('第 1 步 · 目录一放好,构建发现自己收进来,asset key 由目录名推导', () => {
    const entries = discoverEntries(REPO);
    const mine = entries.find((e) => e.key === IO_PROVIDER);
    expect(mine).toBeDefined();
    expect(mine!.entry).toBe(IO_ENTRY);
    // key 是推导出来的,不是 World 自己指定的——这是服务端把 key 映射回 URL 的安全边界
    expect(mine!.key).toBe(`world:${IO_NAME}`);
    expectWebUntouched();
  });

  it('第 2 步 · 真 esbuild 打出产物,asset-manifest 里有它的条目', () => {
    const entry = built.providers[IO_PROVIDER];
    expect(entry).toBeDefined();
    expect(entry!.js).toMatch(/^\/assets\/providers\/world-zzz-acceptance-[A-Z0-9]+\.js$/i);
    expect(existsSync(join(builtDist(), entry!.js.replace('/assets/', '')))).toBe(true);
    expectWebUntouched();
  });

  it('第 3 步 · 装配适配:console() 声明变成一份合法贡献,协议校验干净', () => {
    const c = ioPageContribution(
      IO_NAME,
      '新 World',
      {
        id: IO_NAME, label: '新 World', status: 'active', declared: false,
        visible: true, prefixDrifted: false,
        workspace: `worlds/${IO_NAME}`, tools: [],
      },
      new NewWorld(),
    );
    expect(c.id).toBe(IO_PROVIDER);
    expect(c.kind).toBe('world');
    expect(c.panels).toEqual([
      { id: 'hello', title: '打招呼', description: '新 World 自带的面板' },
    ]);
    expect(validateContributions([c])).toEqual([]);
    expectWebUntouched();
  });

  it('第 4 步 · 真控制台:manifest 里出现它,面板/徽标/扩展资源一并到位', async () => {
    const mod = new NewWorld();
    const sources = deriveConsolePageSources(facts({ [IO_NAME]: true }), {
      assembly: WorldAssembly.ofInstances([mod], { labels: { [IO_NAME]: '新 World' }, declared: false }),
    });
    await withApp({ consolePageSources: sources }, async (base) => {
      const p = byId(await manifestOf(base), IO_PROVIDER);
      expect(p?.kind).toBe('world');
      expect(p?.label).toBe('新 World');
      expect(p?.availability).toBe('active');
      expect(p?.panels?.map((x) => x.title)).toEqual(['打招呼']);
      expect(p?.badges).toEqual([{ label: '状态', value: '刚装上', tone: 'on' }]);
      // 构建产物接回来了:前端进这一页时才会去 import 它
      expect(p?.client?.js).toBe(built.providers[IO_PROVIDER]!.js);
    });
    expectWebUntouched();
  });

  it('第 5 步 · 面板真能调用:POST 直达 World 自己的 invoke', async () => {
    const mod = new NewWorld();
    const sources = deriveConsolePageSources(facts({ [IO_NAME]: true }), { assembly: WorldAssembly.ofInstances([mod]) });
    await withApp({ consolePageSources: sources }, async (base) => {
      const r = await fetch(`${base}${panelRoute(IO_PROVIDER, 'hello', 'ping')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: [1, 'two'] }),
      });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({
        from: IO_NAME, panel: 'hello', method: 'ping', args: [1, 'two'],
      });
    });
    expect(mod.calls).toHaveLength(1);
    expectWebUntouched();
  });

  it('结论 · 整条链路跑完,src/web/** 一个字节都没变', () => {
    // 前面每一步都顺手验过一次;这条是把它当**结论**单独钉一遍,失败信息里
    // 会直接列出是哪个文件的哈希变了。
    expectWebUntouched();
    expect(webBefore.length).toBeGreaterThan(20); // 快照不是空的(否则上面全是废话)
  });
});

// 新增一个 Persona

/**
 * 人格侧有**两条接缝**：
 * `Persona.console?()` 出认知绑定的，`ConsoleContribution.consolePages()`
 * 出部署绑定的。两条以同一个 `persona:<bot>` 命名，由 `mergePersonaContributions`
 * 合成一个 provider —— 所以两条都要验，且要验它们合得起来。
 */
describe('新增一个 Persona,src/web/** 零 diff', () => {
  /** 认知绑定那半:Persona自报。只用得到 `console()`,其余契约不参与。 */
  const cognitiveHalf = (): Persona => {
    const decl: PersonaConsoleDecl = {
      badges: [{ label: '记忆', value: '3 层', tone: 'plain' }],
      panels: [{ id: 'memory', title: '记忆视图' }],
      invoke: async (panel, method) => ({ half: 'core', panel, method }),
    };
    // 只读 `console()`：`personaPageContribution` 不碰 Persona 的其余方法，
    // 为一条边界验收造一份完整Persona，反而会把"接控制台要写多少代码"说糊。
    return { console: () => decl } as unknown as Persona;
  };

  /** 部署绑定那半:装配层经 `consolePages()` 交出来的。 */
  const deploymentHalf = (): ConsolePageContribution => ({
    id: PERSONA_PROVIDER,
    kind: 'persona',
    label: 'ZZZ 验收人格',
    panels: [{ id: 'models', title: '模型档位' }],
    invoke: async (panel, method) => ({ half: 'deploy', panel, method }),
  });

  it('第 1 步 · 目录一放好,构建发现自己收进来,key 是 persona:<bot 名>', () => {
    const mine = discoverEntries(REPO).find((e) => e.key === PERSONA_PROVIDER);
    expect(mine).toBeDefined();
    expect(mine!.entry).toBe(BOT_ENTRY);
    expectWebUntouched();
  });

  it('第 2 步 · 真 esbuild 打出产物,asset-manifest 里有它的条目', () => {
    const entry = built.providers[PERSONA_PROVIDER];
    expect(entry).toBeDefined();
    expect(entry!.js).toMatch(/^\/assets\/providers\/persona-zzz-acceptance-[A-Z0-9]+\.js$/i);
    expect(existsSync(join(builtDist(), entry!.js.replace('/assets/', '')))).toBe(true);
    expectWebUntouched();
  });

  it('第 3 步 · 两条接缝各出一半,合成一个 provider,协议校验干净', () => {
    const core = personaPageContribution(BOT_NAME, 'ZZZ 验收人格', cognitiveHalf());
    expect(core?.id).toBe(PERSONA_PROVIDER);
    expect(core?.kind).toBe('persona');

    const merged = mergePersonaContributions(
      PERSONA_PROVIDER, 'ZZZ 验收人格', core, [deploymentHalf()],
    );
    expect(merged?.panels?.map((p) => p.id)).toEqual(['memory', 'models']);
    expect(validateContributions([merged!])).toEqual([]);
    expectWebUntouched();
  });

  it('第 4 步 · 合并后的 invoke 按面板归属分派,两半互不知道对方存在', async () => {
    const merged = mergePersonaContributions(
      PERSONA_PROVIDER, 'ZZZ 验收人格',
      personaPageContribution(BOT_NAME, 'ZZZ 验收人格', cognitiveHalf()),
      [deploymentHalf()],
    )!;
    expect(await merged.invoke!('memory', 'state', [])).toEqual({
      half: 'core', panel: 'memory', method: 'state',
    });
    expect(await merged.invoke!('models', 'state', [])).toEqual({
      half: 'deploy', panel: 'models', method: 'state',
    });
    expectWebUntouched();
  });

  it('第 5 步 · 真控制台:manifest 里出现 persona provider,两半的面板都在,扩展资源到位', async () => {
    const sources = deriveConsolePageSources(
      facts(),
      { assembly: WorldAssembly.ofInstances([]), persona: cognitiveHalf() },
      { id: BOT_NAME, label: 'ZZZ 验收人格' },
      () => [deploymentHalf()],
    );
    await withApp({ consolePageSources: sources }, async (base) => {
      const m = await manifestOf(base);
      const p = byId(m, PERSONA_PROVIDER);
      expect(p?.kind).toBe('persona');
      expect(p?.label).toBe('ZZZ 验收人格');
      expect(p?.panels?.map((x) => x.id)).toEqual(['memory', 'models']);
      expect(p?.client?.js).toBe(built.providers[PERSONA_PROVIDER]!.js);
      // 两条接缝合成的是**一个** provider,不是两个
      expect(m.providers.filter((x) => x.kind === 'persona')).toHaveLength(1);

      const r = await fetch(`${base}${panelRoute(PERSONA_PROVIDER, 'models', 'state')}`);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ half: 'deploy', panel: 'models', method: 'state' });
    });
    expectWebUntouched();
  });

  it('结论 · 整条链路跑完,src/web/** 一个字节都没变', () => {
    expectWebUntouched();
  });
});

// ===========================================================================
// 活体验收件:src/worlds/console-fixture 真的进得了构建
// ===========================================================================

/**
 * `src/worlds/console-fixture` 存在的意义是"证明新增 IO 不用改框架"，但它先前只被
 * 单测按文件路径 import 过——**没有人验证过它真的能被构建发现、真的能打出产物**。
 * 一个进不了构建的验收件是自欺：它证明的是"这份源码存在"，不是"这条路走得通"。
 */
describe('活体验收件 · src/worlds/console-fixture 的贯通', () => {
  it('构建按目录约定发现它,key 是 worlds:console-fixture', () => {
    const mine = discoverEntries(REPO).find((e) => e.key === FIXTURE_PROVIDER);
    expect(mine).toBeDefined();
    expect(mine!.entry).toBe(join(REPO, 'src', 'worlds', 'console-fixture', 'console', 'client.ts'));
  });

  it('它真能打出 asset 条目(不是"源码在那儿"而已)', () => {
    const entry = built.providers[FIXTURE_PROVIDER];
    expect(entry).toBeDefined();
    expect(existsSync(join(builtDist(), entry!.js.replace('/assets/', '')))).toBe(true);
  });

  it('World 这一侧同样贯通:声明 → 贡献 → manifest → 调用', async () => {
    const mod = new ConsoleFixtureWorld();
    const c = ioPageContribution(mod.id, '控制台验收件', undefined, mod);
    expect(c.panels?.map((p) => p.id)).toEqual(['hello', 'echo']);
    expect(validateContributions([c])).toEqual([]);

    const sources = deriveConsolePageSources(facts({ [mod.id]: true }), {
      assembly: WorldAssembly.ofInstances([mod], { labels: { [mod.id]: '控制台验收件' }, declared: false }),
    });
    await withApp({ consolePageSources: sources }, async (base) => {
      const p = byId(await manifestOf(base), FIXTURE_PROVIDER);
      expect(p?.panels?.map((x) => x.id)).toEqual(['hello', 'echo']);
      expect(p?.client?.js).toBe(built.providers[FIXTURE_PROVIDER]!.js);

      const r = await fetch(`${base}${panelRoute(FIXTURE_PROVIDER, 'hello', 'ping')}`);
      expect(r.status).toBe(200);
      expect((await r.json() as { pings: number }).pings).toBe(1);
    });
  });

  it('服务端声明的面板 id 与扩展 default export 的键一一对应', async () => {
    const FIXTURE_BUNDLE = pathToFileURL(
      join(builtDist(), built.providers[FIXTURE_PROVIDER]!.js.slice('/assets/'.length)),
    ).href;
    const bundle = ((await import(FIXTURE_BUNDLE)) as any).default;
    const declared = ioPageContribution(
      'console-fixture', '控制台验收件', undefined, new ConsoleFixtureWorld(),
    ).panels!.map((p) => p.id);
    expect(Object.keys(bundle.panels).sort()).toEqual([...declared].sort());
    for (const id of declared) expect(typeof bundle.panels[id].mount).toBe('function');
  });
});

// ===========================================================================
// 前端对结构性坏 manifest 的容忍
// ===========================================================================

/**
 * 服务端已经挡住这些形状：`validateContributions` 会把声明不合法的 provider
 * **整个丢掉**，坏 manifest 出不了服务端。但"服务端挡住了"不等于"前端定义过拿到
 * 时该怎么办"——manifest 也可能来自旧版本的服务端、来自中间层、或者某天协议加了
 * 字段而校验没跟上。
 *
 * 这一组因此只问一个问题：**坏的那一条会不会把整页带走。** 判据是"框架其余部分
 * 照常"，不是"坏的那条也能渲染"——后者不可能，也不该追求。
 *
 * 三条环境约定与 `tests/web/hardening-console.test.ts` 一致（specifier 存变量、
 * 手写迷你 DOM、不引 jsdom）；迷你 DOM 只实现被测代码真的用到的那几样。
 */

const HOST_SPEC = '../../src/web/client/console-pages/host.ts';
const LOADER_SPEC = '../../src/web/client/console-pages/loader.ts';

type Any = any;

const { ConsolePageHost } = (await import(HOST_SPEC)) as Any;
const { ConsolePageLoader } = (await import(LOADER_SPEC)) as Any;

type Listener = (ev: Any) => void;
interface ListenOptions { signal?: AbortSignal; once?: boolean }

class Listeners {
  private map = new Map<string, Listener[]>();

  add(type: string, fn: Listener, opts?: ListenOptions): void {
    if (opts?.signal?.aborted) return;
    const wrapped: Listener = opts?.once ? (ev) => { this.remove(type, wrapped); fn(ev); } : fn;
    const arr = this.map.get(type) ?? [];
    arr.push(wrapped);
    this.map.set(type, arr);
    opts?.signal?.addEventListener('abort', () => this.remove(type, wrapped), { once: true });
  }

  remove(type: string, fn: Listener): void {
    const arr = this.map.get(type) ?? [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
    this.map.set(type, arr);
  }
}

class FakeEl {
  readonly tagName: string;
  readonly ownerDocument: FakeDoc;
  readonly nodeType = 1;
  className = '';
  type = '';
  open = false;
  value = '';
  disabled = false;
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  attrs = new Map<string, string>();
  listeners = new Listeners();
  ownText = '';

  constructor(tag: string, doc: FakeDoc) {
    this.tagName = tag;
    this.ownerDocument = doc;
  }

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.children = [];
    this.ownText = v;
  }

  appendChild(node: FakeEl): FakeEl {
    node.parent?.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = this;
    this.children.push(node);
    return node;
  }
  append(...nodes: FakeEl[]): void {
    for (const n of nodes) this.appendChild(n);
  }
  replaceChildren(...nodes: FakeEl[]): void {
    for (const c of this.children) c.parent = null;
    this.children = [];
    for (const n of nodes) this.appendChild(n);
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  focus(): void {}
  addEventListener(type: string, fn: Listener, opts?: ListenOptions): void {
    this.listeners.add(type, fn, opts);
  }
  removeEventListener(type: string, fn: Listener): void { this.listeners.remove(type, fn); }
  dispatchEvent(): void {}
}

class FakeDoc {
  listeners = new Listeners();
  body: FakeEl;
  defaultView: Any = undefined;
  constructor() { this.body = new FakeEl('body', this); }
  createElement(tag: string): FakeEl { return new FakeEl(tag, this); }
  addEventListener(type: string, fn: Listener, opts?: ListenOptions): void {
    this.listeners.add(type, fn, opts);
  }
  removeEventListener(type: string, fn: Listener): void { this.listeners.remove(type, fn); }
}

interface BadStage {
  host: Any;
  root: FakeEl;
  errors: unknown[];
  text(): string;
}

/** 一个真 `ConsolePageHost` + 真 `ConsolePageLoader`，只有取 manifest 与 import 是假的。 */
function stageWith(providers: unknown[]): BadStage {
  const doc = new FakeDoc();
  const root = doc.createElement('div');
  const overlayHost = doc.createElement('div');
  doc.body.append(root, overlayHost);
  const errors: unknown[] = [];
  const loader = new ConsolePageLoader({
    importModule: async () => ({
      default: {
        panels: {
          ok: { mount: (ctx: Any) => { ctx.root.appendChild(ctx.ui.msgline('好 provider 的面板挂上了')); } },
        },
      },
    }),
    styleHost: { appendChild: () => {} },
    createLink: () => ({ rel: '', href: '', dataset: {} as Record<string, string> }),
  });
  const host = new ConsolePageHost({
    doc,
    root,
    overlayHost,
    loader,
    router: { addLeaveGuard: () => ({ dispose: () => {} }), navigate: () => {} },
    fetchManifest: async () => ({ protocolVersion: 1, providers, framework: { capabilities: {} } }),
    memo: { get: (_k: string, fb: unknown): unknown => fb, set: () => {} },
    createSocket: () => ({ close: () => {}, send: () => {} }),
    wsUrl: (p: string) => `ws://test${p}`,
    onError: (err: unknown) => { errors.push(err); },
  });
  return { host, root, errors, text: () => root.textContent };
}

/** 永远合法的那一个，用来验"框架其余部分照常"。 */
const GOOD = {
  id: 'world:good',
  kind: 'world',
  label: '好 provider',
  availability: 'active',
  panels: [{ id: 'ok', title: '正常面板' }],
  client: { js: '/assets/providers/worlds-good-AAAA.js' },
};

const badStage = (bad: Record<string, unknown>): BadStage =>
  stageWith([{ id: 'world:bad', kind: 'world', label: '坏 provider', availability: 'active', ...bad }, GOOD]);

/** 坏 provider 的每一种形状；`show()` 抛不抛都接住,本组问的不是它。 */
async function tryShow(stage: BadStage, id: string, panel?: string): Promise<unknown | null> {
  try {
    await stage.host.show(id, panel);
    return null;
  } catch (err) {
    return err;
  }
}

describe('前端对结构性坏 manifest 的容忍', () => {
  const BAD_SHAPES: Array<[string, Record<string, unknown>]> = [
    ['panels 是字符串', { panels: 'nope' }],
    ['panels 是对象', { panels: { ok: true } }],
    ['panels 是数字', { panels: 42 }],
    ['panels 元素是 null', { panels: [null, { id: 'ok', title: '正常' }] }],
    ['badges 元素是 null', { badges: [null, { label: '在线', value: 1 }], panels: [{ id: 'ok', title: '正常' }] }],
    ['badges 不是数组', { badges: 'nope', panels: [{ id: 'ok', title: '正常' }] }],
    ['links 缺 href', { links: [{ label: '打开' }], panels: [{ id: 'ok', title: '正常' }] }],
    ['links 元素是 null', { links: [null], panels: [{ id: 'ok', title: '正常' }] }],
  ];

  it('坏 provider 与好 provider 同在一份 manifest 里:load() 不整个失败', async () => {
    for (const [name, bad] of BAD_SHAPES) {
      const stage = badStage(bad);
      await stage.host.load();
      // 导航数据面还在:坏的那一条不该让整份 manifest 作废
      expect([name, stage.host.pages.map((p: Any) => p.id)]).toEqual([name, ['world:bad', 'world:good']]);
    }
  });

  /**
   * **本组的核心断言。** 先进坏的那一格（爱怎么坏怎么坏），再进好的那一格，
   * 好的必须照常挂上。这条要是红，说明一条坏 manifest 能把整个控制台带死。
   */
  it('进过坏 provider 之后,好 provider 照常挂载(框架没被带死)', async () => {
    for (const [name, bad] of BAD_SHAPES) {
      const stage = badStage(bad);
      await stage.host.load();
      await tryShow(stage, 'world:bad');
      await tryShow(stage, 'world:bad', 'ok');

      await stage.host.show('world:good', 'ok');
      expect([name, stage.text().includes('好 provider 的面板挂上了')]).toEqual([name, true]);
      expect([name, stage.text().includes('坏 provider')]).toEqual([name, false]);
    }
  });

  it('坏了之后再取一次 manifest 照常,不会卡死在坏状态', async () => {
    for (const [name, bad] of BAD_SHAPES) {
      const stage = badStage(bad);
      await stage.host.load();
      await tryShow(stage, 'world:bad');
      await expect(stage.host.load()).resolves.toBeUndefined();
      expect([name, stage.host.pages.length]).toEqual([name, 2]);
    }
  });

  /**
   * ConsolePageHost.show() 的异常隔离涵盖页头渲染、面板解析和扩展挂载。
   * manifest 形状无效时也须呈现错误卡，避免调用点产生未处理的 rejection。
   */
  it('没有任何坏形状能让 show() 抛出去', async () => {
    const throwsBy: string[] = [];
    for (const [name, bad] of BAD_SHAPES) {
      const stage = badStage(bad);
      await stage.host.load();
      if (await tryShow(stage, 'world:bad')) throwsBy.push(name);
    }
    expect(throwsBy).toEqual([]); // tryShow 抛了才进这个表
  });

  it('可迭代的垃圾也不当数组用:badges 是字符串时不画出一排 undefined', async () => {
    // `for...of 'nope'` 逐字符跑不会抛,只会画出四颗写着 "undefined undefined"
    // 的徽标。可迭代的坏值比不可迭代的坏值更难查,所以迭代前先确认真是数组。
    const stage = badStage({ badges: 'nope' as never });
    await stage.host.load();
    expect(await tryShow(stage, 'world:bad')).toBeNull();
    expect(stage.text()).not.toContain('undefined');
  });
});
