/**
 * 启动器(`bin/cortico.mjs`)里那几个纯判断。起进程、装依赖、画菜单那几段要真终端与真
 * 网络,不在这里;这里守的是「什么时候重起」「启动哪一个」「pnpm 从哪来」三条决策。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RESTART_FLAG_FILE,
  chooseBot,
  parseArgs,
  pnpmMissingMessage,
  resolvePnpm,
  shouldRelaunch,
  supervise,
} from '../bin/cortico.mjs';

describe('shouldRelaunch', () => {
  const never = () => false;

  it('子进程明说要重启就重起', () => {
    expect(shouldRelaunch({ askedRestart: true, dataDir: null, exists: never })).toBe(true);
  });

  it('IPC 没来但标志文件在:消息发出前被硬杀,照样重起', () => {
    const dataDir = '/deploy/data';
    const exists = (p: string) => p === join(dataDir, RESTART_FLAG_FILE);
    expect(shouldRelaunch({ askedRestart: false, dataDir, exists })).toBe(true);
  });

  it('崩溃不重起:没人说过要重启,标志文件也不在', () => {
    expect(shouldRelaunch({ askedRestart: false, dataDir: '/deploy/data', exists: never })).toBe(false);
  });

  it('子进程连 data 目录都没来得及报,就没有兜底可查', () => {
    expect(shouldRelaunch({ askedRestart: false, dataDir: null, exists: never })).toBe(false);
  });
});

describe('parseArgs', () => {
  it('第一个不带 - 的参数是部署名,其余透传', () => {
    expect(parseArgs(['cortiv', '--paused'])).toEqual({ bot: 'cortiv', passthrough: ['--paused'] });
  });

  it('只有开关时没有部署名', () => {
    expect(parseArgs(['--log-level=debug'])).toEqual({ bot: null, passthrough: ['--log-level=debug'] });
  });

  it('空参数表', () => {
    expect(parseArgs([])).toEqual({ bot: null, passthrough: [] });
  });
});

describe('chooseBot', () => {
  it('给了名字就用它', () => {
    expect(chooseBot({ bot: 'b', available: ['a', 'b'], interactive: true })).toEqual({ kind: 'run', bot: 'b' });
  });

  it('名字不在清单里:把可选项摆出来', () => {
    const out = chooseBot({ bot: 'zz', available: ['a', 'b'], interactive: true });
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.message).toContain('a / b');
  });

  it('只有一份部署就不问', () => {
    expect(chooseBot({ bot: null, available: ['only'], interactive: true })).toEqual({ kind: 'run', bot: 'only' });
  });

  it('多份 + 交互终端 → 弹菜单', () => {
    expect(chooseBot({ bot: null, available: ['a', 'b'], interactive: true })).toEqual({ kind: 'ask' });
  });

  it('多份 + 非交互 → 不空转,要求命令行指定并列出名字', () => {
    const out = chooseBot({ bot: null, available: ['a', 'b'], interactive: false });
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.message).toContain('a / b');
  });

  it('一份都没有', () => {
    const out = chooseBot({ bot: null, available: [], interactive: true });
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.message).toContain('deployment.json');
  });
});

describe('resolvePnpm', () => {
  it('corepack 优先:版本由 packageManager 钉死', () => {
    expect(resolvePnpm(() => true)).toEqual({ command: 'corepack', prefix: ['pnpm'] });
  });

  it('没有 corepack 就用 PATH 上的 pnpm', () => {
    expect(resolvePnpm((c: string) => c === 'pnpm')).toEqual({ command: 'pnpm', prefix: [] });
  });

  it('两个都没有', () => {
    expect(resolvePnpm(() => false)).toBeNull();
  });
});

describe('pnpmMissingMessage', () => {
  it('Node 太旧:指路 nodejs.org', () => {
    expect(pnpmMissingMessage(20)).toContain('nodejs.org');
  });

  it('Node 够新只是没 corepack:指路装 pnpm,不再反向让人升 Node', () => {
    const text = pnpmMissingMessage(25);
    expect(text).toContain('npm i -g pnpm');
    expect(text).not.toContain('nodejs.org');
  });
});

describe('监管循环(真子进程)', () => {
  const entry = fileURLToPath(new URL('./fixtures/launcher/fake-child.mjs', import.meta.url));
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  /** 起一轮监管,回退出码与子进程实际被起了几次。 */
  async function run(mode: string): Promise<{ code: number; runs: number }> {
    const dir = mkdtempSync(join(tmpdir(), 'cortico-supervise-'));
    dirs.push(dir);
    const logFile = join(dir, 'runs.log');
    writeFileSync(logFile, '');
    const previous = { ...process.env };
    Object.assign(process.env, {
      CORTICO_FAKE_MODE: mode,
      CORTICO_FAKE_DATA_DIR: dir,
      CORTICO_FAKE_LOG: logFile,
    });
    try {
      const code = await supervise('fake', [], false, { entry, execArgv: [], log: () => {}, warn: () => {} });
      const runs = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).length;
      return { code, runs };
    } finally {
      for (const k of ['CORTICO_FAKE_MODE', 'CORTICO_FAKE_DATA_DIR', 'CORTICO_FAKE_LOG']) delete process.env[k];
      Object.assign(process.env, previous);
    }
  }

  it('干净退出:起一次就收工', async () => {
    expect(await run('clean')).toEqual({ code: 0, runs: 1 });
  });

  it('子进程请求重启:再起一次', async () => {
    expect(await run('ready-restart')).toEqual({ code: 0, runs: 2 });
  });

  it('IPC 没发出去但标志文件在:照样再起一次', async () => {
    expect(await run('flag-only')).toEqual({ code: 0, runs: 2 });
  });

  it('崩溃不自动重启:只起一次,退出码原样透出去', async () => {
    expect(await run('crash')).toEqual({ code: 3, runs: 1 });
  });
});
