import { messages as legacyMessages } from './fixture-protocol.ts';
import { FixtureHandoffResult as ContextHandoffResult } from './fixture-protocol.ts';
/**
 * 首轮对话在请求的 system 前缀之后插入，不写入持久 session。
 * dropPastThinking 保留 firstTurn 项；Responses 仅回传来源兼容的 encrypted_content，
 * 不回传明文推理或内部 firstTurn 标记。
 */
import { describe, expect, it } from 'vitest';
import { MainLoop } from '../../src/core/loop.ts';
import { WakeBus } from '../../src/core/bus.ts';
import { SessionLog } from "./fixture-session.ts";
import { JsonlEventStore } from '../../src/core/event-store.ts';
import { CoreState } from '../../src/core/state.ts';
import { nullLogger } from '../../src/core/util.ts';
import { estimateMessagesTokens } from './fixture-util.ts';
import { dropPastThinking } from '../../src/providers/transport/history.ts';
import { responsesInput } from '../../src/providers/transport/responses-input.ts';
import { record } from '../../src/protocol/open-responses/context.ts';
import { records } from './fixture-protocol.ts';
import type { ChatMessage } from './fixture-types.ts';
import type { FirstTurnRound } from '../../src/core/types.ts';
import type { BotConfig } from '../../bots/corti-soulmate/assemble.ts';
import {
  activeSpec,
  FakeLLM,
  assertPairing,
  makeCfg,
  makeFakeHarnessApi,
  makeFakeIO,
  makeFakePersona,
  makeTmpDir,
  makeTool,
  sleep,
  textReply,
  fakeBlobIntern,
} from './helpers.ts';

async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('until超时');
    await sleep(10);
  }
}

const ROUND: FirstTurnRound = { user: '早呀', thinking: '她在打招呼,轻快地回', reply: '早——今天也在呢' };

interface RigOptions {
  cfgPatch?: (cfg: BotConfig) => void;
  firstTurn?: () => FirstTurnRound[];
  onHandoff?: (snapshot: ChatMessage[]) => Promise<ContextHandoffResult>;
  preSession?: ChatMessage[];
}

function makeRig(opts: RigOptions = {}) {
  const tmp = makeTmpDir();
  const cfg = makeCfg();
  cfg.batching = { quietGapMs: 20, minBatchAgeMs: 0, maxBatchAgeMs: 200, maxBatchSize: 100 };
  // 默认关闭；此测试启用，个别用例另行覆盖。
  cfg.context.firstTurn = true;
  opts.cfgPatch?.(cfg);
  const bus = new WakeBus(cfg.batching);
  const session = new SessionLog(tmp.dir);
  const store = new JsonlEventStore({ dataDir: tmp.dir, run: 'r-20260101-000000-0001' });
  const state = new CoreState(tmp.dir);
  state.load();
  if (opts.preSession) for (const m of opts.preSession) session.append(m);
  const llm = new FakeLLM();
  const worlds = [makeFakeIO('qq', [makeTool('noop', 'ok')])];
  const persona = makeFakePersona([], {
    cfg,
    worlds: worlds,
    firstTurn: opts.firstTurn,
    onHandoff: opts.onHandoff,
  });
  const loop = new MainLoop({
    cfg,
    llm,
    persona,
    decl: persona.declareSessions()[0],
    spec: () => activeSpec(cfg),
    context: { hardTokens: () => null, estimateTokens: estimateMessagesTokens, contextOverflow: () => false },
    blobs: fakeBlobIntern(),
    worlds: { all: () => worlds, visible: () => worlds },
    bus,
    session,
    store,
    state,
    log: nullLogger(),
  });
  persona.attach(makeFakeHarnessApi({
    injectInternal: (text, kind) => loop.injectInternal(text, kind),
    requestContextHandoff: () => loop.requestContextHandoff(),
    sessionInfo: (id) => ({ id, running: 0, snapshot: legacyMessages(loop.outboundMessages()), ...loop.contextGauge() }),
  }));
  let runPromise: Promise<void> | null = null;
  let eventSeq = 0;
  return {
    cfg, session, llm, loop, tmp,
    start() { runPromise = loop.run(); },
    pushEvent(text: string) {
      const event = store.append({
        type: 'qq.message',
        ts: `2026-07-17T10:0${++eventSeq % 10}:00+08:00`,
        source: 'qq',
        origin: 'external',
        text,
      });
      bus.push({ event }, { trigger: 'flush' });
      return event;
    },
    async cleanup() {
      loop.stop();
      if (runPromise) await runPromise;
      tmp.cleanup();
    },
  };
}

