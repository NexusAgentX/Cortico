/**
 * 关机先暂停投递，再停止 World 和其他服务并保存状态。
 * 步骤失败或超时后继续后续步骤；整个关机过程只执行一次。
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Core } from "./fixture-core.ts";
import { makeCfg, type LoadedConfig, type BotConfig } from './helpers.ts';
import { withDeadline } from '../../src/core/util.ts';
import type {
  World,
  WorldHost,
} from '../../src/core/types.ts';
import { FakeLLM, makeFakePersona } from './helpers.ts';

type TestConfig = BotConfig;

/** 停机行为可编排的探针 World:立刻停 / 永远不停 / 停的时候抛。 */
class ProbeWorld implements World {
  stopped = false;
  constructor(
    readonly id: string,
    private readonly mode: 'fast' | 'hang' | 'throw' = 'fast',
  ) {}
  environment(): string { return ''; }
  tools(): [] { return []; }
  async start(_host: WorldHost): Promise<void> { /* 探针不需要 host */ }
  stop(): Promise<void> {
    if (this.mode === 'hang') return new Promise<void>(() => { /* 永不 resolve */ });
    this.stopped = true;
    if (this.mode === 'throw') return Promise.reject(new Error('探针拒绝停机'));
    return Promise.resolve();
  }
}

class HostLeaseProbeWorld extends ProbeWorld {
  host: WorldHost | null = null;
  override async start(host: WorldHost): Promise<void> {
    this.host = host;
  }
}

function makeEnv(worlds: World[]): {
  dir: string;
  config: TestConfig;
  loaded: LoadedConfig<TestConfig>;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'shutdown-'));
  const config = makeCfg();
  const loaded: LoadedConfig<TestConfig> = {
    config,
    rootDir: dir,
    memoryDir: join(dir, 'workspace'),
    dataDir: join(dir, 'data'),
  };
  void worlds;
  return { dir, config, loaded, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('withDeadline', () => {
  it('按时回来就原样放行', async () => {
    await expect(withDeadline(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
  });

  it('不肯回来就抛,而且错误里说得出是哪一步', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<void>(() => { /* 永不 resolve */ });
      const p = withDeadline(never, 5_000, 'World 收尾');
      const caught = p.catch((e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(5_100);
      expect(await caught).toContain('World 收尾');
      expect(await caught).toContain('5秒');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("core.stop():单个 World 未完成时仍停止其他 World", () => {
  it('挂住的那个到点被放弃,其余照常停完', async () => {
    const fast = new ProbeWorld('fast');
    const hang = new ProbeWorld('hang', 'hang');
    // 未完成的 stop 排在前面，验证其他 World 的 stop 仍可执行。
    const env = makeEnv([hang, fast]);
    vi.useFakeTimers();
    try {
      const core = new Core<TestConfig>(env.loaded, {
        persona: makeFakePersona([], { cfg: env.config as never, worlds: [hang, fast] }),
        worlds: [hang, fast],
        llm: new FakeLLM(),
      });
      // 此测试仅检查停止流程，不启动主循环。
      const done = core.stop();
      await vi.advanceTimersByTimeAsync(21_000);
      const failures = await done; // 单个 stop 未完成不能阻止整体超时返回。
      expect(fast.stopped).toBe(true);
      expect(hang.stopped).toBe(false);
      expect(failures).toEqual([expect.objectContaining({
        worldId: 'hang',
        detail: expect.stringContaining('超时'),
      })]);
    } finally {
      vi.useRealTimers();
      env.cleanup();
    }
  });

  it('World stop 完成后捕获的旧 host 不能再写事件、用量或 session', async () => {
    const probe = new HostLeaseProbeWorld('lease');
    const env = makeEnv([probe]);
    try {
      const cognitionRequest = vi.fn(async () => ({ text: '不该启动' }));
      const persona = makeFakePersona([], { cfg: env.config as never, worlds: [probe] });
      persona.cognition = { request: cognitionRequest };
      const core = new Core<TestConfig>(env.loaded, {
        persona: persona,
        worlds: [probe],
        llm: new FakeLLM(),
      });
      const usage = vi.spyOn(
        core as unknown as { reportWorldUsage(...args: unknown[]): void },
        'reportWorldUsage',
      );
      await core.start();
      const host = probe.host!;
      const cachedCognition = host.cognition!;
      await core.stop();
      const cursor = core.store.latestCursor();

      await expect(host.pushEvent({
        type: 'late.event', ts: new Date().toISOString(), source: 'lease', text: '迟到事件',
      })).rejects.toThrow('宿主生命周期已结束');
      host.pushDeferred({ type: 'late.deferred', render: () => '迟到延迟事件' });
      host.reportUsage({ promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1 });

      expect(core.store.latestCursor()).toBe(cursor);
      expect(usage).not.toHaveBeenCalled();
      expect(host.cognition).toBeUndefined();
      expect(await cachedCognition.request({ brief: '迟到请求' })).toEqual({ error: '宿主生命周期已结束' });
      expect(cognitionRequest).not.toHaveBeenCalled();
    } finally {
      env.cleanup();
    }
  });

  it('World stop 超时的期限一到也立即封住旧 host', async () => {
    const probe = new HostLeaseProbeWorld('lease-timeout', 'hang');
    const env = makeEnv([probe]);
    vi.useFakeTimers();
    try {
      const core = new Core<TestConfig>(env.loaded, {
        persona: makeFakePersona([], { cfg: env.config as never, worlds: [probe] }),
        worlds: [probe],
        llm: new FakeLLM(),
      });
      await core.start();
      const stopping = core.stop();
      await vi.advanceTimersByTimeAsync(21_000);
      expect(await stopping).toEqual([expect.objectContaining({ worldId: 'lease-timeout' })]);
      await expect(probe.host!.pushEvent({
        type: 'late.timeout', ts: new Date().toISOString(), source: 'lease-timeout', text: '超时后事件',
      })).rejects.toThrow('宿主生命周期已结束');
    } finally {
      vi.useRealTimers();
      env.cleanup();
    }
  });
});
