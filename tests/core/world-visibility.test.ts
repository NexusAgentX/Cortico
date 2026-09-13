/**
 * World 对 agent 的可见性。
 *
 * 可见性开关撤下 agent 侧三要素,但保持 World 运行。断言覆盖这两个方向。
 *
 * 另一条要守住的性质是生效时机分两半:
 *  - 事件投递立即生效(不进请求,零缓存代价);
 *  - 环境提示词与工具等下一次前缀重建(两者同属缓存前缀,必须一起换)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 探针 World 的环境提示词模板也走真文件——不给测试留绕开模板的捷径 */
const PROBE_TEMPLATE_DIR = mkdtempSync(join(tmpdir(), 'bot-probe-tpl-'));
import { Core } from "./fixture-core.ts";
import { CORE_DEFAULTS, type LoadedConfig } from '../../src/core/config.ts';
import type { CoreConfig, World, WorldHost } from '../../src/core/types.ts';
import { FakeLLM, makeCfg, makeFakePersona, sleep } from './helpers.ts';

class ProbeWorld implements World {
  host: WorldHost | null = null;
  stopped = false;
  /** World 自己关掉半边功能:环境提示词与工具一起交空 */
  featureOff = false;
  /** 模板与真 World 同路径同形态,内容就是断言里认的那句 */
  readonly templatePath: string;
  constructor(readonly id: string) {
    this.templatePath = join(PROBE_TEMPLATE_DIR, `${id}.md`);
    writeFileSync(this.templatePath, `[${id} 的环境提示词]`, 'utf8');
  }
  envPromptVars(): Record<string, string> | null {
    return this.featureOff ? null : {};
  }
  console() {
    return {
      promptDocs: [
        {
          key: `worlds.${this.id}.envPrompt`,
          title: `${this.id} · 环境提示词`,
          description: '探针模板',
          path: this.templatePath,
          role: 'envPrompt' as const,
        },
      ],
    };
  }
  tools() {
    if (this.featureOff) return [];
    return [
      {
        name: `send_${this.id}`,
        description: 'send',
        usage: `* \`send_${this.id}(text)\``,
        tags: [] as const,
        parameters: { type: 'object' as const, properties: {}, required: [] },
        handler: async () => 'ok',
      },
    ];
  }
  async start(host: WorldHost): Promise<void> {
    this.host = host;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  /** World 自己的日常活动:推一条事件进来 */
  emit(text: string) {
    return this.host!.pushEvent({
      ts: new Date().toISOString(),
      source: this.id,
      type: `${this.id}.msg`,
      text,
    });
  }
}

let dir: string;
let core: Core<CoreConfig>;
let probe: ProbeWorld;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'modvis-'));
  // 保留扩展配置的静态类型,使未知字段继续触发编译错误。
  const config: ReturnType<typeof makeCfg> = {
    ...makeCfg(),
    ...CORE_DEFAULTS,
    web: { port: 0 },
    paths: { memory: 'workspace', data: 'data' },
    context: { maxTokens: 64000, keepRatio: 1 / 3, softRatio: 0.85, ...CORE_DEFAULTS.context },
    loop: { softCap: 8, hardCap: 16 },
  };
  const loaded: LoadedConfig<CoreConfig> = {
    config,
    secret: () => 'k',
    rootDir: dir,
    memoryDir: join(dir, 'workspace'),
    dataDir: join(dir, 'data'),
  };
  probe = new ProbeWorld('probe');
  // 挂载表是Persona与 core 共用的同一个数组:运行中挂载/卸载两边同时看到
  const worlds = [probe];
  core = new Core(loaded, {
    // Persona要把 World 工具并进主 session 的工具表,可见性过滤才有东西可减
    persona: makeFakePersona([], { cfg: config, worlds: worlds }),
    worlds: worlds,
    llm: new FakeLLM(),
  });
  await core.start();
  // 让 run() 走完 bootstrap,前缀与工具表都已按初始可见性烘好
  await sleep(50);
});

afterEach(async () => {
  await core.stop();
  rmSync(dir, { recursive: true, force: true });
});

const systemPrefix = (): string => String(core.session.messages[0]?.content ?? '');
const toolNames = (): string[] => core.loop.getToolSchemas().map((t) => t.name);

