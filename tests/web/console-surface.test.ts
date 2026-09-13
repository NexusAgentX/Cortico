/**
 * 控制台表面与扩展点的分界。
 *
 * 验收的是一句话:**只喂框架级 ConsoleSurface 就能起一个可用控制台**。
 * bot 与 World 专有的面板(QQ、记忆 git、checkpoint、模型档位、入梦、重置)全都
 * 走 Console Provider;一个 provider 都不给,manifest 只剩框架能力,别的端点照常工作。
 * 最小控制台在没有任何 provider 时仍可监控和运维。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebApp } from '../../src/web/server.ts';
import { nullLogger } from '../../src/core/util.ts';
import { FakeStore } from './fakes.ts';

let app: WebApp;
let port: number;
let dir: string;
const base = () => `http://127.0.0.1:${port}`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'webtest-surface-'));
  // 刻意只给 ConsoleSurface 的必填项 + 几个框架级可选项,一个 provider 都不给
  app = new WebApp({
    store: new FakeStore(),
    memoryDir: dir,
    dataDir: dir,
    getStatus: () => ({ loop: { estTokens: 1, messageCount: 2 } }),
    run: { pause: () => {}, resume: () => {}, isPaused: () => false },
    log: nullLogger(),
  });
  port = await app.start(0);
});

afterAll(async () => {
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('只挂框架级 ConsoleSurface', () => {
  it('框架自己的端点照常工作', async () => {
    for (const p of ['/api/status', '/api/events', '/api/log', '/api/storage', '/api/worlds']) {
      const r = await fetch(`${base()}${p}`);
      expect([p, r.status]).toEqual([p, 200]);
    }
    // 暂停/继续也是框架级的:第三方 bot 一样需要能停下来
    expect((await fetch(`${base()}/api/run/pause`, { method: 'POST' })).status).toBe(200);
  });

  it('页面本身能拿到(前端按端点可用性自己降级)', async () => {
    const r = await fetch(`${base()}/`);
    expect(r.status).toBe(200);
  });

  it('没有声明的 Provider 与旧全局报价端点均不存在', async () => {
    // 没有 provider:manifest 是一份只有框架能力的空壳,不是 503
    const manifest = (await (await fetch(`${base()}/api/console/manifest`)).json()) as { providers: unknown[] };
    expect(manifest.providers).toEqual([]);
    // 随便点一个面板都是 404(没这个 provider),不是 500 也不是崩
    expect((await fetch(`${base()}/api/console/providers/world%3Aqq/panels/roster/get`)).status).toBe(404);
    expect((await fetch(`${base()}/api/pricing`)).status).toBe(404);
  });

  it('能力清单如实报出"什么都没挂",前端据此不渲染而不是显示一串 503', async () => {
    const d = (await (await fetch(`${base()}/api/capabilities`)).json()) as { capabilities: Record<string, boolean> };
    expect(d.capabilities.run).toBe(true);
    // 框架能力未挂载时如实报 false；Provider 控制面由 manifest 声明。
    for (const k of ['debug', 'sessions', 'storage', 'usage', 'config', 'worlds', 'prompts', 'toolSchemas', 'sessionControl']) {
      expect([k, d.capabilities[k]]).toEqual([k, false]);
    }
    // provider-specific 的键彻底不在了:有没有那些面板由 manifest 回答
    for (const k of ['chat', 'modulePanels', 'persona', 'checkpoints', 'reset', 'dream']) {
      expect([k, k in d.capabilities]).toEqual([k, false]);
    }
  });

  it('配置项也是框架级的,但没人声明时同样 503(不是崩)', async () => {
    expect((await fetch(`${base()}/api/config`)).status).toBe(503);
    const r = await fetch(`${base()}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group: 'core', values: {} }),
    });
    expect(r.status).toBe(503);
  });
});
