/**
 * 单实例锁按 dataDir 隔离，防止同一数据目录被多个进程并发写入。
 * 使用 wx 排他创建；陈旧锁通过临时文件、rename 和读回核对接管，竞争失败则拒绝启动。
 * force 仅放行当前进程，不取得锁所有权，退出时不删除其他实例的锁。锁 startedAt 早于本机开机时刻时按陈旧锁处理，避免 PID 复用误判。
 * verify 检测锁丢失或被接管并报告 error；丢失时补写，被接管时不争抢。
 */
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
import type { Logger } from './types.ts';
import { nullLogger } from './util.ts';

export const INSTANCE_LOCK_FILE = 'instance.lock';

/** 运行期自检的巡查周期。锁失守到被说出来最多隔这么久。 */
const VERIFY_INTERVAL_MS = 60_000;

interface LockPayload {
  pid: number;
  startedAt: string;
  argv: string[];
}

export interface InstanceLock {
  /** 锁文件路径(诊断用) */
  readonly file: string;
  /** 这把锁归不归我。被 --force-second-instance 放行的第二个实例不拥有它。 */
  readonly owns: boolean;
  /**
   * 运行期自检:锁文件还在不在、还认不认我。被删了补写回来,被别人接管了只报事实。
   * 同一次失守只报一条 error,恢复正常后重新武装。
   */
  verify(): void;
  /** 释放:只删自己写的那把锁 */
  release(): void;
}

/** 那个 pid 还活着吗。signal 0 只做权限与存在性检查,不真的发信号。 */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 进程在,只是不归我管——照样算活着
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 这把锁是不是"上一个还活着的实例"写的。
 *
 * pid 活着还不够:整机重启之后 pid 会被复用。锁自报的启动时刻早于本机开机时刻,
 * 那个 pid 就必然是别人 —— 按陈旧锁处理。时刻读不出来时退回只看 pid(宁可多拦)。
 */
function ownerStillRunning(p: LockPayload): boolean {
  if (!isAlive(p.pid)) return false;
  const startedAt = Date.parse(p.startedAt);
  if (Number.isNaN(startedAt)) return true;
  const bootedAt = Date.now() - uptime() * 1000;
  return startedAt >= bootedAt;
}

function readPayload(file: string): LockPayload | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockPayload>;
    if (!Number.isInteger(raw.pid)) return null;
    return {
      pid: raw.pid as number,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '(未记录)',
      argv: Array.isArray(raw.argv) ? raw.argv.map(String) : [],
    };
  } catch {
    return null;
  }
}

/** 排他创建。返回 false = 文件已经在了(别人先到)。其余错误照抛。 */
function createExclusive(file: string, payload: LockPayload): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try {
    writeSync(fd, JSON.stringify(payload, null, 2), null, 'utf8');
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * 接管一把陈旧锁:写临时文件再 rename 顶上去,然后**读回来核对**。
 * 两个进程同时接管同一把陈旧锁时,后 rename 的那个赢,读回不是自己就认输。
 */
function takeOver(file: string, payload: LockPayload): boolean {
  const tmp = `${file}.${payload.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch {
    try { rmSync(tmp); } catch { /* 临时文件删不掉不影响判定 */ }
    return false;
  }
  return readPayload(file)?.pid === payload.pid;
}

/**
 * 取锁。已经有一个活着的实例占着就 **throw**,错误里带对方的 pid 与启动时刻。
 *
 * `force` 是显式逃生口(命令行 `--force-second-instance`):越过守卫,但仍留一条
 * error 说明是谁放行的——两个实例同时跑的后果不会因为是故意的就变小。被放行的
 * 这个**不拥有锁**:锁仍归第一个实例,它退出时也不去动那个文件。
 */
export function acquireInstanceLock(
  dataDir: string,
  opts: { force?: boolean; log?: Logger } = {},
): InstanceLock {
  const log = opts.log ?? nullLogger();
  const file = join(dataDir, INSTANCE_LOCK_FILE);
  const mine: LockPayload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    argv: process.argv.slice(1),
  };

  let owns = createExclusive(file, mine);
  if (!owns) {
    const existing = readPayload(file);
    if (existing && ownerStillRunning(existing)) {
      if (!opts.force) {
        throw new Error(
          `同一个数据目录已经有一个实例在跑(pid ${existing.pid},启动于 ${existing.startedAt})。` +
          `先把它停掉;确实要并存就加 --force-second-instance。锁文件:${file}`,
        );
      }
      log.error('已有实例在跑,按 --force-second-instance 强行并存(锁仍归对方)', {
        otherPid: existing.pid,
        otherStartedAt: existing.startedAt,
        file,
      });
    } else {
      // 陈旧锁:写锁的进程已经不在,或那个 pid 是整机重启后被复用的。
      owns = takeOver(file, mine);
      if (owns) {
        log.warn('接管陈旧的实例锁:写锁的进程已经不在了(上一次没退干净)', {
          stalePid: existing?.pid ?? null,
          staleStartedAt: existing?.startedAt ?? null,
          unreadable: existing === null,
          file,
        });
      } else {
        // 接管这一步输给了另一个同时启动的进程 —— 那就是活着的第一个实例。
        const winner = readPayload(file);
        if (!opts.force) {
          throw new Error(
            `同一个数据目录已经有一个实例在跑(pid ${winner?.pid ?? '未知'},抢锁时被它先落定)。` +
            `先把它停掉;确实要并存就加 --force-second-instance。锁文件:${file}`,
          );
        }
        log.error('抢锁时被另一个同时启动的实例先落定,按 --force-second-instance 强行并存', {
          otherPid: winner?.pid ?? null,
          file,
        });
      }
    }
  }

  let released = false;
  /** 同一次失守只报一条 error;锁恢复正常后重新武装。 */
  let breachReported = false;

  const verify = (): void => {
    if (released || !owns) return;
    const now = existsSync(file) ? readPayload(file) : null;
    if (now?.pid === mine.pid) {
      breachReported = false;
      return;
    }
    if (breachReported) return;
    breachReported = true;
    if (now === null) {
      // 补写回来:守卫没了,下一个启动的进程就会一路畅通。
      const rewritten = createExclusive(file, mine) || takeOver(file, mine);
      log.error('实例锁在运行期消失了,已补写回来。这段时间里第二个实例可以无阻拦启动', {
        file,
        rewritten,
      });
      return;
    }
    // 不抢回来:互相覆盖只会让两个实例都以为自己是唯一那个。
    log.error('实例锁在运行期被别的进程接管了,说明有第二个实例带着同一个数据目录在跑', {
      minePid: mine.pid,
      nowPid: now.pid,
      nowStartedAt: now.startedAt,
      file,
    });
  };

  const timer = owns ? setInterval(verify, VERIFY_INTERVAL_MS) : null;
  timer?.unref?.();

  const release = (): void => {
    if (released) return;
    released = true;
    if (timer) clearInterval(timer);
    // 摘掉自己的退出钩子:acquire 反复调用时(测试、以及 bot 重启不重进程的路径)
    // 钩子会一直挂在 process 上累积。
    process.off('exit', release);
    if (!owns) return;
    // 只删自己那把:锁被别人接管过之后,不该由先退的那个删掉。
    const now = existsSync(file) ? readPayload(file) : null;
    if (now?.pid !== mine.pid) return;
    try {
      rmSync(file);
    } catch {
      // 删不掉只会留一把陈旧锁,下次启动能自动接管
    }
  };
  process.on('exit', release);
  return { file, owns, verify, release };
}
