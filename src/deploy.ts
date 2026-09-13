/**
 * 部署层:把四层配置合成一次运行的活配置。
 *
 *   层1 框架默认   core 自己的参数(core/config.ts)
 *   层2 Persona   它自己的参数 + 它对 core 参数的选择 + 它所挂 World 的默认值
 *   层2.5 全局端点 `<部署根>/providers/<端点名>/config.json`:一台机器上有哪些 LLM 端点
 *                  是全局事实,不该每份部署各存一份(见 docs/PLAN-deployment-split.md §4)
 *   层3 部署配置   部署目录下的 config.json:换一台机器就要改的东西 + 操作者的选择
 *                  (部署目录由 src/paths.ts 的 deploymentDir() 解析)
 *   层4 运行时覆盖 控制台热改与调参工具(就地改这个活对象,实时读)
 *
 * 层 3 部署配置优先于层 2 建议值，且不要求修改Persona代码包。
 *
 * `BotDefinition` 只提供层 2 默认值;部署层不读取具体Persona的配置形状。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { CoreConfig, LLMProviderEntry } from './core/types.ts';
import { deepMerge, type LoadedConfig } from './core/config.ts';
import { secretReader } from './core/secrets.ts';
import { repoRoot as codeRepoRoot } from './paths.ts';

export type { LoadedConfig } from './core/config.ts';

export interface DeploymentSource<C extends CoreConfig> {
  /** 层1+层2 合成的默认值。每次调用返回新对象(合并会就地改它)。 */
  defaults(): C;
}

/**
 * 全局 LLM 端点表:`<部署根>/providers/<端点名>/config.json`,每个端点一格。
 * 一台机器上有哪些端点是全局事实,不分部署——所以这是 `config.providers` 的**唯一**来源
 * (代码默认那两条是它不在时的种子)。目录内别的东西(密钥、OAuth token)归 provider 模块自己解释。
 */
function globalProviders(providersDir: string): Record<string, LLMProviderEntry> {
  if (!existsSync(providersDir)) return {};
  const table: Record<string, LLMProviderEntry> = {};
  for (const name of readdirSync(providersDir)) {
    const file = resolve(providersDir, name, 'config.json');
    if (!existsSync(file)) continue;
    try {
      table[name] = JSON.parse(readFileSync(file, 'utf8')) as LLMProviderEntry;
    } catch (err) {
      throw new Error(`${file} 解析失败:${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return table;
}

/**
 * 包里对 World 配置的覆盖:`<代码包>/worlds/<Worldid>/config.json`,与同目录的 `ENV_PROMPT.md`
 * 并排,是同一套三层里的**层 2**——World 默认 → 人格包覆盖 → 这份部署的 config.json。
 *
 * 写在这里的是"换个部署者也不该改"的那些(`minecraft.username: "CortiV"` 这类人格身份、
 * 演出选择);本机事实(路径、设备、端口)归部署的 config.json。
 */
function packageWorldOverrides(pkgDir: string): Record<string, unknown> {
  const ioDir = resolve(pkgDir, 'worlds');
  if (!existsSync(ioDir)) return {};
  const worlds: Record<string, unknown> = {};
  for (const id of readdirSync(ioDir)) {
    const file = resolve(ioDir, id, 'config.json');
    if (!existsSync(file)) continue;
    try {
      worlds[id] = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`${file} 解析失败:${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return Object.keys(worlds).length ? { worlds } : {};
}

/**
 * 加载一次部署。三个目录各管一摊,别混:
 *
 *   `botDir`     这份**部署**自己的目录。config.json / .env / data/ / persona|workspace/
 *                都相对它解析,由 src/paths.ts 的 `deploymentDir()` 给出。
 *   `repoRoot`   代码所在仓库的位置。找 `extensions/`、记 run 的 git sha、解析配置里写的
 *                仓库内相对路径——与密钥无关。
 *   `pkgDir`     这份部署引用的 **bot 代码包**目录(`packageDir(manifest.bot)`)。提示词
 *                模板、演出包这些"层 2 归包"的东西按它找。缺省等于部署目录,那是给
 *                测试与 assemble 入口用的:包与部署同一个临时目录。
 *   `providersDir` 全局 LLM 端点表的根(`providersRoot()`,即 `<部署根>/providers/`)。
 *                它跨部署共享,所以由调用方显式给——缺省落回部署目录下的 `providers/`,
 *                好让测试与 assemble 入口自成一格,不去碰这台机器上真的那份。
 */
export function loadDeployment<C extends CoreConfig>(
  source: DeploymentSource<C>,
  botDir: string,
  repoRoot: string = codeRepoRoot(),
  pkgDir: string = botDir,
  providersDir: string = resolve(botDir, 'providers'),
): LoadedConfig<C> {
  const dir = resolve(botDir);
  const root = resolve(repoRoot);
  const providers = resolve(providersDir);
  const cfgPath = resolve(dir, 'config.json');
  const raw: Partial<C> & Record<string, unknown> = existsSync(cfgPath)
    ? (JSON.parse(readFileSync(cfgPath, 'utf8')) as Partial<C> & Record<string, unknown>)
    : {};
  // 端点表不归这份部署:写在部署 config.json 里的 `providers` 段一律不算数。
  delete raw.providers;
  // 五层深合并:框架默认 ← Persona建议(World 默认段由 withWorlds 补进)← 包里的 worlds 覆盖
  //          ← 全局端点表 ← 这份部署的 config.json(端点表除外)。
  const config = deepMerge(
    deepMerge(
      deepMerge(source.defaults(), packageWorldOverrides(resolve(pkgDir)) as Partial<C>),
      { providers: globalProviders(providers) } as Partial<C>,
    ),
    raw,
  );

  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(dir, p));
  return {
    config,
    secret: secretReader(resolve(dir, '.env')),
    rootDir: dir,
    packageDir: resolve(pkgDir),
    providersDir: providers,
    repoRoot: root,
    memoryDir: abs(config.paths.memory),
    dataDir: abs(config.paths.data),
  };
}
