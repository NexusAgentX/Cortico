// @ts-check
/**
 * 操作员那一层的启动器:选部署、把依赖与控制台产物补齐、起进程、听重启。
 *
 * 它是**纯 JS 零依赖**,`node_modules` 还不存在时也跑得起来——第一步就是把依赖装上,
 * 所以自己不能有依赖。`start.bat` 与 `start.sh` 只是两行壳,逻辑一份都不许留在那边。
 *
 * 与 `pnpm start <bot>` 的分工:那条是原语,服务器上交给 systemd 就够了;这一层管的是
 * 菜单、装依赖、开浏览器、按重启键之后把进程拉回来。
 *
 * **崩溃不自动重启。** 只有子进程明说要重启才重起。进程自己死掉是需要人看一眼的事,
 * 悄悄拉回来只会让同一个故障在日志里刷屏,还盖掉第一现场。
 */
import { spawnSync, fork } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { emitKeypressEvents } from 'node:readline';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根:本文件在 `<根>/bin/` 下。 */
export const REPO_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));

/** 子进程说自己想重启用的 IPC 消息;与 src/boot.ts 的 `RESTART_MESSAGE` 是同一个字面量。 */
export const RESTART_MESSAGE = 'cortico:restart';
/** 子进程报出自己的 data 目录用的 IPC 消息,父进程靠它找兜底的标志文件。 */
export const READY_MESSAGE = 'cortico:ready';
/** 重启标志文件名;与 src/boot.ts 的 `RESTART_FLAG_FILE` 是同一个字面量。 */
export const RESTART_FLAG_FILE = '.restart-request';

const MIN_NODE_MAJOR = 22;

// ---------------------------------------------------------------------------
// 纯判断(可测,不碰进程)
// ---------------------------------------------------------------------------

/**
 * 这次子进程退出之后要不要再起一遍。
 *
 * 只认「子进程明说要重启」这一件事,两条证据任一成立即可:IPC 消息,或它落在 data 目录里
 * 的标志文件。文件那条是给「消息发出前就被硬杀」兜底的——请求重启的第一步就是落盘。
 *
 * 崩溃、非零退出、被信号打死,一律不重起。
 *
 * @param {{ askedRestart: boolean, dataDir: string | null, exists?: (path: string) => boolean }} state
 * @returns {boolean}
 */
export function shouldRelaunch(state) {
  if (state.askedRestart) return true;
  if (!state.dataDir) return false;
  const exists = state.exists ?? existsSync;
  return exists(join(state.dataDir, RESTART_FLAG_FILE));
}

/**
 * 从命令行里挑出部署名。第一个不以 `-` 开头的参数就是它;其余原样透传给 launcher。
 *
 * @param {readonly string[]} argv 已去掉 node 与脚本自身的那一段
 * @returns {{ bot: string | null, passthrough: string[] }}
 */
export function parseArgs(argv) {
  const bot = argv.find((a) => !a.startsWith('-')) ?? null;
  return { bot, passthrough: argv.filter((a) => a !== bot) };
}

/**
 * 名字、清单、这是不是个交互终端 → 到底启动哪一个。
 *
 * `{ kind: 'ask' }` 表示要弹菜单;非交互时不弹,把可选项写进错误里,让人在命令行上指定。
 *
 * @param {{ bot: string | null, available: readonly string[], interactive: boolean }} input
 * @returns {{ kind: 'run', bot: string } | { kind: 'ask' } | { kind: 'error', message: string }}
 */
export function chooseBot(input) {
  const { bot, available, interactive } = input;
  if (available.length === 0) {
    return { kind: 'error', message: '部署根下没有可启动的 bot。一份部署 = 一个含 deployment.json 的目录。' };
  }
  if (bot) {
    if (available.includes(bot)) return { kind: 'run', bot };
    return { kind: 'error', message: `没有这个 bot: ${bot}。可选:${available.join(' / ')}` };
  }
  if (available.length === 1) return { kind: 'run', bot: available[0] };
  if (interactive) return { kind: 'ask' };
  return {
    kind: 'error',
    message: `有多份部署,非交互终端上要指定启动哪一个:${available.join(' / ')}`,
  };
}

/**
 * 用哪个命令调 pnpm。corepack 优先(版本由 package.json 的 packageManager 钉死,
 * 用户不必自己先装);没有 corepack 就退到 PATH 上的 pnpm。
 *
 * Node 25 起不再自带 corepack,所以「没有 corepack」不等于「Node 太旧」——这条分支的
 * 存在就是为了不再给那些人反向指路。
 *
 * @param {(cmd: string) => boolean} has
 * @returns {{ command: string, prefix: string[] } | null}
 */
