import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import { Core } from '../../src/index.ts';
import { createExample } from '../../examples/minimal.ts';
import type { WorldHost } from '../../src/core/types.ts';
import { FakeLLM, makeFakeIO, makeFakePersona, makeTmpDir, makeTool, textReply, toolReply } from './helpers.ts';

const cores: Core[] = [];
const dirs: ReturnType<typeof makeTmpDir>[] = [];
afterEach(async () => { await Promise.all(cores.splice(0).map(core => core.stop())); dirs.splice(0).forEach(dir => dir.cleanup()); });
function build() {
  const dir = makeTmpDir(); dirs.push(dir);
  const provider = new FakeLLM();
  const core = new Core({ dataDir: dir.dir, provider, model: { model: 'test-model', thinking: false }, persona: makeFakePersona([], { silent: true }) });
  cores.push(core); return { core, provider, dir: dir.dir };
}

describe('programmatic runtime', () => {
  it('mounts World tools and environment without a Persona dependency, then removes them', async () => {
    const { core, provider } = build();
    let host!: WorldHost;
    let executions = 0;
    const world = makeFakeIO('probe', [makeTool('probe_act', () => { executions++; return 'done'; })], 'probe environment');
    world.start = async value => { host = value; };
    await core.start();
    await core.mount(world);
    expect(core.loop.getToolSchemas().map(tool => tool.name)).toContain('probe_act');
    provider.script(toolReply([{ name: 'probe_act' }]), textReply('finished'));
    await host.pushEvent({ type: 'probe.message', source: 'probe', text: 'go', ts: new Date().toISOString() }, { trigger: 'flush' });
    await vi.waitFor(() => expect(executions).toBe(1));
    await core.unmount('probe');
    expect(core.loop.getToolSchemas().map(tool => tool.name)).not.toContain('probe_act');
    await expect(host.pushEvent({ type: 'probe.message', source: 'probe', text: 'late', ts: new Date().toISOString() })).rejects.toThrow();
  });

  it('rejects duplicate tool names before starting the new World', async () => {
    const { core } = build();
    await core.mount(makeFakeIO('first', [makeTool('same', 'one')]));
    const second = makeFakeIO('second', [makeTool('same', 'two')]);
    let started = false;
    second.start = async () => { started = true; };
    await expect(core.mount(second)).rejects.toThrow('Duplicate tool');
    expect(started).toBe(false);
  });

  it('uses injected provider context facts and the smaller declared model window', () => {
    const dir = makeTmpDir(); dirs.push(dir);
    const provider = new FakeLLM();
    const core = new Core({ dataDir: dir.dir, persona: makeFakePersona(),
      provider: Object.assign(provider, { contextWindow: () => 1000, estimateTokens: () => 7 }),
      model: { model: 'test-model', thinking: false, contextWindow: 2000, maxTokens: 100 } });
    cores.push(core);
    expect(core.loop.contextGauge().hardTokens).toBe(900);
  });

  it('stops each World once even when callers request shutdown concurrently', async () => {
    const { core } = build();
    let stops = 0;
    const world = makeFakeIO('probe');
    world.stop = async () => { stops++; };
    await core.mount(world);
    await core.start();
    const first = core.stop();
    expect(core.stop()).toBe(first);
    await first;
    expect(stops).toBe(1);
    await expect(core.start()).rejects.toThrow('stopped');
  });

  it('runs the public example, restores context, and writes no retired ledgers', async () => {
    const dir = makeTmpDir(); dirs.push(dir);
    const provider = new FakeLLM(); provider.script(textReply('answer'));
    const output: string[] = [];
    const example = createExample({ dataDir: dir.dir, provider, model: { model: 'test-model', thinking: false }, onText: text => output.push(text) });
    cores.push(example.core);
    await example.start(); await example.send('hello');
    await vi.waitFor(() => expect(output.join('')).toBe('answer'));
    await example.stop();
    const resumed = createExample({ dataDir: dir.dir, provider: new FakeLLM(), model: { model: 'test-model', thinking: false }, onText: () => {} });
    cores.push(resumed.core); await resumed.start();
    await vi.waitFor(() => expect(JSON.stringify(resumed.core.session.records)).toContain('answer'));
    const files = readdirSync(dir.dir, { recursive: true }).map(String);
    expect(files.filter(path => /(?:usage|toolcalls|transcript)\.jsonl$/.test(path))).toEqual([]);
  });
});