describe('World 对 agent 的可见性', () => {
  it('默认可见:环境提示词进前缀、工具在表里', () => {
    expect(systemPrefix()).toContain('[probe 的环境提示词]');
    expect(toolNames()).toContain('send_probe');
    expect(core.isWorldVisible('probe')).toBe(true);
  });

  it('隐藏后事件立即不再投递,但照常落库(经历不丢)', async () => {
    const before = core.store.latestCursor();
    core.setWorldVisible('probe', false);
    probe.emit('隐藏期间说的话');

    expect(core.store.latestCursor()).toBe(before + 1);
    expect(core.store.get(before + 1)?.text).toBe('隐藏期间说的话');
    expect(core.store.get(before + 1)?.contextDelivery).toBe('archive-only');
    // 但没进合批总线 → agent 不会被叫醒
    expect(core.bus.pending()).toBe(0);
  });

  it('隐藏不停 World:stop 没被调用,host 还在,它照常能推事件', () => {
    core.setWorldVisible('probe', false);
    expect(probe.stopped).toBe(false);
    expect(probe.host).not.toBeNull();
    expect(() => probe.emit('照常工作')).not.toThrow();
  });

  it('环境提示词与工具不随开关立即变,要等前缀重载——并且一起变', async () => {
    core.setWorldVisible('probe', false);
    // 还没重载:两样都还在,且被标记为"前缀待跟上"
    expect(systemPrefix()).toContain('[probe 的环境提示词]');
    expect(toolNames()).toContain('send_probe');
    expect(core.worldVisibility().driftedWorlds).toEqual(['probe']);

    await core.loop.reloadSystemPrefix();

    expect(systemPrefix()).not.toContain('[probe 的环境提示词]');
    expect(toolNames()).not.toContain('send_probe');
    expect(core.worldVisibility().driftedWorlds).toEqual([]);
  });

  it('World 自己撤下工具也算前缀漂移,重载后环境提示词与工具一起跟上', async () => {
    probe.featureOff = true;
    // 可见性没动,但它交出的东西变了:前缀里那份已经不是现在这份
    expect(core.worldVisibility().driftedWorlds).toEqual(['probe']);
    expect(systemPrefix()).toContain('[probe 的环境提示词]');
    expect(toolNames()).toContain('send_probe');

    await core.loop.reloadSystemPrefix();

    expect(systemPrefix()).not.toContain('[probe 的环境提示词]');
    expect(toolNames()).not.toContain('send_probe');
    expect(core.worldVisibility().driftedWorlds).toEqual([]);
  });

  it('重新显示后两样一起回来', async () => {
    core.setWorldVisible('probe', false);
    await core.loop.reloadSystemPrefix();
    core.setWorldVisible('probe', true);
    await core.loop.reloadSystemPrefix();
    expect(systemPrefix()).toContain('[probe 的环境提示词]');
    expect(toolNames()).toContain('send_probe');
  });

  it('可见性跨重启保留,清空 core 状态不启用已关闭 World', () => {
    core.setWorldVisible('probe', false);
    core.state.load();
    expect(core.isWorldVisible('probe')).toBe(false);
    core.state.clear();
    expect(core.isWorldVisible('probe')).toBe(false);
  });

  it('隐藏期间照常推事件:落库不投递这件事按节流记进 runlog(不是静默)', () => {
    core.setWorldVisible('probe', false);
    probe.emit('第一条');
    probe.emit('第二条');
    const lines = readFileSync(join(core.run.dir, 'log.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('事件只归档不投递'));
    // 第一条就报,之后十分钟内不再刷屏
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('probe');
  });

  it('未挂载的 World 拒绝设置(不静默成功)', () => {
    expect(() => core.setWorldVisible('nope', false)).toThrow(/未挂载/);
  });
});

describe('运行中挂载与卸载', () => {
  it('挂载:立即 start、入表、前缀与工具表一并重建', async () => {
    const extra = new ProbeWorld('extra');
    await core.mountWorld(extra);
    expect(extra.host).not.toBeNull();
    expect(core.worldVisibility().visibility).toEqual({ probe: true, extra: true });
    expect(systemPrefix()).toContain('[extra 的环境提示词]');
    expect(toolNames()).toContain('send_extra');
    expect(core.worldVisibility().driftedWorlds).toEqual([]);
    // 新挂的 World 推事件照常进总线
    extra.emit('挂载后的第一句');
    expect(core.store.get(core.store.latestCursor())?.text).toBe('挂载后的第一句');
  });

  it('卸载:stop、租约失效、出表、前缀与工具表撤下;同 id 再挂是一个新实例', async () => {
    const extra = new ProbeWorld('extra');
    await core.mountWorld(extra);
    expect(await core.unmountWorld('extra')).toBeNull();
    expect(extra.stopped).toBe(true);
    expect(core.worldVisibility().visibility).toEqual({ probe: true });
    expect(systemPrefix()).not.toContain('[extra 的环境提示词]');
    expect(toolNames()).not.toContain('send_extra');
    // 旧实例的宿主已经失效:再推事件被拒
    await expect(extra.emit('卸载后')).rejects.toThrow('生命周期已结束');
    const again = new ProbeWorld('extra');
    await core.mountWorld(again);
    expect(toolNames()).toContain('send_extra');
  });

  it('同 id 重复挂载与卸载未挂载的都直接拒绝', async () => {
    await expect(core.mountWorld(new ProbeWorld('probe'))).rejects.toThrow('已挂载');
    await expect(core.unmountWorld('nope')).rejects.toThrow('未挂载');
  });

  it('stop 超时或抛错只记账,World 照样出表', async () => {
    const bad = new ProbeWorld('bad');
    bad.stop = async () => { throw new Error('停不下来'); };
    await core.mountWorld(bad);
    const failure = await core.unmountWorld('bad');
    expect(failure).toEqual({ worldId: 'bad', detail: '停不下来' });
    expect(core.worldVisibility().visibility).toEqual({ probe: true });
  });
});