/** 数组里的首轮消息(带标记的那段) */
const markedOf = (msgs: ChatMessage[]) => msgs.filter((m) => m.firstTurn);

describe('合成首轮对话:注入位置与落盘边界', () => {
  it("请求在 system 后插入 user/assistant，持久 session 不包含合成消息", async () => {
    const rig = makeRig({ firstTurn: () => [ROUND] });
    rig.llm.script(textReply('好'));
    rig.start();
    rig.pushEvent('阿明: 在吗');
    await until(() => rig.llm.calls.length >= 1);

    const sent = rig.llm.calls[0].messages;
    expect(sent[0].role).toBe('system');
    expect(sent[1]).toMatchObject({ role: 'user', content: ROUND.user, firstTurn: true });
    expect(sent[2]).toMatchObject({
      role: 'assistant',
      content: ROUND.reply,
      reasoning_content: ROUND.thinking,
      firstTurn: true,
    });
    // 真实历史紧随其后
    expect(sent[3].role).toBe('user');
    expect(sent[3].firstTurn).toBeUndefined();

    // 持久记录不包含合成消息或内部标记。
    await until(() => rig.session.messages.some((m) => m.role === 'assistant'));
    expect(markedOf(rig.session.messages)).toEqual([]);
    expect(rig.session.messages.some((m) => m.content === ROUND.user)).toBe(false);
    await rig.cleanup();
  });

  it('开关关闭即不注入;人格没提供该机制也不注入', async () => {
    const off = makeRig({
      firstTurn: () => [ROUND],
      cfgPatch: (cfg) => { cfg.context.firstTurn = false; },
    });
    off.llm.script(textReply(''));
    off.start();
    off.pushEvent('x');
    await until(() => off.llm.calls.length >= 1);
    expect(markedOf(off.llm.calls[0].messages)).toEqual([]);
    await off.cleanup();

    const none = makeRig({});
    none.llm.script(textReply(''));
    none.start();
    none.pushEvent('x');
    await until(() => none.llm.calls.length >= 1);
    expect(markedOf(none.llm.calls[0].messages)).toEqual([]);
    await none.cleanup();
  });

  it("跳过 user 或 reply 为空白的合成对话", async () => {
    const rig = makeRig({ firstTurn: () => [{ user: '  ', reply: '有回复' }, ROUND] });
    rig.llm.script(textReply(''));
    rig.start();
    rig.pushEvent('x');
    await until(() => rig.llm.calls.length >= 1);
    // 只有完整的那轮进去了
    expect(markedOf(rig.llm.calls[0].messages)).toHaveLength(2);
    expect(rig.llm.calls[0].messages[1].content).toBe(ROUND.user);
    await rig.cleanup();
  });

  it('重启恢复(不重建前缀)也照常注入', async () => {
    const rig = makeRig({
      firstTurn: () => [ROUND],
      preSession: [
        { role: 'system', content: '旧前缀' },
        { role: 'user', content: '旧对话' },
        { role: 'assistant', content: '旧回复', reasoning_content: '' },
      ],
    });
    rig.llm.script(textReply(''));
    rig.start();
    rig.pushEvent('新消息');
    await until(() => rig.llm.calls.length >= 1);
    const sent = rig.llm.calls[0].messages;
    expect(sent[0].content).toBe('旧前缀');
    expect(sent[1]).toMatchObject({ role: 'user', content: ROUND.user, firstTurn: true });
    await rig.cleanup();
  });

  it("交接策略收到请求快照，返回的首轮对话在持久化前过滤", async () => {
    let sawSnapshot: ChatMessage[] = [];
    const rig = makeRig({
      firstTurn: () => [ROUND],
      onHandoff: async (snapshot) => {
        sawSnapshot = snapshot;
        // 策略返回含合成消息的完整快照，验证持久化前的过滤。
        let head = 0;
        while (head < snapshot.length && snapshot[head].role === 'system') head++;
        return { tail: snapshot.slice(head) };
      },
    });
    rig.llm.script(textReply('好'));
    rig.start();
    rig.pushEvent('阿明: 在吗');
    await until(() => rig.llm.calls.length >= 1);
    await until(() => rig.session.messages.some((m) => m.role === 'assistant'));

    await rig.loop.handoffContext();
    // 交接策略收到包含合成首轮的请求快照。
    expect(markedOf(sawSnapshot).length).toBe(2);
    // 重建后的持久记录排除合成消息。
    expect(markedOf(rig.session.messages)).toEqual([]);
    expect(rig.session.messages.some((m) => m.content === ROUND.user)).toBe(false);
    assertPairing(rig.session.messages);

    // 交接后的请求仍包含首轮对话。
    rig.llm.script(textReply(''));
    rig.pushEvent('又来消息');
    await until(() => rig.llm.calls.length >= 2);
    expect(markedOf(rig.llm.calls[1].messages)).toHaveLength(2);
    await rig.cleanup();
  });

  it('outboundMessages 与实际发出的消息同一口径(fork 继承快照据此对齐字节前缀)', async () => {
    const rig = makeRig({ firstTurn: () => [ROUND] });
    rig.llm.script(textReply(''));
    rig.start();
    rig.pushEvent('x');
    await until(() => rig.llm.calls.length >= 1);
    const sentHead = rig.llm.calls[0].messages.slice(0, 3);
    const outbound = legacyMessages(rig.loop.outboundMessages()).slice(0, 3);
    expect(JSON.stringify(outbound)).toBe(JSON.stringify(sentHead));
    await rig.cleanup();
  });
});

