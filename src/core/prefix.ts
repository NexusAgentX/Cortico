/**
 * Assembles the main-session system prefix from persona-defined ordering and mounted-module
 * context. Segment content is opaque to the core; forks inherit this prefix unchanged.
 *
 * **前缀里的每一个字都来自可编辑的模板文件**——World 只报值(`envPromptVars()`),
 * 框架读模板并插值。这条不变量靠契约保证:`World` 上没有任何返回文本的方法。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderTemplate } from './template.ts';
import type {
  World,
  WorldPrefixContext,
  Persona,
  PrefixSegment,
  PromptDocDecl,
} from './types.ts';

export interface AssembleSystemDeps {
  persona: Persona;
  worlds: World[];
  now: Date;
  timezone: string;
  /** 找环境提示词覆盖的两个目录。缺席(测试、预建实例)= 只用 World 自带的模板。 */
  dirs?: EnvPromptDirs;
}

/**
 * 环境提示词模板的三层来源。同一套三层也用在 worlds 配置与演出包上:
 * **逐层查找,同名文件整份替换,后一层赢**。
 *
 *   module      World 自带的 `src/worlds-<id>/ENV_PROMPT.md`,通用版
 *   package     `<代码包>/worlds/<id>/ENV_PROMPT.md`,这个人格的覆盖,进版本控制
 *   deployment  `<部署>/worlds/<id>/ENV_PROMPT.md`,部署者自己微调的那份,**不进版本控制**
 *
 * 第三层不追踪是有意的:部署者按自己需求调出来的提示词是私有资产,不该随包发给别人。
 * 控制台改提示词只写第三层;「恢复默认」删掉它,回落第二层(没有第二层就回 World)。
 */
export interface EnvPromptDirs {
  /** 层 2:bot 代码包目录。 */
  packageDir?: string;
  /** 层 3:这份部署的目录。 */
  deploymentDir?: string;
}

/** 某一层里这个 World 的覆盖文件路径:`<dir>/worlds/<Worldid>/ENV_PROMPT.md`。 */
export function envPromptOverridePath(dir: string, worldId: string): string {
  return join(dir, 'worlds', worldId, 'ENV_PROMPT.md');
}

/** World 环境提示词模板此刻读哪份文件。自后向前找第一份存在的。 */
export function envPromptTemplateSource(
  doc: PromptDocDecl,
  worldId: string,
  dirs: EnvPromptDirs | undefined,
): { path: string; origin: EnvPromptOrigin } {
  for (const [dir, origin] of [
    [dirs?.deploymentDir, 'deployment'],
    [dirs?.packageDir, 'package'],
  ] as const) {
    if (!dir) continue;
    const override = envPromptOverridePath(dir, worldId);
    if (existsSync(override)) return { path: override, origin };
  }
  return { path: doc.path, origin: 'module' };
}

export type EnvPromptOrigin = 'deployment' | 'package' | 'module';

/**
 * World 的环境提示词模板(`role: 'envPrompt'` 那份)。**按角色找,不按 key 字符串猜**。
 * 没声明 = 这个 World 不往前缀里放东西。
 */
export function envPromptDocOf(mod: World): PromptDocDecl | undefined {
  let decl;
  try {
    decl = mod.console?.();
  } catch {
    return undefined; // console() 抛错不该拖垮整个前缀组装
  }
  return decl?.promptDocs?.find((doc) => doc.role === 'envPrompt');
}

/**
 * 一个 World 此刻的环境提示词:读它的模板、用它报的值插值。控制台的 World 卡也走这条,
 * 免得"控制台看到的"与"真进前缀的"是两份代码算出来的。
 */
export async function renderWorldEnvPrompt(
  mod: World,
  dirs?: EnvPromptDirs,
): Promise<{ text: string; sourceKey?: string }> {
  // null = 这一段整个不进前缀(World 自己关掉了半边功能)。此时连模板都不读。
  const vars = await mod.envPromptVars();
  const doc = vars === null ? undefined : envPromptDocOf(mod);
  if (!doc) return { text: '' };
  const { path } = envPromptTemplateSource(doc, mod.id, dirs);
  const text = renderTemplate(readFileSync(path, 'utf8'), vars ?? {}).trim();
  // 空段没有可指的源:控制台不该给渲染不出东西的段挂编辑入口。
  return text ? { text, sourceKey: doc.key } : { text: '' };
}

/**
 * World 进前缀的那一项:环境提示词。工具的用法说明不另立一份——schema 的
 * description 随工具定义发出,更长的说明写进 World 自己的(可编辑)环境提示词模板。
 */
export async function collectWorldContexts(
  worlds: World[],
  dirs?: EnvPromptDirs,
): Promise<WorldPrefixContext[]> {
  const sorted = [...worlds].sort((a, b) => a.id.localeCompare(b.id));
  return Promise.all(
    sorted.map(async (mod) => {
      const { text, sourceKey } = await renderWorldEnvPrompt(mod, dirs);
      return {
        id: mod.id,
        envPrompt: text,
        ...(sourceKey ? { sourceKey } : {}),
      };
    }),
  );
}

/** 供控制台观察:前缀的分段视图(与实际发出的前缀同一来源) */
export async function assembleSystemSegments(deps: AssembleSystemDeps): Promise<PrefixSegment[]> {
  const { persona, worlds, now, timezone, dirs } = deps;
  return persona.systemSegments({
    now,
    timezone,
    worlds: await collectWorldContexts(worlds, dirs),
  });
}

/**
 * 实际发出的前缀。**逐字拼接,不加任何胶水**——段与段之间怎么隔开由Persona的
 * 装配模板决定(段文本自带前导的分隔线与空行),core 不替它加换行。
 */
export async function assembleSystem(deps: AssembleSystemDeps): Promise<string> {
  const segments = await assembleSystemSegments(deps);
  return segments.map((segment) => segment.text).join('');
}
