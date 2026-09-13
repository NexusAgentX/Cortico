/**
 * 监管循环测试用的假子进程。它冒充 src/launcher.ts,行为由 CORTICO_FAKE_MODE 说了算:
 *
 *   ready-restart   报 data 目录,请求重启(标志文件 + IPC),干净退出
 *   flag-only       报 data 目录,只落标志文件不发 IPC,再退出(冒充"消息发出前被硬杀")
 *   clean           报 data 目录,干净退出
 *   crash           报 data 目录,以非零码退出
 *
 * 每跑一次往 CORTICO_FAKE_LOG 追一行,测试据此数它被起了几次。
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.env.CORTICO_FAKE_MODE ?? 'clean';
const dataDir = process.env.CORTICO_FAKE_DATA_DIR ?? '';
const logFile = process.env.CORTICO_FAKE_LOG ?? '';

if (logFile) appendFileSync(logFile, `${mode}\n`);
if (dataDir) process.send?.({ type: 'cortico:ready', dataDir });

// 第二次起来一律干净退出,免得测试里转不完。
const runs = process.env.CORTICO_FAKE_LOG
  ? (await import('node:fs')).readFileSync(logFile, 'utf8').trim().split('\n').length
  : 1;
const effective = runs > 1 ? 'clean' : mode;

if (effective === 'ready-restart') {
  writeFileSync(join(dataDir, '.restart-request'), 'test\n');
  process.send?.({ type: 'cortico:restart' });
} else if (effective === 'flag-only') {
  writeFileSync(join(dataDir, '.restart-request'), 'test\n');
}

process.exit(effective === 'crash' ? 3 : 0);
