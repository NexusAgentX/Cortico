import { records } from './fixture-protocol.ts';
/**
 * 认知外包 hook(host.cognition)。
 *
 * 这条路上的主权划分是被测的东西本身:
 *  - World 给 brief 和**自己的**工具名,想不出别的花样——它点不动别人的工具,
 *    也开不出自己的意识面;
 *  - Persona定头/档/预算/开关,没实现或开关关着,World host 上**根本没有这个句柄**;
 *  - core 只做机械三件事:注入、白名单校验、并发记账。用量归账搭 spawnFork
 *    那条既有的路(SessionDecl 自带),不在这里重记一遍。
 *
 * 全程不碰真 LLM:人格实现是 mock,fork 走 FakeLLM。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Core } from "./fixture-core.ts";
import type {
  CognitionContext,
  CognitionRequest,
  CoreApi,
  World,
  WorldHost,
  PersonaCognition,
  SessionDecl,
  ToolDef,
} from '../../src/core/types.ts';
import {
  activeSpec,
  FakeLLM,
  makeCfg,
  makeFakeIO,
  makeFakePersona,
  makeLoaded,
  makeTmpDir,
  makeTool,
  textReply,
  sleep,
} from './helpers.ts';

/** 一个能把 core 交给它的 host 留住的假 World(host 只在 start 时给一次) */
function makeProbe(id: string, tools: ToolDef[]): { mod: World; host: () => WorldHost } {
  const base = makeFakeIO(id, tools);
  let captured: WorldHost | null = null;
  const mod: World = {
    ...base,
    start: async (h: WorldHost) => {
      captured = h;
      await base.start(h);
    },
  };
  return {
    mod,
    host: () => {
      if (!captured) throw new Error(`${id} 还没 start`);
      return captured;
    },
  };
}

/** Persona声明的那个受理 session(core 只拿它查表) */
const cognitionDecl: SessionDecl = {
  id: 'cognition',
  label: '认知外包',
  rounds: () => ({ soft: 2, hard: 3 }),
  persistent: false,
  receivesEvents: false,
  tools: () => [],
};

interface Rig {
  core: Core;
  llm: FakeLLM;
  api: CoreApi;
  host: () => WorldHost;
  otherHost: () => WorldHost;
  cleanup: () => Promise<void>;
}

/**
 * 两个 World:mc(有两把自己的工具)与 other(有一把,专供越权测试点名)。
 * 人格用 silent 档——时机钩子一句话不注入,主循环因此不被唤醒,
 * FakeLLM 的调用记录里只会有 fork 自己的那些。
 */
async function rig(cognition?: PersonaCognition): Promise<Rig> {
  const tmp = makeTmpDir();
  const config = makeCfg();
  config.worlds.qq.enabled = false;
  const loaded = makeLoaded({
    config,
    rootDir: tmp.dir,
    memoryDir: `${tmp.dir}/persona`,
    dataDir: `${tmp.dir}/data`,
  });
  const mc = makeProbe('mc', [makeTool('mc_blueprint', '蓝图收下了'), makeTool('mc_goal', '目标收下了')]);
  const other = makeProbe('other', [makeTool('other_send', 'ok')]);
  const persona = makeFakePersona([], {
    cfg: config,
    silent: true,
    worlds: [mc.mod, other.mod],
    extraSessions: [cognitionDecl],
  });
  if (cognition) persona.cognition = cognition;
  let api: CoreApi | null = null;
  const attach = persona.attach.bind(persona);
  persona.attach = (h) => {
    api = h;
    attach(h);
  };
  const llm = new FakeLLM();
  const core = new Core(loaded, { persona, worlds: [mc.mod, other.mod], llm });
  await core.start();
  await sleep(20);
  return {
    core,
    llm,
    api: api!,
    host: mc.host,
    otherHost: other.host,
    cleanup: async () => {
      await core.stop();
      tmp.cleanup();
    },
  };
}

let live: Rig | null = null;
afterEach(async () => {
  await live?.cleanup();
  live = null;
});

describe('认知外包 · 注入与开关', () => {
  it('Persona没提供实现 = World host 上根本没有这个句柄(不是返回 error)', async () => {
    live = await rig();
    expect(live.host().cognition).toBeUndefined();
    // World 据此走降级路径,判断方式就是这一句
    expect(Boolean(live.host().cognition)).toBe(false);
  });

  it('全局开关关着也是句柄不存在,且每次现读——热改立即生效', async () => {
    let on = false;
    live = await rig({
      enabled: () => on,
      request: async () => ({ text: '想完了' }),
    });
    expect(live.host().cognition).toBeUndefined();
    on = true;
    expect(live.host().cognition).toBeDefined();
    on = false;
    expect(live.host().cognition).toBeUndefined();
  });

  it('提供实现:World 能调,拿回文本;brief 与 hint 原样透传,人格可否决量级', async () => {
    const seen: Array<{ req: CognitionRequest; ctx: CognitionContext }> = [];
    live = await rig({
      request: async (req, ctx) => {
        seen.push({ req, ctx });
        // 人格可以完全无视 hint(这里就无视了),core 不替它把关
        return { text: `想完了:${req.brief}` };
      },
    });

    const out = await live.host().cognition!.request({
      brief: '盖一间会呼吸的小屋',
      hint: { rounds: 8 },
    });

    expect(out).toEqual({ text: '想完了:盖一间会呼吸的小屋' });
    expect(seen).toHaveLength(1);
    expect(seen[0].req.brief).toBe('盖一间会呼吸的小屋');
    expect(seen[0].req.hint).toEqual({ rounds: 8 });
    expect(seen[0].ctx.worldId).toBe('mc');
    expect(seen[0].ctx.tools).toEqual([]);
  });

  it('brief 是空的 = 机械驳回,不惊动Persona', async () => {
    let called = 0;
    live = await rig({
      request: async () => {
        called++;
        return { text: '不该到这儿' };
      },
    });
    const out = await live.host().cognition!.request({ brief: '   ' });
    expect(out).toHaveProperty('error');
    expect(called).toBe(0);
  });

  it('人格实现抛错不炸穿 World:如实换成一句 error 交回去', async () => {
    live = await rig({
      request: async () => {
        throw new Error('这一档没配模型');
      },
    });
    const out = await live.host().cognition!.request({ brief: '想点什么' });
    expect(out).toEqual({ error: '这一档没配模型' });
  });
});

