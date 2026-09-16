/** 服务端注入进 `<html>` 开标签的那两样：界面语言与部署默认配色方案。 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebApp } from '../../src/web/server.ts';
import { nullLogger } from '../../src/core/util.ts';
import { FakeStore } from './fakes.ts';
import type { Language } from '../../src/core/language.ts';

const dirs: string[] = [];
const apps: WebApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function openTag(opts: { language?: Language; defaultScheme?: string }): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'webtest-index-'));
  dirs.push(dir);
  const app = new WebApp({
    store: new FakeStore(),
    memoryDir: dir,
    dataDir: dir,
    log: nullLogger(),
    getStatus: () => ({}),
    ...opts,
  });
  apps.push(app);
  const port = await app.start(0);
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  return /<html[^>]*>/.exec(html)?.[0] ?? '';
}

describe('首页 <html> 开标签', () => {
  it('语言与方案 id 一起进开标签', async () => {
    expect(await openTag({ language: 'en', defaultScheme: 'crab-daisy' }))
      .toBe('<html lang="en" data-default-scheme="crab-daisy">');
  });

  it('没给方案就只有语言,属性不出现', async () => {
    expect(await openTag({ language: 'zh' })).toBe('<html lang="zh-CN">');
  });

  it('方案 id 越出 [a-z0-9-] 就整条丢掉', async () => {
    expect(await openTag({ language: 'zh', defaultScheme: 'a" onload="x' }))
      .toBe('<html lang="zh-CN">');
  });
});
