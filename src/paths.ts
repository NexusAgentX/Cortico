/**
 * 路径解析:把"代码包在哪"与"部署在哪"分成两个独立问题。
 *
 * `bots/<名字>/` 是**代码包**(index.ts / core/ / console/ / vtuber-pack/,全部进版本
 * 控制);`<部署根>/<名字>/` 是**一份部署**(deployment.json / config.json / .env /
 * data/ / persona|workspace/,整片不进版本控制)。一份部署用 `deployment.json` 的
 * `bot` 字段声明它引用哪个包,所以同一个包可以背好几份部署。
 *
 * 三个根的分工:
 *   repoRoot()       这份代码所在的检出。git worktree 里就是这个 worktree 自己。
 *   mainRepoRoot()   主仓库的根。worktree 共享主仓库的 .git,部署数据也该共享一份,
 *                    不该跟着临时 worktree 各起一套。
 *   deploymentRoot() 部署根。CORTICO_HOME 指到哪就是哪,没设就用默认值。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/** 部署根的默认目录名(相对主仓库根)。整片 gitignore,见 .gitignore 与 release-audit。 */
const DEFAULT_DEPLOYMENT_DIRNAME = 'deployments';

/** bot 代码包所在的目录名(相对主仓库根)。包永远在仓库里,不跟着 CORTICO_HOME 走。 */
const PACKAGES_DIRNAME = 'bots';

/**
 * LLM 端点的部署数据根(相对部署根)。它与各份部署平级但**不是**一份部署:
 * 没有 `deployment.json`,`listBots()` 因此看不见它。
 */
const PROVIDERS_DIRNAME = 'providers';

/**
 * 可执行运行时(llama-server 这类外部二进制)与模型文件的根,都相对部署根。与端点表同一个
 * 理由:装在这台机器上的二进制和权重是机器事实,几份部署共用一份。两者都不是部署,
 * `listBots()` 看不见。
 */
const RUNTIMES_DIRNAME = 'runtimes';
const MODELS_DIRNAME = 'models';

/** 部署根的环境变量名。进程环境与仓库根 `.env` 用同一个名字。 */
export const DEPLOYMENT_ROOT_ENV = 'CORTICO_HOME';

let repoRootCache: string | null = null;
let mainRepoRootCache: string | null = null;
let deploymentRootCache: string | null = null;

/** 这份代码包所在的检出根(src/ 的上一级)。 */
export function repoRoot(): string {
  if (repoRootCache === null) repoRootCache = resolve(import.meta.dirname, '..');
  return repoRootCache;
}

/**
 * 从 `--git-common-dir` 求主仓库根。
 *
 * worktree 里 `.git` 是个文件、指向 `<主仓库>/.git/worktrees/<名字>`,而
 * `--git-common-dir` 给的是共享的那个 `<主仓库>/.git`,取父目录即主仓库根。主仓库里它
 * 回 `.git` 本身,父目录就是检出根,与 `from` 相同。
 *
 * 不在 git 仓里、或 git 不可用(没装/被策略挡住)时回退到 `from`——这条回退是有意的:
 * 打包分发的代码包里根本没有 .git。
 */
export function resolveMainRepoRoot(from: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: from,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return from;
    return dirname(isAbsolute(out) ? resolve(out) : resolve(from, out));
  } catch {
    return from;
  }
}

/** 主仓库的根。worktree 里指回主检出,不是当前 worktree。 */
export function mainRepoRoot(): string {
  if (mainRepoRootCache === null) mainRepoRootCache = resolveMainRepoRoot(repoRoot());
  return mainRepoRootCache;
}

/**
 * 从一个检出根的 `.env` 里读 `CORTICO_HOME`。
 *
 * 这里只认这一个名字:仓库根 `.env` **不是**密钥文件,密钥归部署单位自己
 * (见 src/deploy.ts 的 `secret()`)。值可以带引号,允许含空格。
 */
