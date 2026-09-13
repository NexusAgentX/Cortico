/**
 * 扩展运行时怎么 import 框架:`cortico/<src 下路径>` → `<仓库>/src/<路径>`,而且解析出来的
 * 必须是框架自己那一份实例(钩子把结果交给链上下一个,不短路)。
 *
 * 两处都要成立:主进程(装载器 import 扩展那一下)与扩展 fork 出来的子进程。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExtensions } from '../../src/extensions.ts';
import { RESOLVER_URL, childExecArgv } from '../../src/extensions/runtime.ts';
import { nowIso } from '../../src/core/util.ts';
import { installFixture } from '../fixtures/extensions/install.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'extension-runtime-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('cortico/* 解析', () => {
  it('装载器 import 扩展时 cortico/core/util.ts 解析得到,拿到的是能用的框架导出', async () => {
    installFixture(root, 'world-imports-framework');
    const set = await loadExtensions(root);
    expect(set.records[0]).toMatchObject({ loaded: true, worldId: 'imports-framework' });
    const borrowed = (set.worlds[0] as unknown as { nowIso: typeof nowIso }).nowIso;
    expect(borrowed('UTC')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('子进程里也解析得到,且与直接 import 是同一个实例', () => {
    // "同一份实例"只在一条普通的 Node ESM 链上谈得上:vitest 里框架源码走的是 vite 的
    // 模块图,扩展走的是 Node 原生 import,两边本来就是两张表。夹具自己比对身份,不等
    // 就以退出码 2 收场。
    const fixture = join(repoRoot, 'tests/fixtures/extensions/child-import.mjs');
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--import', RESOLVER_URL, fixture], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe('function');
  });

  it('childExecArgv:父进程的加载器照抄,末尾挂上解析器本身', () => {
    const argv = childExecArgv();
    expect(argv.slice(-2)).toEqual(['--import', RESOLVER_URL]);
    expect(argv.length).toBeGreaterThanOrEqual(4);
  });
});
