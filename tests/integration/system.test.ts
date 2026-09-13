import { messages as legacyMessages } from '../core/fixture-protocol.ts';
/**
 * 全系统集成测试(FakeLLM,不打真实API):
 * 走真实装配路径 assembleBot() —— 真Persona(临时persona/)、真webWorld、
 * 真WebApp(随机端口)、真事件库/合批/主循环,只有LLM是脚本化的。
 *
 * 验证链路:WS客户端发消息 → terminal.message落库+urgent投递为user事件
 * → FakeLLM调用send → WS客户端收到bot广播 → 事件库有terminal.self →
 * session配对完整 → 面板API能看到一切。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { assembleBot, type AssembledBot } from '../../bots/corti-soulmate/assemble.ts';
import { FakeLLM, makeCfg, makeLoaded, makeTmpDir, toolReply, sleep } from '../core/helpers.ts';
import { validatePairing } from "../core/fixture-truncate.ts";
import { panelStreamRoute } from '../../src/web/shared/console-protocol.ts';

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor超时');
    await sleep(20);
  }
}

describe('全系统集成(终端对话链路)', () => {
  const tmp = makeTmpDir();
  let bot: AssembledBot;
  let llm: FakeLLM;
  let port: number;
  let ws: WebSocket;
  const received: Array<Record<string, unknown>> = [];

  /**
   * 一个端点条目落盘后长什么样。端点表归全局(`<部署根>/providers/<name>/config.json`),
   * 这份部署的 config.json 只留 `activeProvider` 与形状版本。
   */
  const entryOnDisk = (name: string): Record<string, any> =>
    JSON.parse(readFileSync(join(tmp.dir, 'providers', name, 'config.json'), 'utf8'));

  beforeAll(async () => {
    // 造一个最小工作区种子
    const memoryDir = join(tmp.dir, 'persona');
    mkdirSync(join(memoryDir, 'note'), { recursive: true });
    writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# 我是谁\n测试用人格。', 'utf8');

    const cfg = makeCfg();
    // 第二个端点条目:面板保存只动被保存的那条,得有另一条在旁边才看得出来
    cfg.providers.local = {
      kind: 'openai-responses-compat',
      baseUrl: 'http://127.0.0.1:8090/v1',
      spec: { model: 'local', thinking: false },
    };
    cfg.batching.quietGapMs = 40; // 加速合批
    cfg.batching.maxBatchAgeMs = 500;
    cfg.worlds.qq.enabled = false;
    cfg.worlds.terminal.enabled = true;
    cfg.web.port = 0; // 随机端口

    const loaded = makeLoaded({
      config: cfg,
      rootDir: tmp.dir,
      memoryDir,
      dataDir: join(tmp.dir, 'data'),
    });

    llm = new FakeLLM();
    bot = assembleBot(loaded, { llm });
    port = (await bot.start()).port as number;
  }, 15000);

  afterAll(async () => {
    try {
      ws?.close();
    } catch { /* ignore */ }
    await bot.stop();
    tmp.cleanup();
  });

  it('boot:session以system+user事件开始，assistant自然结束', async () => {
    await waitFor(() => legacyMessages(bot.core.session.records).length >= 3);
    const msgs = legacyMessages(bot.core.session.records);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('测试用人格');
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toContain('session 已开始');
    expect(msgs[2].role).toBe('assistant');
    expect(msgs[2].tool_calls).toBeUndefined();
    // 等boot轮的LLM调用完成,再进下一个测试注入脚本,
    // 等待 bootstrap 轮结束,避免测试脚本被该轮消费。
    await waitFor(() => llm.calls.length >= 1);
  });

  it('WS对话:用户消息→回复→客户端收到广播', async () => {
    ws = new WebSocket(`ws://127.0.0.1:${port}${panelStreamRoute('world:terminal', 'chat')}`);
    ws.on('message', (data) => received.push(JSON.parse(String(data))));
    await new Promise<void>((res, rej) => {
      ws.once('open', res);
      ws.once('error', rej);
    });
    ws.send(JSON.stringify({ type: 'hello', name: 'phantivia' }));

    // 进出终端已不投递事件,hello 不会触发任何唤醒,直接排脚本即可。
    llm.script(
      toolReply([{ name: 'terminal_send', args: { text: '你好phantivia!我能看到这条消息。' } }]),
    );
    ws.send(JSON.stringify({ type: 'msg', text: '在吗,bot?' }));

    await waitFor(() =>
      received.some((m) => m.type === 'msg' && String(m.from).includes('Yukima') && String(m.text).includes('你好phantivia')),
    );
    // 等terminal.message确实落库(与广播之间没有顺序保证)
    await waitFor(() => bot.core.store.range({}).some((e) => e.type === 'terminal.message'));
  });

  it('事件库:terminal.message与terminal.self都落库,terminal.self不投递', () => {
    const events = bot.core.store.range({});
    const userMsg = events.find((e) => e.type === 'terminal.message');
    const selfMsg = events.find((e) => e.type === 'terminal.self');
    expect(userMsg).toBeTruthy();
    expect(userMsg!.text).toContain('在吗,bot?');
    expect(selfMsg).toBeTruthy();
    expect(selfMsg!.text).toContain('你好phantivia');
  });

  it('session:工具调用全部配对，回合自然结束', () => {
    const msgs = legacyMessages(bot.core.session.records);
    const issues = validatePairing(msgs);
    expect(issues).toEqual([]);
    const sendCall = msgs.find(
      (m) => m.role === 'assistant' && m.tool_calls?.some((tc) => tc.function.name === 'terminal_send'),
    );
    expect(sendCall).toBeTruthy();
    // 控制台是操作员通道(origin:'internal'):原话并进 user 消息,不落工具回执区。
    // 外部正文走回执区那条路由由 core/loop.test.ts 钉。
    expect(msgs.some((m) => m.role === 'user' && m.content.includes('在吗,bot?'))).toBe(true);
    expect(msgs.some((m) => m.role === 'tool' && m.content.includes('在吗,bot?'))).toBe(false);
  });

  it('面板API:status/events/file都活着', async () => {
    const status = (await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()) as Record<string, unknown>;
    expect(status).toHaveProperty('loop');
    expect(status).toHaveProperty('chips');

    const events = (await (await fetch(`http://127.0.0.1:${port}/api/events`)).json()) as {
      events: unknown[];
    };
    expect(events.events.length).toBeGreaterThanOrEqual(2);

    const file = await fetch(`http://127.0.0.1:${port}/api/console/providers/persona%3Acorti-soulmate/panels/workspace/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: ['CONSTITUTION.md'] }),
    });
    expect(file.status).toBe(200);
  });

  it('记忆工具写笔记:真实落盘到 persona/', async () => {
    llm.script(
      toolReply([
        { name: 'write_file', args: { path: 'note/第一次对话.md', content: '今天phantivia来打了招呼。' } },
      ]),
    );
    ws.send(JSON.stringify({ type: 'msg', text: '记住今天哦' }));
    await waitFor(() => existsSync(join(tmp.dir, 'persona', 'note', '第一次对话.md')));
  });

  it('模型热改:Provider 面板保存实例档位,一份 spec 管所有 session', async () => {
    const originalLocal = structuredClone(bot.core.config.providers.local);
    const setModel = (spec: Record<string, unknown>) => fetch(
      `http://127.0.0.1:${port}/api/console/providers/llm%3Aopenai-responses-compat/panels/settings/save`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: [{ name: 'deepseek', spec, pricing: [] }] }),
      },
    );

    let r = await setModel({ model: 'deepseek-v4-pro', thinking: false });
    expect(r.status).toBe(200);
    // 主 session 与梦读的是同一份:模型归 provider,不按角色分岔
    expect(bot.core.activeSpec()).toEqual({ model: 'deepseek-v4-pro', thinking: false });
    expect(bot.core.mainSessionSpec()).toEqual(bot.core.activeSpec());
    expect(entryOnDisk('deepseek').spec).toEqual({ model: 'deepseek-v4-pro', thinking: false });

    r = await setModel({ model: 'deepseek-v4-pro', thinking: true, reasoningEffort: 'high' });
    expect(r.status).toBe(200);
    const onDisk = entryOnDisk('deepseek');
    expect(onDisk.spec).toEqual({ model: 'deepseek-v4-pro', thinking: true, reasoningEffort: 'high' });
    // 角色矩阵是上一版的形状,折叠之后不该再出现
    expect(onDisk.profiles).toBeUndefined();
    // 只动被保存的那条:local 那条既没被改也没被搬
    expect(bot.core.config.providers.local).toEqual(originalLocal);
    expect(JSON.parse(readFileSync(join(tmp.dir, 'config.json'), 'utf8')).models).toBeUndefined();
  });

  it('配置项热改:声明驱动的路径读写,数组/nullable/热生效,落盘只动被改的路径', async () => {
    type Groups = { groups: Array<{ group: { id: string; owner: string; schema: { properties: Record<string, unknown> } }; values: Record<string, unknown> }> };
    const cget = async () => (await (await fetch(`http://127.0.0.1:${port}/api/config`)).json()) as Groups;
    const cpost = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const pcOf = async () => (await cget()).groups.find((x) => x.group.id === 'corti')!;

    const g = await cget();
    // 未激活槽位的旋钮也在(QQ 没开,仓内其余 World 是部署侧选配):参数要在激活前就能改。
    // 顺序是 src/worlds/index.ts 的目录顺序。
    expect(g.groups.map((x) => x.group.id)).toEqual([
      'core', 'corti',
      'world:terminal', 'world:qq', 'world:bilibili',
      'world:minecraft', 'world:minecraft:rhythm', 'world:minecraft:client', 'world:minecraft:player',
      'world:websearch',
      'llm.openai-responses-compat.deepseek', 'llm.openai-responses-compat.local',
    ]);
    // id 标识具体实例；owner 标识与实例无关的架构角色。
    expect(g.groups.map((x) => x.group.owner)).toEqual([
      'core', 'persona',
      'world:terminal', 'world:qq', 'world:bilibili',
      'world:minecraft', 'world:minecraft', 'world:minecraft', 'world:minecraft',
      'world:websearch',
      'provider:openai-responses-compat', 'provider:openai-responses-compat',
    ]);
    const pc0 = g.groups.find((x) => x.group.id === 'corti')!;
    expect(pc0.group.schema.properties['context.maxTokens']).toBeTruthy();
    expect(pc0.values['context.maxTokens']).toBe(bot.core.config.context.maxTokens);

    let r = await cpost({
      group: 'corti',
      values: {
        'context.maxTokens': 100000,
        'tick.dayIntervalMinutes': [45, 90],
        'tick.nightIntervalMinutes': null, // null 禁用夜间 tick 调度。
        'memo.residentCap': 9,
      },
    });
    expect(r.status).toBe(200);
    expect(bot.core.config.context.maxTokens).toBe(100000);
    expect(bot.core.config.tick.dayIntervalMinutes).toEqual([45, 90]);
    expect(bot.core.config.tick.nightIntervalMinutes).toBeNull();
    expect(bot.core.config.memo.residentCap).toBe(9);
    expect((await pcOf()).values['tick.nightIntervalMinutes']).toBeNull();
    let onDisk = JSON.parse(readFileSync(join(tmp.dir, 'config.json'), 'utf8'));
    // 改了就落盘:被改的路径进文件,没碰的段不受牵连
    expect(onDisk.context.maxTokens).toBe(100000);
    expect(entryOnDisk('deepseek').spec).toBeTruthy();

    r = await cpost({ group: 'corti', values: { 'context.maxTokens': 111000 } });
    expect(r.status).toBe(200);
    onDisk = JSON.parse(readFileSync(join(tmp.dir, 'config.json'), 'utf8'));
    expect(onDisk.context.maxTokens).toBe(111000);
    expect(entryOnDisk('deepseek').spec.model).toBe('deepseek-v4-pro');

    r = await cpost({ group: 'corti', values: { 'context.maxTokens': 100 /* < min 8000 */ } });
    expect(r.status).toBe(400);
    expect(bot.core.config.context.maxTokens).toBe(111000);

    // 每个配置组只接受自身 schema 声明的键。
    const hn = (await cget()).groups.find((x) => x.group.id === 'core')!;
    expect(hn.group.schema.properties['context.maxTokens']).toBeUndefined();
    r = await cpost({ group: 'core', values: { 'context.maxTokens': 8000 } });
    expect(r.status).toBe(200);
    expect(bot.core.config.context.maxTokens).toBe(111000);
  });

  it('一键清空:全部部分清除,session最后重开,循环仍活着', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/storage/clear-all`, { method: 'POST' });
    const out = (await r.json()) as { ok: boolean; results: Array<{ key: string; ok: boolean }> };
    expect(r.status).toBe(200);
    expect(out.ok).toBe(true);
    expect(out.results[out.results.length - 1].key).toBe('session');
    // Clear-all 会用内部事件重开会话；外部事件库保持为空。
    expect(bot.core.store.range({ origin: 'external' })).toHaveLength(0);
    await waitFor(() => legacyMessages(bot.core.session.records).some(
      (m) => m.role === 'user' && m.content.includes('session 已开始'),
    ));
    ws.send(JSON.stringify({ type: 'msg', text: '还在吗?' }));
    await waitFor(() => bot.core.store.range({}).some((e) => e.text.includes('还在吗?')));
  });
});
