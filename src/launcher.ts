/**
 * 通用启动器:`pnpm start -- <bot>`。
 *
 * 启动器从一份部署目录下的 `index.ts` 默认导出加载 `BotDefinition`。部署根由
 * src/paths.ts 解析(默认 `<主仓库>/deployments`)。bot 选择属于启动器的部署配置,
 * 不属于Persona。
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOG_LEVEL_RANK, type CoreConfig, type LogLevel } from './core/types.ts';
import type { BotDefinition } from './bot.ts';
import { createBot } from './bot.ts';
import { loadDeployment } from './deploy.ts';
import { secretReader } from './core/secrets.ts';
import { announceDataDir, consumeBootFlags } from './boot.ts';
import { importBotDefinition, loadExtensions, locateBotPackage, type ActiveBotPackage } from './extensions.ts';
import { withWorlds } from './world.ts';
import { BUILTIN_WORLDS } from './worlds/index.ts';
import { providerModules, registerProviderModules } from './providers/registry.ts';
import { deploymentDir, deploymentRoot, packageDir, providerDir, providersRoot, readDeploymentManifest, repoRoot } from './paths.ts';

/** 部署根下每个含 deployment.json 的目录就是一份可启动的部署 */
export function listBots(): string[] {
  const root = deploymentRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => {
      const dir = resolve(root, name);
      return statSync(dir).isDirectory() && existsSync(resolve(dir, 'deployment.json'));
    })
    .sort();
}

/**
 * 一份部署 → 它引用的代码包 → 包里的 `BotDefinition`。
 * 部署与包是两个目录:同一个包可以背好几份部署(直播一份、测试一份)。
 * 包在仓内 `bots/` 或装在 `extensions/` 下;`botPackage` 只在后一种情况给出。
 */
async function loadBotDefinition(
  name: string,
): Promise<{ definition: BotDefinition<CoreConfig>; deployDir: string; pkgDir: string; botPackage?: ActiveBotPackage }> {
  const deployDir = deploymentDir(name);
  const manifest = readDeploymentManifest(name);
  if (!manifest) {
    throw new Error(`${resolve(deployDir, 'deployment.json')} 缺失或没有 bot 字段(它说这份部署用哪个代码包)`);
  }
  const location = locateBotPackage(repoRoot(), manifest.bot, packageDir(manifest.bot));
  const definition = await importBotDefinition(location, {
    treeHas: (id) => existsSync(resolve(packageDir(id), 'index.ts')),
  });
  return {
    definition,
    deployDir,
    pkgDir: location.pkgDir,
    ...(location.source === 'extension' ? { botPackage: { name: location.name, id: definition.id } } : {}),
  };
}

/** 用系统默认浏览器打开url(跨平台;失败静默——地址已打印) */
function openBrowser(url: string): void {
  try {
    const p = process.platform;
    const [cmd, args] =
      p === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : p === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
    spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* 打不开就算了 */ }
}

function pickBotName(): string {
  const fromArgv = process.argv.slice(2).find((a) => !a.startsWith('-'));
  const name = fromArgv || process.env.CORTICO_BOT || '';
  const available = listBots();
  if (available.length === 0) throw new Error(`${deploymentRoot()} 下没有可启动的 bot(每个 bot 需要一个 index.ts)`);
  if (!name) {
    if (available.length === 1) return available[0];
    throw new Error(`请指定要启动哪个 bot:npm start -- <${available.join(' | ')}>`);
  }
  if (!available.includes(name)) {
    throw new Error(`没有这个 bot: ${name}。可选:${available.join(' / ')}`);
  }
  return name;
}

