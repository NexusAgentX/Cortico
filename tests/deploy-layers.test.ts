/**
 * 部署加载的分层:框架默认 ← Persona建议 ← **包里的 worlds 覆盖** ← 这份部署的 config.json。
 *
 * 中间那层是 `<代码包>/worlds/<Worldid>/config.json`,与同目录的 `ENV_PROMPT.md` 并排——
 * 三样东西(提示词、worlds 配置、演出包)共用同一条规则:逐层深合并,后一层赢。
 *
 * 后半段是 LLM 端点表:它是**全局**的(`<部署根>/providers/<端点名>/config.json`),
 * 压过代码默认,且不接受部署 config.json 的覆盖。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDeployment } from '../src/deploy.ts';
import type { CoreConfig } from '../src/core/types.ts';

interface TestConfig extends CoreConfig {
  worlds: Record<string, { enabled: boolean; username?: string; port?: number; nested?: { a?: number; b?: number } }>;
}

/** 层 1+2:框架默认与Persona的建议值。 */
function defaults(): TestConfig {
  return {
    paths: { memory: 'memory', data: 'data' },
    worlds: {
      minecraft: { enabled: true, username: 'World 默认名', port: 25565, nested: { a: 1, b: 2 } },
      terminal: { enabled: true },
    },
  } as unknown as TestConfig;
}

function makeDirs(): { pkgDir: string; deployDir: string } {
  return {
    pkgDir: mkdtempSync(join(tmpdir(), 'deploy-pkg-')),
    deployDir: mkdtempSync(join(tmpdir(), 'deploy-dep-')),
  };
}

function writePackageIo(pkgDir: string, worldId: string, json: unknown): void {
  const dir = join(pkgDir, 'worlds', worldId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(json), 'utf8');
}

describe('worlds 配置的三层', () => {
  it('包里的 worlds/<id>/config.json 压过 World 默认', () => {
    const { pkgDir, deployDir } = makeDirs();
    writePackageIo(pkgDir, 'minecraft', { username: 'CortiV' });

    const cfg = loadDeployment<TestConfig>({ defaults }, deployDir, deployDir, pkgDir).config;
    expect(cfg.worlds.minecraft.username).toBe('CortiV');
    // 没写到的键保持 World 默认,不被整段替换
    expect(cfg.worlds.minecraft.port).toBe(25565);
    expect(cfg.worlds.minecraft.nested).toEqual({ a: 1, b: 2 });
  });

  it('部署的 config.json 压过包里那层', () => {
    const { pkgDir, deployDir } = makeDirs();
    writePackageIo(pkgDir, 'minecraft', { username: 'CortiV', port: 25565 });
    writeFileSync(join(deployDir, 'config.json'), JSON.stringify({ worlds: { minecraft: { port: 30000 } } }), 'utf8');

    const cfg = loadDeployment<TestConfig>({ defaults }, deployDir, deployDir, pkgDir).config;
    expect(cfg.worlds.minecraft.port).toBe(30000); // 本机事实归部署
    expect(cfg.worlds.minecraft.username).toBe('CortiV'); // 人格身份归包
  });

  it('深合并到嵌套键;没有 worlds/ 目录时什么都不发生', () => {
    const { pkgDir, deployDir } = makeDirs();
    writePackageIo(pkgDir, 'minecraft', { nested: { b: 99 } });
    const merged = loadDeployment<TestConfig>({ defaults }, deployDir, deployDir, pkgDir).config;
    expect(merged.worlds.minecraft.nested).toEqual({ a: 1, b: 99 });

    const bare = makeDirs();
    const plain = loadDeployment<TestConfig>({ defaults }, bare.deployDir, bare.deployDir, bare.pkgDir).config;
    expect(plain.worlds.minecraft.username).toBe('World 默认名');
  });

  it('包里的 worlds 配置坏了要报出是哪份文件,不能静默忽略', () => {
    const { pkgDir, deployDir } = makeDirs();
    const dir = join(pkgDir, 'worlds', 'minecraft');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), '{ 这不是 json', 'utf8');

    expect(() => loadDeployment<TestConfig>({ defaults }, deployDir, deployDir, pkgDir))
      .toThrow(/minecraft[\\/]config\.json/);
  });

  it('packageDir 缺省等于部署目录(测试与 assemble 入口:包与部署同一个目录)', () => {
    const { deployDir } = makeDirs();
    const loaded = loadDeployment<TestConfig>({ defaults }, deployDir);
    expect(loaded.packageDir).toBe(loaded.rootDir);
  });
});

/** 层 1/2 里就有的那条端点(deepseek 那种"开箱能跑的"),用来验层序。 */
function providerDefaults(): TestConfig {
  return {
    paths: { memory: 'memory', data: 'data' },
    worlds: {},
    providers: { cloud: { kind: 'deepseek', baseUrl: 'https://code.test', secret: 'K' } },
    activeProvider: 'cloud',
  } as unknown as TestConfig;
}

function writeGlobalProvider(providersDir: string, name: string, json: unknown): void {
  mkdirSync(join(providersDir, name), { recursive: true });
  writeFileSync(join(providersDir, name, 'config.json'), JSON.stringify(json), 'utf8');
}

describe('全局端点表', () => {
  it('全局那份压过代码里的默认;部署 config.json 的 providers 段不算数', () => {
    const { deployDir } = makeDirs();
    const providersDir = mkdtempSync(join(tmpdir(), 'deploy-prov-'));
    writeGlobalProvider(providersDir, 'cloud', { kind: 'deepseek', baseUrl: 'https://global.test' });
    writeGlobalProvider(providersDir, 'local', { kind: 'openai-responses-compat', baseUrl: 'http://127.0.0.1:8090/v1' });
    writeFileSync(
      join(deployDir, 'config.json'),
      JSON.stringify({ providers: { cloud: { serviceTier: 'priority' }, ghost: { kind: 'deepseek' } } }),
      'utf8',
    );

    const cfg = loadDeployment<TestConfig>({ defaults: providerDefaults }, deployDir, deployDir, deployDir, providersDir).config;
    expect(cfg.providers.cloud.baseUrl).toBe('https://global.test'); // 全局赢过代码默认
    expect(cfg.providers.cloud.secret).toBe('K'); // 没写到的键仍是深合并
    expect(cfg.providers.cloud.serviceTier).toBeUndefined(); // 部署改不动端点
    expect(cfg.providers.ghost).toBeUndefined(); // 部署也加不进端点
    expect(cfg.providers.local.kind).toBe('openai-responses-compat'); // 全局能带来新端点
  });
});