export function resolvePnpm(has) {
  if (has('corepack')) return { command: 'corepack', prefix: ['pnpm'] };
  if (has('pnpm')) return { command: 'pnpm', prefix: [] };
  return null;
}

/** 没有 pnpm 时说人话:分清「Node 太旧」与「Node 够新但 corepack 被拿掉了」。 */
export function pnpmMissingMessage(nodeMajor = Number(process.versions.node.split('.')[0])) {
  if (nodeMajor < MIN_NODE_MAJOR) {
    return `Node ${process.versions.node} 太旧,需要 ${MIN_NODE_MAJOR}+。下载 https://nodejs.org`;
  }
  return '找不到 pnpm。Node 25 起不再自带 corepack,装一个:npm i -g pnpm';
}

// ---------------------------------------------------------------------------
// 跑起来
// ---------------------------------------------------------------------------

/** @param {string} cmd */
function onPath(cmd) {
  const probe = process.platform === 'win32'
    ? spawnSync('where', [cmd], { stdio: 'ignore', windowsHide: true, shell: false })
    : spawnSync('command', ['-v', cmd], { stdio: 'ignore', shell: '/bin/sh' });
  return probe.status === 0;
}

/**
 * 同步跑一条 pnpm 命令,输出直接落到本窗口。
 * @param {{ command: string, prefix: string[] }} pnpm
 * @param {string[]} args
 */
function runPnpm(pnpm, args) {
  const result = spawnSync(pnpm.command, [...pnpm.prefix, ...args], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    // Windows 上 corepack 与 pnpm 都是 .cmd 垫片,只能经 shell 起。
    shell: process.platform === 'win32',
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
  });
  return result.status ?? 1;
}

/**
 * 跑一条 pnpm 命令并把 stdout 收回来(菜单要的部署清单走这条)。
 * @param {{ command: string, prefix: string[] }} pnpm
 * @param {string[]} args
 */
function readPnpm(pnpm, args) {
  const result = spawnSync(pnpm.command, [...pnpm.prefix, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
  });
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(' ')} 失败:\n${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout;
}

/**
 * 方向键菜单。一份代码两个平台——这正是 pick-bot.ps1 存在过的唯一理由。
 * @param {readonly string[]} items
 * @returns {Promise<string | null>} null = 操作员按了 Esc
 */
export function promptChoice(items, out = process.stdout, input = process.stdin) {
  return new Promise((done) => {
    let idx = 0;
    // 显式装 keypress。`createInterface` 只在 input 是 TTY 时顺手装上,靠那个副作用会让
    // 这里在非 TTY 上一声不响地永远等下去;而这里也不需要 readline 的行编辑。
    emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    const draw = (first = false) => {
      if (!first) out.write(`\u001b[${items.length}A`);
      for (const [i, name] of items.entries()) {
        const mark = i === idx ? '\u001b[36m>' : ' ';
        out.write(`  ${mark} ${name}\u001b[0m\u001b[K\n`);
      }
    };
    const finish = (/** @type {string | null} */ value) => {
      if (input.isTTY) input.setRawMode(false);
      input.removeListener('keypress', onKey);
      input.pause();
      done(value);
    };
    /** @type {(chunk: unknown, key: { name?: string, ctrl?: boolean }) => void} */
    const onKey = (chunk, key) => {
      if (!key) return;
      if (key.name === 'up' && idx > 0) { idx--; draw(); }
      else if (key.name === 'down' && idx < items.length - 1) { idx++; draw(); }
      else if (key.name === 'return') finish(items[idx]);
      else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) finish(null);
    };
    input.on('keypress', onKey);
    input.resume();
    out.write('\n  可启动的 bot:  ↑↓ 移动  Enter 确认  Esc 取消\n\n');
    draw(true);
  });
}

/**
 * 监管循环:起子进程,只在它明说要重启时再起一遍。
 *
 * `entry` 与 `execArgv` 摊开是为了可测——测试拿一个假子进程打完这四条路
 * (要重启 / 干净退出 / 崩溃 / 硬杀但标志文件在),不必真起一个 bot。
 *
 * @param {string} bot
 * @param {string[]} passthrough
 * @param {boolean} firstRunOpensBrowser
 * @param {{ entry?: string, execArgv?: string[], log?: (s: string) => void, warn?: (s: string) => void }} [opts]
 * @returns {Promise<number>}
 */
