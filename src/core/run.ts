/**
 * run:一次进程存活。`data/runs/<run>/` 装这次运行的全部记录;`data/runs/index.jsonl`
 * 每次开机与关机各一行。暂停不切 run,重启切。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { nowIso } from './util.ts';

export interface RunInfo {
  id: string;
  dir: string;
  runsDir: string;
  startedAt: string;
  previousRun: string | null;
}

export interface RunOpenMeta {
  timezone: string;
  bot: string;
  repoRoot?: string;
}

export interface RunCloseSummary {
  endedAt: string;
  lastCursor: number;
  /** 关机仪式是否各步走完 */
  complete: boolean | null;
  reason: string;
}

const RUN_ID = /^r-\d{8}-\d{6}-[0-9a-f]{4}$/;

export function runsDirOf(dataDir: string): string {
  return join(dataDir, 'runs');
}

/** 已存在的 run id,按时间升序(id 自带时间戳,字典序即时间序)。 */
export function listRuns(dataDir: string): string[] {
  const dir = runsDirOf(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => RUN_ID.test(name)).sort();
}

function gitSha(repoRoot: string | undefined): string | null {
  if (!repoRoot) return null;
  try {
    const head = readFileSync(join(repoRoot, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head.slice(0, 12);
    const ref = head.slice(4).trim();
    const refFile = resolve(repoRoot, '.git', ref);
    if (existsSync(refFile)) return readFileSync(refFile, 'utf8').trim().slice(0, 12);
    const packed = join(repoRoot, '.git', 'packed-refs');
    if (!existsSync(packed)) return null;
    for (const line of readFileSync(packed, 'utf8').split('\n')) {
      const [sha, name] = line.trim().split(' ');
      if (name === ref) return sha.slice(0, 12);
    }
  } catch {
    // 不在 git 仓库里就不记
  }
  return null;
}

/** 生成 run id、建目录、在 index.jsonl 记一行开机。 */
export function openRun(dataDir: string, meta: RunOpenMeta): RunInfo {
  const runsDir = runsDirOf(dataDir);
  mkdirSync(runsDir, { recursive: true });
  const previous = listRuns(dataDir);
  const startedAt = nowIso(meta.timezone);
  const stamp = startedAt.slice(0, 19).replace(/[-:T]/g, '');
  const id = `r-${stamp.slice(0, 8)}-${stamp.slice(8, 14)}-${randomBytes(2).toString('hex')}`;
  const dir = join(runsDir, id);
  mkdirSync(dir, { recursive: true });
  const previousRun = previous.length ? previous[previous.length - 1] : null;
  appendFileSync(join(runsDir, 'index.jsonl'), JSON.stringify({
    run: id,
    startedAt,
    bot: meta.bot,
    pid: process.pid,
    gitSha: gitSha(meta.repoRoot),
    previousRun,
  }) + '\n', 'utf8');
  return { id, dir, runsDir, startedAt, previousRun };
}

/** 关机时补一行;崩溃的 run 没有这一行,读者按 events.jsonl 末行自己算区间。 */
export function closeRun(run: RunInfo, summary: RunCloseSummary): void {
  appendFileSync(join(run.runsDir, 'index.jsonl'), JSON.stringify({ run: run.id, ...summary }) + '\n', 'utf8');
}

/** run.json:World 清单与配置指纹这类整场不变的事实。 */
export function writeRunJson(run: RunInfo, data: Record<string, unknown>): void {
  writeFileSync(join(run.dir, 'run.json'), JSON.stringify({ run: run.id, startedAt: run.startedAt, previousRun: run.previousRun, ...data }, null, 2), 'utf8');
}
