/**
 * `pnpm check:extension <扩展目录>` —— 扩展作者发布前的自查。
 *
 * 走的是启动时那条装载线本身(同一份 manifest 解析、同一个入口解析、同一套形状校验),
 * 所以这里报通过,框架启动时就会加载它。每条不合格都指出改哪里;有一条不合格即退出码 1。
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  EXTENSION_API_VERSION,
  parseExtensionManifest,
  extensionAssetUrl,
  type ExtensionPackageJson,
} from '../src/extensions/manifest.ts';
import { registerFrameworkResolver } from '../src/extensions/runtime.ts';
import {
  EXTENSION_PAGE_KIND,
  isBotDefinition,
  isWorldDefinition,
  isProviderModule,
  extensionPackageFile,
  extensionShapeMismatch,
  resolveExtensionEntry,
} from '../src/extensions.ts';
import { pageIdFor } from '../src/web/shared/console-protocol.ts';

let failures = 0;
const ok = (msg: string): void => console.log(`  ✓ ${msg}`);
const warn = (msg: string): void => console.log(`  ⚠ ${msg}`);
const fail = (msg: string): void => { failures += 1; console.log(`  ✗ ${msg}`); };

function verdict(): void {
  console.log('');
  if (failures === 0) {
    console.log('通过:这个包可以装进 extensions/。');
    return;
  }
  console.log(`${failures} 项不合格,发布前先改掉(每条自己说了是拦下整个包,还是只缺那一块)。`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error('用法: pnpm check:extension <扩展目录>');
    process.exitCode = 1;
    return;
  }
  const pkgDir = resolve(process.cwd(), arg);
  const pkgFile = join(pkgDir, 'package.json');
  if (!existsSync(pkgFile)) {
    console.error(`${pkgFile} 不存在:参数要指向扩展包的根目录(含 package.json 的那一层)。`);
    process.exitCode = 1;
    return;
  }
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as ExtensionPackageJson;

  console.log(`扩展目录: ${pkgDir}`);
  console.log(`包:       ${pkg.name ?? '(package.json 没有 name)'}@${pkg.version ?? '(没有 version)'}`);
  console.log(`框架契约: v${EXTENSION_API_VERSION}`);
  console.log('');

  if (!pkg.name) fail('package.json 缺少 name:pnpm 装不了没有名字的包。');
  if (!pkg.version) fail('package.json 缺少 version:浏览器端产物的 URL 按版本分段,没有版本换不掉旧缓存。');

  const parsed = parseExtensionManifest(pkg);
  for (const w of parsed.warnings) warn(w);
  if (!parsed.ok) {
    for (const reason of parsed.reasons) fail(reason);
    verdict();
    return;
  }
  const manifest = parsed.manifest;
  ok(`manifest: kind=${manifest.kind},api=${manifest.api}`);

  const entry = resolveExtensionEntry(pkgDir, pkg);
  if (!existsSync(entry)) {
    fail(`入口 ${entry} 不存在:exports / module / main 指向的文件要随包发布(检查 files 与 .npmignore)。`);
    verdict();
    return;
  }
  ok(`入口: ${entry}`);

  // 扩展 import `cortico/*` 靠这个钩子;装载器在 import 前也是先注册它。
  registerFrameworkResolver();
  let exported: unknown;
  try {
    exported = ((await import(pathToFileURL(entry).href)) as { default?: unknown }).default;
  } catch (error) {
    fail(`import 入口时抛错: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    verdict();
    return;
  }

  const shaped = manifest.kind === 'world' ? isWorldDefinition(exported)
    : manifest.kind === 'provider' ? isProviderModule(exported)
    : isBotDefinition(exported);
  if (!shaped) {
    fail(`${extensionShapeMismatch(manifest.kind)}整个包都不会装上。`);
    verdict();
    return;
  }
  const noun = { world: 'World', provider: 'provider', bot: 'bot' }[manifest.kind];
  const id = (exported as { id: string }).id;
  ok(`默认导出符合 ${manifest.kind} 的形状;id = ${id}`);
  if (manifest.kind === 'bot') {
    console.log('    bot id 不得与仓内 bots/ 下任一目录同名;deployment.json 的 bot 字段填包名即启用。');
    try {
      const defaults = (exported as { defaults: () => unknown }).defaults();
      if (!defaults || typeof defaults !== 'object') fail('defaults() 没有返回对象:装配时的四层合并从它开始。');
      else ok('defaults() 能跑,返回对象。');
    } catch (error) {
      fail(`defaults() 抛错: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log('    包目录只读:promptDocs 里没给 deploymentPath 的模板在控制台里显示但不能保存。');
  } else {
    console.log(`    ${noun} id 在整份部署里唯一,与内建的或别的扩展撞名就不会装上。`);
  }

  if (manifest.consoleClient === undefined) {
    ok('没有声明浏览器端产物(cortico.consoleClient),控制台按框架给的通用面板显示。');
  } else {
    const js = extensionPackageFile(pkgDir, manifest.consoleClient);
    if (!js) {
      fail(`cortico.consoleClient 指的 ${manifest.consoleClient} 不在包里:先 build,再确认它落在 files / .npmignore 允许的范围内。${noun}本体照常加载,只是控制台没有这一块面板。`);
    } else {
      ok(`浏览器端产物: ${manifest.consoleClient}`);
      console.log(`    控制台页 id: ${pageIdFor(EXTENSION_PAGE_KIND[manifest.kind], id)}`);
      console.log(`    发布后的 URL: ${extensionAssetUrl(pkg.name ?? '', pkg.version ?? '0', basename(manifest.consoleClient))}`);
    }
    if (manifest.consoleStyle !== undefined) {
      if (extensionPackageFile(pkgDir, manifest.consoleStyle)) ok(`浏览器端样式: ${manifest.consoleStyle}`);
      else warn(`cortico.consoleStyle 指的 ${manifest.consoleStyle} 不在包里:面板按无样式发。`);
    }
  }

  verdict();
}

await main();