export async function supervise(bot, passthrough, firstRunOpensBrowser, opts = {}) {
  const entry = opts.entry ?? join(REPO_ROOT, 'src', 'launcher.ts');
  const execArgv = opts.execArgv ?? ['--import', 'tsx'];
  const log = opts.log ?? console.log;
  const warn = opts.warn ?? console.error;
  let openBrowser = firstRunOpensBrowser;
  for (;;) {
    let askedRestart = false;
    /** @type {string | null} */
    let dataDir = null;

    const child = fork(entry, [bot, ...passthrough], {
      cwd: REPO_ROOT,
      execArgv,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: {
        ...process.env,
        CORTICO_SUPERVISED: '1',
        CORTICO_START_PAUSED: process.env.CORTICO_START_PAUSED ?? '1',
        CORTICO_OPEN_BROWSER: openBrowser ? '1' : '0',
      },
    });

    child.on('message', (/** @type {unknown} */ msg) => {
      if (typeof msg !== 'object' || msg === null) return;
      const m = /** @type {{ type?: string, dataDir?: string }} */ (msg);
      if (m.type === READY_MESSAGE && typeof m.dataDir === 'string') dataDir = m.dataDir;
      if (m.type === RESTART_MESSAGE) askedRestart = true;
    });

    // Windows 上 Ctrl+C 发给整个控制台进程组,父子都收得到。父在这里**只是不退**:
    // 收尾归子进程那套仪式管,父等它自己走完,否则世界来不及落盘。
    const hold = () => {};
    process.on('SIGINT', hold);
    process.on('SIGTERM', hold);

    const code = await new Promise((r) => child.once('exit', (c, signal) => r(signal ? `信号 ${signal}` : c)));
    process.off('SIGINT', hold);
    process.off('SIGTERM', hold);

    if (!shouldRelaunch({ askedRestart, dataDir })) {
      if (code !== 0) {
        warn(`\n进程退出(${code})。崩溃不自动重启:先看一眼日志,再决定要不要起。`);
        return typeof code === 'number' ? code : 1;
      }
      log('\n进程已退出。');
      return 0;
    }

    if (dataDir) rmSync(join(dataDir, RESTART_FLAG_FILE), { force: true });
    openBrowser = false;
    log(`\n[重启] 正在重新拉起 ${bot}。回来仍是暂停态,去控制台点「继续」上线。\n`);
  }
}

async function main() {
  const { bot: requested, passthrough } = parseArgs(process.argv.slice(2));

  const pnpm = resolvePnpm(onPath);
  if (!pnpm) {
    console.error(pnpmMissingMessage());
    return 1;
  }

  if (!existsSync(join(REPO_ROOT, 'node_modules'))) {
    console.log('[首次运行] 正在安装依赖 pnpm install ...\n');
    const code = runPnpm(pnpm, ['install']);
    if (code !== 0) return code;
  }

  // 控制台产物不进版本控制,新检出没有。不补的话首页只会停在"正在载入"。
  if (!existsSync(join(REPO_ROOT, 'dist', 'web', 'asset-manifest.json'))) {
    console.log('[首次运行] 正在构建控制台 pnpm build:web ...\n');
    const code = runPnpm(pnpm, ['build:web']);
    if (code !== 0) return code;
  }

  const available = readPnpm(pnpm, ['--silent', 'bots']).split('\n').map((s) => s.trim()).filter(Boolean);
  let choice = chooseBot({ bot: requested, available, interactive: process.stdin.isTTY === true });
  if (choice.kind === 'ask') {
    const picked = await promptChoice(available);
    if (picked === null) {
      console.log('\n已取消。');
      return 1;
    }
    choice = { kind: 'run', bot: picked };
  }
  if (choice.kind === 'error') {
    console.error(choice.message);
    return 1;
  }

  console.log(`\n  启动: ${choice.bot}`);
  console.log('  启动后是暂停态,去控制台点「继续」才上线;停止用控制台的「关机」键。');
  console.log('  ⚠ 别直接关本窗口:那是硬杀,Minecraft 世界会回档到上次自动存档。\n');
  return supervise(choice.bot, passthrough, process.env.CORTICO_OPEN_BROWSER !== '0');
}

// 被 import(测试)时不跑 main。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (err) => {
    console.error('启动失败:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