function readDeploymentRootFromEnvFile(checkoutRoot: string): string {
  const file = resolve(checkoutRoot, '.env');
  if (!existsSync(file)) return '';
  const m = new RegExp(`^[ \\t]*${DEPLOYMENT_ROOT_ENV}[ \\t]*=[ \\t]*(.*)$`, 'm').exec(
    readFileSync(file, 'utf8'),
  );
  const raw = m ? m[1].trim() : '';
  return raw.length >= 2 && (raw.startsWith('"') || raw.startsWith("'")) && raw.endsWith(raw[0])
    ? raw.slice(1, -1).trim()
    : raw;
}

/**
 * 解析链:`process.env.CORTICO_HOME` > 仓库根 `.env` 里的 `CORTICO_HOME` > 默认值。
 *
 * 写相对路径按**主仓库根**解析(不是当前 worktree),写绝对路径原样采用。
 *
 * 参数摊开是为了可测:`deploymentRoot()` 拿真进程的三样东西调它。
 */
export function resolveDeploymentRoot(
  env: NodeJS.ProcessEnv,
  checkoutRoot: string,
  mainRoot: string,
): string {
  const raw = (env[DEPLOYMENT_ROOT_ENV] ?? '').trim() || readDeploymentRootFromEnvFile(checkoutRoot);
  if (!raw) return resolve(mainRoot, DEFAULT_DEPLOYMENT_DIRNAME);
  return isAbsolute(raw) ? resolve(raw) : resolve(mainRoot, raw);
}

/** 部署根:所有部署目录的父目录。进程内解析一次。 */
export function deploymentRoot(): string {
  if (deploymentRootCache === null) {
    deploymentRootCache = resolveDeploymentRoot(process.env, repoRoot(), mainRepoRoot());
  }
  return deploymentRootCache;
}

/** 一份部署的目录:config.json / .env / data/ / persona|workspace/ 都在这下面。 */
export function deploymentDir(name: string): string {
  return resolve(deploymentRoot(), name);
}

/**
 * LLM 端点表的根:一台机器上有哪些端点是**全局**事实,不该每份部署各存一份
 * (换一次 key 要改三处、同一个订阅端点要各授权一次都是那么来的)。
 */
export function providersRoot(): string {
  return resolve(deploymentRoot(), PROVIDERS_DIRNAME);
}

/**
 * 一个端点自己的目录。目录名是**端点名**(`config.providers` 的键)而不是 kind:
 * 一个 kind 可以背好几个端点(本机那条 `local` 就是 `openai-responses-compat`)。
 * 目录内部结构的解释权全归 provider 包,框架只给它这一个目录。
 */
export function providerDir(name: string): string {
  return resolve(providersRoot(), name);
}

/**
 * 运行时根:`<部署根>/runtimes/<运行时 id>/<版本>/`,一个版本一个目录,可并存。
 * 目录内部的布局归下载它的那个模块。
 */
export function runtimesRoot(): string {
  return resolve(deploymentRoot(), RUNTIMES_DIRNAME);
}

/** 模型文件根:`<部署根>/models/<owner>/`,owner 是 provider id 或 World id。 */
export function modelsRoot(): string {
  return resolve(deploymentRoot(), MODELS_DIRNAME);
}

/**
 * 一个 bot 代码包的目录:index.ts / core/ / console/ / vtuber-pack/ 在这下面,全部进版本控制。
 * 一份部署用 `deployment.json` 的 `bot` 字段说它引用哪个包,所以一个包可以有好几份部署。
 */
export function packageDir(bot: string): string {
  return resolve(mainRepoRoot(), PACKAGES_DIRNAME, bot);
}

/** 一份部署的 `deployment.json`。 */
export interface DeploymentManifest {
  /** 这份部署引用哪个 bot 代码包。 */
  bot: string;
}

/** 读一份部署的 `deployment.json`;文件缺失或 `bot` 字段不成形状都回 null。 */
export function readDeploymentManifest(name: string): DeploymentManifest | null {
  const file = resolve(deploymentDir(name), 'deployment.json');
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { bot?: unknown };
    if (typeof raw.bot !== 'string' || !raw.bot.trim()) return null;
    return { bot: raw.bot.trim() };
  } catch {
    return null;
  }
}
