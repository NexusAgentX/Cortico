/**
 * 扩展在运行时怎么 import 框架。
 *
 * 扩展装在 `extensions/node_modules/<包>/` 下,它写 `import { nowIso } from 'cortico/core/util.ts'`
 * 时 Node 从它自己的位置向上找不到叫 `cortico` 的包——框架是个仓库,不在 node_modules 里。
 * 这里用 `module.registerHooks`(同步钩子;tsx 4.20+ 自己也是同步链,异步 `register`
 * 的钩子排在它后面轮不到)把 `cortico/<路径>` 映到 `<仓库>/src/<路径>`,然后**交给链上
 * 下一个继续解析**而不是短路:最终 URL 与框架自己 import 出来的一致,同一个模块只有
 * 一份实例。
 *
 * 为什么不用 junction/symlink 把仓库根链进 extensions/node_modules:仓库里已经出过
 * 递归删除顺着 junction 把真 node_modules 删掉的事故,不再造第二个。
 *
 * 子进程:World 常把重活放进 fork 出来的子进程,那边也要能解析 `cortico/*`。
 * {@link childExecArgv} 给出一组 execArgv:父进程已有的加载器(tsx)照抄,再
 * `--import` 本文件——import 即注册。
 *
 * 硬前提:扩展包必须 `"type": "module"`。CommonJS 包经 require 走的是另一条编译路,
 * 会得到框架源码的第二份副本(实验:同一个 `WorldAssembly` 变成两个类);manifest
 * 校验在装载前就拒掉这种包。
 */
import { registerHooks } from 'node:module';
import { FRAMEWORK_SPECIFIER } from './manifest.ts';

const PREFIX = `${FRAMEWORK_SPECIFIER}/`;
/** `src/` 的 URL:本文件在 `src/extensions/`。 */
const SRC_URL = new URL('../', import.meta.url);
const FLAG = Symbol.for('cortico.extensions.resolver');

/** 注册一次即可;重复调用无事发生(launcher 与测试都可能先 import 一遍)。 */
export function registerFrameworkResolver(): void {
  const g = globalThis as unknown as Record<symbol, unknown>;
  if (g[FLAG]) return;
  g[FLAG] = true;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith(PREFIX)) {
        return next(new URL(specifier.slice(PREFIX.length), SRC_URL).href, context);
      }
      return next(specifier, context);
    },
  });
}

/** 本文件的 URL:`--import` 它就等于调了一次 {@link registerFrameworkResolver}。 */
export const RESOLVER_URL = import.meta.url;

/**
 * 给扩展 fork 子进程用的 execArgv:父进程的加载器原样带上(经 tsx CLI 起的进程,
 * `process.execArgv` 里就是 tsx 的 --require/--import),没有的话补一个 `--import tsx`
 * (vitest 之类不经 tsx 的宿主),最后挂上本文件。
 */
export function childExecArgv(): string[] {
  const inherited = process.execArgv.some((a) => /[\\/]tsx[\\/]|(^|\s)tsx$/.test(a))
    ? [...process.execArgv]
    : ['--import', 'tsx'];
  return [...inherited, '--import', RESOLVER_URL];
}

// import 即注册:子进程经 `--import` 走到这里就够了。
registerFrameworkResolver();
