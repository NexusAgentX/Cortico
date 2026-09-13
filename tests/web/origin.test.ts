/**
 * 控制台的两道本机防线:
 *  - 只绑回环:局域网地址上根本没有这个端口
 *  - 同源闸门:带外站 Origin 的写请求/WS 握手一律拒;没有 Origin 的程序化客户端放行
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import WebSocket from 'ws';
import { WebApp } from '../../src/web/server.ts';
import { nullLogger } from '../../src/core/util.ts';
import { FakeStore } from './fakes.ts';

let app: WebApp;
let port: number;
let dir: string;
let paused = false;
let pickerCalls = 0;

const post = (path: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers });

/** 连一下就断:能连上=true */
const reachable = (host: string): Promise<boolean> =>
  new Promise((resolve) => {
    const sock = connect({ host, port, timeout: 2000 });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });

/** WS 握手结果:开了 / 被拒 */
const handshake = (path: string, headers?: Record<string, string>): Promise<'open' | 'rejected'> =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, headers ? { headers } : {});
    ws.once('open', () => {
      ws.close();
      resolve('open');
    });
    ws.once('error', () => resolve('rejected'));
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'webtest-origin-'));
  app = new WebApp({
    store: new FakeStore(),
    memoryDir: dir,
    dataDir: dir,
    getStatus: () => ({}),
    run: { pause: () => { paused = true; }, resume: () => { paused = false; }, isPaused: () => paused },
    pathPicker: { pick: async () => { pickerCalls++; return null; } },
    log: nullLogger(),
  });
  port = await app.start(0);
});

afterAll(async () => {
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('控制台只绑回环', () => {
  it('缺省绑 127.0.0.1,回环连得上', async () => {
    expect(app.boundAddress).toBe('127.0.0.1');
    expect(await reachable('127.0.0.1')).toBe(true);
  });

  it('要对外露面得显式给 host', async () => {
    const other = new WebApp({
      store: new FakeStore(),
      memoryDir: dir,
      dataDir: dir,
      host: '0.0.0.0',
      getStatus: () => ({}),
      log: nullLogger(),
    });
    await other.start(0);
    try {
      expect(other.boundAddress).toBe('0.0.0.0');
    } finally {
      await other.stop();
    }
  });
});

describe('写请求的同源闸门', () => {
  it('没有 Origin 的程序化客户端照旧放行', async () => {
    const r = await post('/api/run/pause');
    expect(r.status).toBe(200);
    expect(paused).toBe(true);
  });

  it('同源页面放行', async () => {
    const r = await post('/api/run/resume', { origin: `http://127.0.0.1:${port}` });
    expect(r.status).toBe(200);
    expect(paused).toBe(false);
  });

  it('外站 Origin 拒绝,且副作用没发生', async () => {
    const r = await post('/api/run/pause', { origin: 'http://evil.example' });
    expect(r.status).toBe(403);
    expect(paused).toBe(false);
  });

  it('Origin: null(沙箱 iframe / file://)拒绝', async () => {
    const r = await post('/api/run/pause', { origin: 'null' });
    expect(r.status).toBe(403);
    expect(paused).toBe(false);
  });

  it('端口不同也算外站', async () => {
    const r = await post('/api/run/pause', { origin: `http://127.0.0.1:${port + 1}` });
    expect(r.status).toBe(403);
    expect(paused).toBe(false);
  });

  it('路径选择同样受同源闸门保护，外站请求不会打开主机对话框', async () => {
    const same = await fetch(`http://127.0.0.1:${port}/api/path-picker`, {
      method: 'POST',
      headers: { origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'directory' }),
    });
    expect(same.status).toBe(200);
    expect(pickerCalls).toBe(1);

    const foreign = await fetch(`http://127.0.0.1:${port}/api/path-picker`, {
      method: 'POST',
      headers: { origin: 'http://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'directory' }),
    });
    expect(foreign.status).toBe(403);
    expect(pickerCalls).toBe(1);
  });

  it('读接口不受闸门影响', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { origin: 'http://evil.example' },
    });
    expect(r.status).toBe(200);
  });
});

describe('WebSocket 握手的同源闸门', () => {
  it('没有 Origin 的客户端照旧放行', async () => {
    expect(await handshake('/ws/sessions')).toBe('open');
  });

  it('同源页面放行', async () => {
    expect(await handshake('/ws/sessions', { origin: `http://127.0.0.1:${port}` })).toBe('open');
  });

  it('外站 Origin 被拒', async () => {
    expect(await handshake('/ws/sessions', { origin: 'http://evil.example' })).toBe('rejected');
    expect(await handshake('/ws/debug', { origin: 'http://evil.example' })).toBe('rejected');
  });
});