describe("合成首轮对话:不同传输的请求内容", () => {
  const spec = { model: 'm', thinking: true } as const;
  const history: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: ROUND.user, firstTurn: true },
    { role: 'assistant', content: ROUND.reply, reasoning_content: ROUND.thinking, firstTurn: true },
    { role: 'user', content: '真实输入' },
    { role: 'assistant', content: '旧回复', reasoning_content: '旧思维链' },
    { role: 'user', content: '再一条' },
    { role: 'assistant', content: '新回复', reasoning_content: '新思维链' },
  ];

  it('dropPastThinking 豁免 firstTurn 标记的消息', () => {
    const out = dropPastThinking(history);
    expect(out[2].reasoning_content).toBe(ROUND.thinking);
    expect(out[4].reasoning_content).toBe('');
    expect(out[6].reasoning_content).toBe('');
  });

  it('Responses 传输:明文思维链没有线上形态,首轮与否都不出线;标记字段不出线', () => {
    const context = records(history);
    const request = { model: 'm', input: [] as never[] };
    for (const keep of [true, false]) {
      const { input, instructions } = responsesInput(request, { context }, { keepThinking: () => keep });
      expect(instructions).toBe('sys');
      expect(input.some((item) => item.type === 'reasoning')).toBe(false);
      for (const item of input) expect('firstTurn' in item).toBe(false);
    }
  });

  it('Responses 传输:签名载荷按 origin 回灌;首轮豁免 keepThinking,其余按开关', () => {
    const origin = { instance: 'i', module: 'openai-responses-compat', model: 'm', compatibilityDomain: 'd' };
    const reasoning = (id: string, meta: Record<string, unknown>) =>
      record({ type: 'reasoning', id, summary: [], content: [], encrypted_content: 'sig-' + id } as never, { origin, ...meta } as never);
    const context = [
      reasoning('first', { firstTurn: true }),
      reasoning('later', {}),
      reasoning('foreign', { origin: { ...origin, model: 'other' } }),
    ];
    const request = { model: 'm', input: [] as never[] };
    const ids = (keep: boolean) => responsesInput(request, { context, origin }, { keepThinking: () => keep }).input.map((item) => item.id);
    expect(ids(true)).toEqual(['first', 'later']);
    expect(ids(false)).toEqual(['first']);
  });
});