async function main(): Promise<void> {
  if (process.argv.includes('--list')) {
    process.stdout.write(listBots().join('\n') + '\n');
    return;
  }

  const botName = pickBotName();
  const { definition: loadedDefinition, deployDir: botDir, pkgDir, botPackage } = await loadBotDefinition(botName);

  // World 实现一张表:仓内目录在前,扩展装的在后,同 id 时仓内的赢;provider 同理。
  // provider 要在装配(`createBot`)之前进注册表,那时端点表才解析得出扩展的 kind。
  // bot 包已经在上面 import 过,这里只对账。
  const extensions = await loadExtensions(repoRoot(), {
    reserved: BUILTIN_WORLDS.map((m) => m.id),
    reservedProviders: providerModules.map((m) => m.id),
    ...(botPackage ? { activeBot: botPackage } : {}),
  });
  registerProviderModules(extensions.providers);
  const definition = withWorlds(loadedDefinition, [...BUILTIN_WORLDS, ...extensions.worlds]);

  const loaded = loadDeployment(definition, botDir, repoRoot(), pkgDir, providersRoot());
  const cfg = loaded.config;

  // 启动器靠这一条知道兜底的重启标志落在哪,于是不必在起进程之前先跑一趟部署解析去问。
  announceDataDir(loaded.dataDir);

  // 日志落盘门槛:--log-level=<级别> > CORTICO_LOG > config.json
  const levelArg = process.argv.find((a) => a.startsWith('--log-level='))?.slice('--log-level='.length) ?? process.env.CORTICO_LOG;
  if (levelArg) {
    if (!(levelArg in LOG_LEVEL_RANK)) {
      console.error(`日志级别不认识: ${levelArg}(可选 ${Object.keys(LOG_LEVEL_RANK).join(' / ')})`);
      process.exit(1);
    }
    cfg.logging.file = levelArg as LogLevel;
  }

  // 重启标志必须在装配与 session 加载之前处理
  consumeBootFlags(loaded.dataDir);

  // 只有活跃 provider 声明了密钥名才硬性要求它存在:纯本地部署不被云端 key 卡死。
  const activeProvider = cfg.providers?.[cfg.activeProvider];
  if (!activeProvider) {
    console.error(
      `activeProvider="${cfg.activeProvider}" 在 providers 段里不存在(现有: ${Object.keys(cfg.providers ?? {}).join(' / ') || '无'})`,
    );
    process.exit(1);
  }
  // 密钥链与 provider 那侧同一条:进程环境 > 这个端点自己的 .env。
  const endpointDir = providerDir(cfg.activeProvider);
  if (activeProvider.secret && !secretReader(resolve(endpointDir, '.env'))(activeProvider.secret)) {
    console.error(`缺少 ${activeProvider.secret}(进程环境或 ${resolve(endpointDir, '.env')})`);
    process.exit(1);
  }

  const bot = createBot(loaded, definition, { extensions });

  // 启动即暂停(启动器默认这么起):在主循环开跑前把总线按住,不投递唤醒、
  // 事件照常落库排队,去控制台点"继续"才上线。CORTICO_START_PAUSED=1 或 --paused 触发。
  const startPaused =
    process.env.CORTICO_START_PAUSED === '1' ||
    process.env.CORTICO_START_PAUSED === 'true' ||
    process.argv.includes('--paused');
  if (startPaused) bot.core.bus.setPaused(true);

  const { port } = await bot.start();

  console.log(`\n  Bot:       ${botName}${cfg.displayName && cfg.displayName !== botName ? ` (${cfg.displayName})` : ''}`);
  if (port !== null) {
    console.log(`  控制台:    http://127.0.0.1:${port}/`);
  }
  for (const slot of bot.assembly.slots) {
    console.log(slot.mounted ? `  World:    ${slot.id}` : `  World:    ${slot.id} · 未激活(控制台「World」页可激活)`);
  }
  for (const entry of bot.assembly.missing) {
    console.log(`  World:    ${entry.id} ⚠ 未装上 — ${entry.reason}`);
  }
  for (const ext of extensions.records) {
    console.log(ext.loaded
      ? `  扩展:      ${ext.name}@${ext.version} → ${ext.kind === 'provider' ? 'provider' : ext.kind === 'bot' ? 'bot' : 'World'} ${ext.worldId}`
      : ext.idle
        ? `  扩展:      ${ext.name}@${ext.version} · bot 包,本部署未引用`
        : `  扩展:      ${ext.name} ⚠ 未加载 — ${ext.reason}`);
  }
  console.log(`  主模型:    ${bot.core.mainSessionSpec().model}`);
  if (startPaused) {
    console.log('  ⏸ 已暂停启动: 事件照常落库排队,未投递。去控制台点"继续"才开始处理。');
  }
  console.log('');

  // 自动打开浏览器(启动器默认这么起,像 ComfyUI):此刻 web server 已 listening。
  const openBrowserFlag =
    process.env.CORTICO_OPEN_BROWSER === '1' ||
    process.env.CORTICO_OPEN_BROWSER === 'true' ||
    process.argv.includes('--open');
  if (openBrowserFlag && port !== null) openBrowser(`http://127.0.0.1:${port}/`);

  // 外层收尾期限须覆盖引擎 shutdown RPC 与 MC 服务端存档的预算。分步期限由 bot.shutdown() 管理，此期限处理整个编排未返回的情况。
  const SHUTDOWN_GRACE_MS = 35_000;
  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n收到${sig},正在按次序收尾…(session 已实时落盘)`);
    let code = 0;
    try {
      const report = await Promise.race([
        bot.shutdown(sig),
        new Promise<null>((r) => setTimeout(() => r(null), SHUTDOWN_GRACE_MS)),
      ]);
      if (!report) {
        console.log(`  ⚠ 收尾超过 ${SHUTDOWN_GRACE_MS / 1000} 秒仍未回来,强制退出。`);
        code = 1;
      } else {
        for (const step of report.steps) {
          console.log(`  ${step.ok ? '✓' : '✗'} ${step.label}${step.ok ? '' : ` — ${step.detail ?? '未完成'}`}`);
        }
        for (const check of report.externalChecks) {
          if (check.status === 'verified-ended') {
            console.log(`  ✓ ${check.label} — ${check.detail}`);
            continue;
          }
          console.log(`  ⚠ [P0] ${check.label} — ${check.status}: ${check.detail}`);
          console.log(`    人工动作: ${check.manualAction}`);
        }
        if (!report.complete) code = 1;
      }
    } catch (e) {
      console.error('收尾出错:', e instanceof Error ? e.message : e);
      code = 1;
    } finally {
      process.exit(code);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Windows 关窗对应 CTRL_CLOSE_EVENT → SIGHUP，Ctrl+Break 对应 SIGBREAK。两者触发收尾，但系统给予的期限可能不足以存盘；完整关机使用控制台入口。
  process.on('SIGHUP', () => void shutdown('SIGHUP(窗口被关闭)'));
  if (process.platform === 'win32') {
    process.on('SIGBREAK', () => void shutdown('SIGBREAK(Ctrl+Break)'));
  }
  // 主进程的兜底:未捕获异常带栈落盘后走关机仪式(默认行为是不存档直接退出);
  // 未处理的拒绝只记不退——主循环与 World 各有自己的失败路径。
  const processLog = bot.core.runlog.logger('process');
  process.on('uncaughtException', (err) => {
    processLog.emit('error', '未捕获异常,按关机仪式退出', { event: 'uncaught-exception', err });
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    processLog.emit('error', '未处理的 promise 拒绝', { event: 'unhandled-rejection', err: reason });
  });
}

main().catch((e) => {
  console.error('启动失败:', e instanceof Error ? e.message : e);
  process.exit(1);
});
