/**
 * 与启动器(`bin/cortico.mjs`)之间的那点协议:这次退出要不要被拉起来。
 *
 * 两条证据,启动器认任一条:
 *
 *  - **IPC 消息**。它是主路——启动器由此不必知道 data 目录在哪,也就不必在起进程之前
 *    先跑一趟完整的部署解析去问。
 *  - **标志文件**。它是兜底:请求重启的第一步就落盘,消息发出前被硬杀也还认得出。
 *
 * 裸 `pnpm start` 起的进程没有 IPC 通道,那时只落文件。
 *
 * 发消息前先看 `CORTICO_SUPERVISED`,**不能只看 `process.send` 在不在**:别的宿主也可能
 * 用 fork 起我们并把那条通道用作自己的协议(vitest 的 worker 就是),往里塞我们的消息会
 * 把对方的反序列化打死。那个变量是我们的启动器设的,认它才认得准。
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RESTART_FLAG_FILE = '.restart-request';

/** 启动器起进程时设这个变量;控制台的重启键靠它判断「退出后会不会被拉起来」。 */
export const SUPERVISED_ENV = 'CORTICO_SUPERVISED';

/** 想重启。与 bin/cortico.mjs 的 `RESTART_MESSAGE` 是同一个字面量。 */
export const RESTART_MESSAGE = 'cortico:restart';
/** 报出自己的 data 目录,好让启动器找得到兜底的标志文件。同上,字面量两边对齐。 */
export const READY_MESSAGE = 'cortico:ready';

export function isSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SUPERVISED_ENV] === '1' || env[SUPERVISED_ENV] === 'true';
}

/** 只往我们自己的启动器发消息;别人用 fork 起我们时那条通道不归我们。 */
function notifyLauncher(message: { type: string; dataDir?: string }, env = process.env): void {
  if (!isSupervised(env)) return;
  process.send?.(message);
}

/** 起来之后报一次 data 目录。没被启动器管着时什么都不做。 */
export function announceDataDir(dataDir: string, env = process.env): void {
  notifyLauncher({ type: READY_MESSAGE, dataDir }, env);
}

/** 落下重启标志并告诉启动器。随后的规范关机退出进程,启动器把它拉回来。 */
export function requestRestart(dataDir: string, env = process.env): void {
  writeFileSync(join(dataDir, RESTART_FLAG_FILE), new Date().toISOString() + '\n', 'utf8');
  notifyLauncher({ type: RESTART_MESSAGE }, env);
}

export function consumeBootFlags(dataDir: string): void {
  const restartFlag = join(dataDir, RESTART_FLAG_FILE);
  if (existsSync(restartFlag)) {
    try {
      rmSync(restartFlag);
    } catch {
      // 启动器才是这个标志的权威消费者;残留一份对裸 pnpm start 无害。
    }
  }
}
