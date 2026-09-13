/**
 * 单实例守卫拒绝同一实例的并发启动。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireInstanceLock, INSTANCE_LOCK_FILE } from '../../src/core/instance-lock.ts';
import { nullLogger } from '../../src/core/util.ts';
import { makeTmpDir } from './helpers.ts';

function spyLogger() {
  const base = nullLogger();
  const calls: Array<{ level: string; msg: string; data?: unknown }> = [];
  const mk = (level: string) => (msg: string, data?: unknown) => { calls.push({ level, msg, data }); };
  return {
    calls,
    log: { ...base, debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error'), child: () => base },
  };
}

/** 找一个当下确实不存在的 pid(Windows 上 pid 是 4 的倍数,挑个大的往下试)。 */
function deadPid(): number {
  for (let pid = 999_000; pid > 1000; pid -= 4) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('找不到一个空闲 pid');
}

describe('acquireInstanceLock', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  const held: Array<{ release(): void }> = [];
  beforeEach(() => (tmp = makeTmpDir()));
  afterEach(() => {
    for (const lock of held.splice(0)) lock.release();
    tmp.cleanup();
  });

  it('第一个实例拿到锁,锁文件里记着自己的 pid', () => {
    const lock = acquireInstanceLock(tmp.dir);
    held.push(lock);
    expect(existsSync(lock.file)).toBe(true);
    expect(JSON.parse(readFileSync(lock.file, 'utf8')).pid).toBe(process.pid);
  });

  it('同一个 dataDir 起第二个:拒绝启动,错误里带第一个的 pid', () => {
    held.push(acquireInstanceLock(tmp.dir));
    expect(() => acquireInstanceLock(tmp.dir)).toThrow(new RegExp(String(process.pid)));
    expect(() => acquireInstanceLock(tmp.dir)).toThrow(/已经有一个实例在跑/);
  });

  it('陈旧锁(写锁的进程已经不在)自动接管并 warn', () => {
    const stale = deadPid();
    writeFileSync(join(tmp.dir, INSTANCE_LOCK_FILE), JSON.stringify({
      pid: stale, startedAt: '2026-08-27T13:19:00.000Z', argv: ['old'],
    }), 'utf8');
    const spy = spyLogger();
    const lock = acquireInstanceLock(tmp.dir, { log: spy.log });
    held.push(lock);
    expect(JSON.parse(readFileSync(lock.file, 'utf8')).pid).toBe(process.pid);
    const warns = spy.calls.filter((c) => c.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].data).toMatchObject({ stalePid: stale });
  });

  it('逃生口:--force-second-instance 放行,但留一条 error', () => {
    held.push(acquireInstanceLock(tmp.dir));
    const spy = spyLogger();
    const second = acquireInstanceLock(tmp.dir, { force: true, log: spy.log });
    held.push(second);
    const errors = spy.calls.filter((c) => c.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].data).toMatchObject({ otherPid: process.pid });
  });


  describe('同一实例的并发启动与锁所有权边界', () => {
    it('锁文件是排他创建的:抢锁的那一刻文件已存在就走判活分支,不覆盖', () => {
      // 排他创建(wx)使并发启动的后到者收到 EEXIST，再按锁内进程判活。
      const spy = spyLogger();
      held.push(acquireInstanceLock(tmp.dir, { log: spy.log }));
      // 第二次:文件在、pid 活着 ⇒ 必拒,且不得把锁文件改成自己的
      const before = readFileSync(join(tmp.dir, INSTANCE_LOCK_FILE), 'utf8');
      expect(() => acquireInstanceLock(tmp.dir)).toThrow(/已经有一个实例在跑/);
      expect(readFileSync(join(tmp.dir, INSTANCE_LOCK_FILE), 'utf8')).toBe(before);
    });

    it('force 不再改写锁文件:锁仍归第一个实例,第二个退出也不会把它删掉', () => {
      const first = acquireInstanceLock(tmp.dir);
      held.push(first);
      const forced = acquireInstanceLock(tmp.dir, { force: true, log: nullLogger() });
      // 锁文件仍记着第一个实例;force 只是放行,不夺权
      expect(JSON.parse(readFileSync(first.file, 'utf8')).pid).toBe(process.pid);
      expect(forced.owns).toBe(false);
      forced.release();
      // 活进程持有的锁不能被 force 覆写或在另一个进程退出时删除。
      expect(existsSync(first.file)).toBe(true);
      expect(() => acquireInstanceLock(tmp.dir)).toThrow(/已经有一个实例在跑/);
    });

    it('陈旧锁的启动时刻早于本机开机时刻:即便 pid 恰好被复用也按陈旧锁接管', () => {
      // 崩溃后重启的常见形态是整机重启,pid 被别的进程复用。只看 process.kill(pid,0)
      // 会把它误判成"上一个还活着",于是正常重启被自己的守卫拦在门外。
      writeFileSync(join(tmp.dir, INSTANCE_LOCK_FILE), JSON.stringify({
        pid: process.pid, // 一定活着
        startedAt: '1999-01-01T00:00:00.000Z', // 早于任何一次开机
        argv: ['old'],
      }), 'utf8');
      const spy = spyLogger();
      const lock = acquireInstanceLock(tmp.dir, { log: spy.log });
      held.push(lock);
      expect(JSON.parse(readFileSync(lock.file, 'utf8')).pid).toBe(process.pid);
      expect(spy.calls.some((c) => c.level === 'warn' && c.msg.includes('接管'))).toBe(true);
    });

    it('运行期锁文件被删掉:自检重新落锁并 error', () => {
      const spy = spyLogger();
      const lock = acquireInstanceLock(tmp.dir, { log: spy.log });
      held.push(lock);
      rmSync(lock.file);
      lock.verify();
      expect(existsSync(lock.file)).toBe(true);
      expect(JSON.parse(readFileSync(lock.file, 'utf8')).pid).toBe(process.pid);
      const errors = spy.calls.filter((c) => c.level === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0].msg).toContain('实例锁');
    });

    it('运行期锁被别人接管:自检 error 并报出对方 pid,不夺回来', () => {
      const spy = spyLogger();
      const lock = acquireInstanceLock(tmp.dir, { log: spy.log });
      held.push(lock);
      const other = deadPid();
      writeFileSync(lock.file, JSON.stringify({ pid: other, startedAt: 'x', argv: [] }), 'utf8');
      lock.verify();
      const errors = spy.calls.filter((c) => c.level === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0].data).toMatchObject({ nowPid: other });
      // 不抢回来:抢锁只会让两个实例互相覆盖,事实报出来即可
      expect(JSON.parse(readFileSync(lock.file, 'utf8')).pid).toBe(other);
    });

    it('自检不刷屏:同一次失守只报一次', () => {
      const spy = spyLogger();
      const lock = acquireInstanceLock(tmp.dir, { log: spy.log });
      held.push(lock);
      writeFileSync(lock.file, JSON.stringify({ pid: deadPid(), startedAt: 'x', argv: [] }), 'utf8');
      lock.verify();
      lock.verify();
      lock.verify();
      expect(spy.calls.filter((c) => c.level === 'error')).toHaveLength(1);
    });
  });

  it('释放之后可以再取;只删自己写的那把锁', () => {
    const first = acquireInstanceLock(tmp.dir);
    first.release();
    expect(existsSync(join(tmp.dir, INSTANCE_LOCK_FILE))).toBe(false);
    const second = acquireInstanceLock(tmp.dir);
    held.push(second);
    // 锁已被别人接管时,先退的那个不该把它删掉
    writeFileSync(second.file, JSON.stringify({ pid: deadPid(), startedAt: 'x', argv: [] }), 'utf8');
    second.release();
    expect(existsSync(second.file)).toBe(true);
  });
});