describe('认知外包 · 工具白名单(core 的机械校验)', () => {
  it('点名本 World 自己的工具:解析成定义本体交给人格,handler 可直接执行', async () => {
    let handed: ToolDef[] = [];
    live = await rig({
      request: async (_req, ctx) => {
        handed = ctx.tools;
        return { text: 'ok' };
      },
    });

    await live.host().cognition!.request({
      brief: '出一张图',
      tools: ['mc_blueprint', 'mc_goal'],
    });

    expect(handed.map((t) => t.name)).toEqual(['mc_blueprint', 'mc_goal']);
    const ran = await handed[0].handler({}, { role: 'cognition', log: live.core.runlog.logger('t') });
    expect(ran).toBe('蓝图收下了');
  });

  it('点名别的 World 的工具 = {error},且人格实现根本没被调用', async () => {
    let called = 0;
    live = await rig({
      request: async () => {
        called++;
        return { text: '不该到这儿' };
      },
    });

    const out = await live.host().cognition!.request({
      brief: '借别人的手',
      tools: ['mc_blueprint', 'other_send'],
    });

    expect(out).toHaveProperty('error');
    // 只点名越权的那把;合法的那把不进"这些不是"名单(错误正文另附本 World 工具表)
    const error = (out as { error: string }).error;
    expect(error.split('(')[0]).toContain('other_send');
    expect(error.split('(')[0]).not.toContain('mc_blueprint');
    expect(called).toBe(0);
  });

  it('点名人格自己的工具(fork 一类核心动作)同样越权', async () => {
    let called = 0;
    live = await rig({
      request: async () => {
        called++;
        return { text: '不该到这儿' };
      },
    });
    const out = await live.host().cognition!.request({ brief: '越级', tools: ['fork'] });
    expect(out).toHaveProperty('error');
    expect(called).toBe(0);
  });

  it('白名单按请求方 World 各算各的:同一把工具换个 World 请求就成了越权', async () => {
    live = await rig({ request: async () => ({ text: 'ok' }) });
    const mine = await live.host().cognition!.request({ brief: '自家的', tools: ['mc_goal'] });
    const theirs = await live.otherHost().cognition!.request({ brief: '别家的', tools: ['mc_goal'] });
    expect(mine).toEqual({ text: 'ok' });
    expect(theirs).toHaveProperty('error');
  });
});

describe('认知外包 · 并发记账与用量归账', () => {
  it('在途请求数对Persona可见(单实例策略归它判断,core 只数数不拦)', async () => {
    const seen: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const bothEntered = new Promise<void>((resolve) => { entered = resolve; });
    live = await rig({
      request: async (_req, ctx) => {
        seen.push(ctx.running);
        if (seen.length === 2) entered();
        await gate;
        return { text: 'ok' };
      },
    });

    const a = live.host().cognition!.request({ brief: '第一件' });
    const b = live.host().cognition!.request({ brief: '第二件' });
    await bothEntered;
    expect(seen).toEqual([1, 2]);
    expect(live.core.cognitionInFlight()).toEqual({ mc: 2 });

    release();
    await Promise.all([a, b]);
    expect(live.core.cognitionInFlight()).toEqual({});
  });

  it('人格实现走 spawnFork:工具装进 fork,用量归到它自己的声明上', async () => {
    let api: CoreApi | null = null;
    const impl: PersonaCognition = {
      request: async (req, ctx) => ({
        text: await api!.spawnFork({
          id: 'cognition',
          messages: records([{ role: 'user', content: req.brief }]),
          tools: ctx.tools,
        }),
      }),
    };
    live = await rig(impl);
    api = live.api;
    live.llm.fallback = () => textReply('图出好了');

    const out = await live.host().cognition!.request({
      brief: '设计 home-v2',
      tools: ['mc_blueprint'],
    });

    expect(out).toEqual({ text: '图出好了' });
    // fork 装配的是 World 点名的那把工具
    const call = live.llm.calls.find((c) => c.tools?.some((t) => t.name === 'mc_blueprint'));
    expect(call).toBeDefined();
    expect(call!.spec.model).toBe(activeSpec(makeCfg()).model);
    // 归账走 SessionDecl 那条既有的路,core 不在 cognition 这边重记一遍
    const stats = live.core.sessions.list().find((s) => s.role === 'cognition');
    expect(stats?.calls).toBe(1);
    expect(live.core.cognitionInFlight()).toEqual({});
  });
});
