/**
 * World 装配层:World 定义 → 槽位 → 挂载表。
 *
 * 一个 World 以 `WorldDefinition` 的形式进入装配:默认配置段、激活前置检查、
 * 按装配上下文造实例。装配层按 `worlds.<id>.enabled` 决定哪些槽位挂进 core,
 * 并在运行中热激活 / 停用 / 重启,不重启进程。
 *
 * 槽位不变量:`slot.instance` 要么已挂载并已 start,要么是从未 start 的新实例。
 * 停用与重启都会按定义重建一个新实例顶上,旧实例只负责 stop。
 *
 * 这一层不认识任何具体 World:名字、标签、缺失原因全部来自定义与 bot 的声明。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreConfig, World, WorldLifecycleEvent } from './core/types.ts';
import type { LoadedConfig } from './core/config.ts';
import type { BotDefinition } from './bot.ts';
import { updateJsonObject } from './config-file.ts';
import { pick, resolveLanguage, type Language } from './core/language.ts';

/** 装配层给控制台的回执与拒绝理由。 */
const ASSEMBLY_TEXT = {
  zh: {
    constructFailed: (detail: string) => `构造失败: ${detail}`,
    notImplemented: '本地没有找到这个 World 的实现。',
    unknownWorld: (id: string) => `未知 World: ${id}`,
    alreadyRunning: (label: string) => `${label} 已在运行`,
    prebuilt: (label: string) => `${label} 是预建实例,不经装配层激活`,
    activated: (label: string, id: string) => `${label} 已激活并启动;worlds.${id}.enabled=true 已写回 config.json`,
    deactivated: (label: string, id: string) => `${label} 已停止;worlds.${id}.enabled=false 已写回 config.json`,
    notActive: (label: string) => `${label} 未激活,没有可重启的实例`,
    restarted: (label: string) => `${label} 已重启`,
    toolClash: (other: string, names: string[]) => `工具名与 ${other} 撞名,拒绝挂载: ${names.join(', ')}`,
    toolReserved: (names: string[]) => `工具名已被 Core 或 Persona 占用,拒绝挂载: ${names.join(', ')}`,
    unbound: '装配层尚未绑定 core',
  },
  en: {
    constructFailed: (detail: string) => `Construction failed: ${detail}`,
    notImplemented: 'No implementation of this World was found locally.',
    unknownWorld: (id: string) => `Unknown World: ${id}`,
    alreadyRunning: (label: string) => `${label} is already running`,
    prebuilt: (label: string) => `${label} is a prebuilt instance and is not activated through assembly`,
    activated: (label: string, id: string) => `${label} activated and started; worlds.${id}.enabled=true written back to config.json`,
    deactivated: (label: string, id: string) => `${label} stopped; worlds.${id}.enabled=false written back to config.json`,
    notActive: (label: string) => `${label} is not active, so there is no instance to restart`,
    restarted: (label: string) => `${label} restarted`,
    toolClash: (other: string, names: string[]) => `Tool names clash with ${other}, refusing to mount: ${names.join(', ')}`,
    toolReserved: (names: string[]) => `Tool names are taken by Core or the Persona, refusing to mount: ${names.join(', ')}`,
    unbound: 'The assembly layer is not bound to a core yet',
  },
};

/** 每个 World 配置段的最小形状。 */
export interface WorldSection {
  enabled: boolean;
}

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** 造实例时 World 从装配层拿到的全部东西。 */
export interface WorldContext<S extends WorldSection = WorldSection> {
  readonly id: string;
  /** `worlds.<id>` 的活引用。热键现读即生效;构造时读走的静态键在下次 World 重启时更新。 */
  readonly cfg: S;
  readonly timezone: string;
  /** 控制台语言(部署事实)。 World 自己决定要不要按它切换文案;不切就一直中文。 */
  readonly language: Language;
  readonly botName: string;
  /** 这份**部署**的目录。本机事实、密钥、部署侧的资产覆盖都在这下面。 */
  readonly botDir: string;
  /**
   * 这份部署引用的 **bot 代码包**目录。人格自带的资产(演出包、提示词覆盖)在这下面,
   * 它们进版本控制。同一个包可以背好几份部署,所以与 `botDir` 是两回事。
   */
  readonly packageDir: string;
  readonly dataDir: string;
  readonly repoRoot: string;
  secret(name: string): string;
  /** 写一个密钥到 bot 目录的 `.env`,并让本进程的 `secret()` 立刻读到新值。 */
  storeSecret(name: string, value: string): void;
  /** 深合并进 `worlds.<id>` 段:活对象与 config.json 同步。数组整体替换。 */
  persist(patch: DeepPartial<S>): void;
  /**
   * 按当前 `cfg.enabled` 对账本 World:已激活则重建实例重启,未激活则停下。
   * 面板上「改了连接参数要重启」的那颗按钮走这里。
   */
  restart(): Promise<void>;
}

export interface WorldDefinition<S extends WorldSection = WorldSection> {
  id: string;
  label: string;
  /** 层 2 默认值。`enabled` 恒为 false,由 bot 的声明置 true。每次调用返回新对象。 */
  defaults(): S;
  /** 激活前置检查。抛错 = 不能激活,错误信息原样给操作者。 */
  preflight?(ctx: WorldContext<S>): void;
  /**
   * `x-options` 下拉的**整张**选项表(如播放设备表),由声明该 schema 的 World 自己给:
   * "系统默认 / 静音"这类固定项也在这里按 `language` 给出,控制台不认识任何 kind,
   * 只把返回的表原样画出来(当前值不在表里时另补一项)。不认识的 kind 返回空数组,
   * 框架据此继续问下一个 World。bot 级 `ConsoleContribution.configOptions` 只管Persona
   * 自己那几组。
   */
  configOptions?(kind: string, language: Language): Array<{ value: string; label: string }>;
  create(ctx: WorldContext<S>): World;
}

/**
 * bot 为之设计的渠道。字符串 = 有定义的 World id;对象 = 本地没有实现的占位,
 * 控制台按 `missing` 展示 `reason`。
 */
export type WorldDeclaration = string | { id: string; label: string; reason?: string };

/** 层 2 的 `worlds` 段:每个定义的默认值,声明过的渠道 `enabled: true`。 */
export function worldDefaults(
  definitions: readonly WorldDefinition<WorldSection>[],
  declares: readonly WorldDeclaration[],
  overrides: Record<string, Record<string, unknown>> = {},
): Record<string, WorldSection> {
  const declared = new Set(declares.map((d) => (typeof d === 'string' ? d : d.id)));
  const worlds: Record<string, WorldSection> = {};
  for (const def of definitions) {
    worlds[def.id] = { ...def.defaults(), enabled: declared.has(def.id), ...(overrides[def.id] ?? {}) };
  }
  return worlds;
}

/**
 * 把本机有的实现交给 bot 定义:仓内目录与扩展装进来的并成一张表。层 1 的 `worlds` 段为
 * 每个实现补默认值,Persona 声明过的渠道 `enabled: true`,其余默认关、由部署侧选配。
 * 定义本身一行不改;`defaults()` 里已有的段不覆盖。
 */
export function withWorlds<C extends CoreConfig>(
  definition: BotDefinition<C>,
  definitions: readonly WorldDefinition<WorldSection>[],
): BotDefinition<C> {
  const declared = new Set((definition.declares ?? []).map((d) => (typeof d === 'string' ? d : d.id)));
  return {
    ...definition,
    worlds: definitions,
    defaults: () => {
      const config = definition.defaults();
      const worlds = ((config as unknown as { worlds?: Record<string, WorldSection> }).worlds ??= {});
      for (const def of definitions) worlds[def.id] ??= { ...def.defaults(), enabled: declared.has(def.id) };
      return config;
    },
  };
}

export interface WorldSlot {
  readonly id: string;
  readonly label: string;
  /** bot 声明过的渠道;false = 部署侧选配。 */
  readonly declared: boolean;
  /** null = 预建实例(不能重建,只能停/起)。 */
  readonly definition: WorldDefinition<WorldSection> | null;
  instance: World;
  mounted: boolean;
}

export interface MissingWorld {
  readonly id: string;
  readonly label: string;
  readonly reason: string;
  /** Persona声明过的渠道。缺省 true:声明了却没实现的那类。 */
  readonly declared?: boolean;
}

export interface PrebuiltOptions {
  /** 控制台显示名;缺省用 id。 */
  labels?: Record<string, string>;
  /** 按 bot 声明的渠道算(缺省)还是按部署侧选配算。 */
  declared?: boolean;
}

/** 装配层对 core 的两个动作;core 造好后绑上。 */
export interface WorldMountHost {
  mount(mod: World): Promise<void>;
  unmount(id: string): Promise<void>;
  /** 装配层改了一个槽位的挂载状态(激活 / 停用 / 重启)。启动期的初始挂载不报。 */
  lifecycle?(event: WorldLifecycleEvent): void;
  /**
   * World 不得占用的工具名(Core 保留帧名、Persona 自有工具)。绑定时把启动期已挂载的
   * 扫一遍,撞名的出表进 missing;之后激活 / 重启 / 预建也查。
   */
  reservedToolNames?(): readonly string[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 就地深合并:叶子替换,沿途对象身份保持,数组整体替换。 */
function assignDeep(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = target[key];
    if (isPlainObject(value) && isPlainObject(current)) assignDeep(current, value);
    else target[key] = isPlainObject(value) ? structuredClone(value) : value;
  }
}

function writeEnvLine(envPath: string, name: string, value: string): void {
  const prev = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^[ \\t]*${name}\\s*=.*$`, 'm');
  const next = pattern.test(prev)
    ? prev.replace(pattern, line)
    : (prev.trimEnd() ? `${prev.trimEnd()}\n${line}\n` : `${line}\n`);
  writeFileSync(envPath, next, 'utf8');
}

export class WorldAssembly {
  /** 挂载表。与 core 共用同一个数组,激活/停用就地增删。 */
  readonly mounted: World[] = [];
  readonly slots: WorldSlot[] = [];
  readonly missing: MissingWorld[] = [];
  private host: WorldMountHost | null = null;
  private readonly cfgPath: string;
  private readonly language: Language;

  constructor(
    private readonly loaded: LoadedConfig<CoreConfig>,
    worlds: readonly WorldDefinition<WorldSection>[],
    declares: readonly WorldDeclaration[],
  ) {
    this.cfgPath = join(loaded.rootDir, 'config.json');
    this.language = resolveLanguage(loaded.config.language);
    const declared = new Set<string>();
    for (const decl of declares) declared.add(typeof decl === 'string' ? decl : decl.id);
    const defined = new Set(worlds.map((m) => m.id));
    for (const def of worlds) {
      const section = this.section(def);
      let instance: World;
      try {
        instance = def.create(this.context(def));
      } catch (error) {
        // 定义可以来自可替换的包;构造失败只废这一格,不让一个 World 否决整个启动。
        this.missing.push({
          id: def.id,
          label: def.label,
          declared: declared.has(def.id),
          reason: this.text.constructFailed(error instanceof Error ? error.message : String(error)),
        });
        continue;
      }
      const clash = section.enabled ? this.toolClash(instance, this.mounted) : null;
      if (clash) {
        this.missing.push({ id: def.id, label: def.label, declared: declared.has(def.id), reason: clash });
        continue;
      }
      const slot: WorldSlot = {
        id: def.id,
        label: def.label,
        declared: declared.has(def.id),
        definition: def,
        instance,
        mounted: false,
      };
      this.slots.push(slot);
      if (section.enabled) {
        slot.mounted = true;
        this.mounted.push(slot.instance);
      }
    }
    for (const decl of declares) {
      if (typeof decl === 'string') {
        if (!defined.has(decl)) this.missing.push({ id: decl, label: decl, reason: this.text.notImplemented });
        continue;
      }
      if (defined.has(decl.id)) continue;
      this.missing.push({ id: decl.id, label: decl.label, reason: decl.reason ?? this.text.notImplemented });
    }
  }

  /** 只有预建实例的槽位表(测试与开发态用):不读配置,不写 config.json。 */
  static ofInstances(instances: readonly World[], opts: PrebuiltOptions = {}): WorldAssembly {
    const loaded = {
      config: { worlds: {} } as unknown as CoreConfig,
      secret: () => '',
      rootDir: '',
      memoryDir: '',
      dataDir: '',
    } satisfies LoadedConfig<CoreConfig>;
    const assembly = new WorldAssembly(loaded, [], []);
    assembly.addPrebuilt(instances, opts);
    return assembly;
  }

  /** 预建实例:永远挂载,只能停/起,不能重建。同 id 的定义槽位会被它顶掉。 */
  addPrebuilt(instances: readonly World[], opts: PrebuiltOptions = {}): void {
    for (const mod of instances) {
      const existing = this.slots.findIndex((s) => s.id === mod.id);
      if (existing >= 0) {
        const old = this.slots[existing];
        if (old.mounted) this.mounted.splice(this.mounted.indexOf(old.instance), 1);
        this.slots.splice(existing, 1);
      }
      const clash = this.toolClash(mod, this.mounted);
      if (clash) throw new Error(clash);
      this.slots.push({
        id: mod.id,
        label: opts.labels?.[mod.id] ?? mod.id,
        declared: opts.declared ?? true,
        definition: null,
        instance: mod,
        mounted: true,
      });
      this.mounted.push(mod);
    }
  }

  /** 绑上 core;启动期已挂载的 World 此刻才能对照保留名,撞名的出表进 missing。 */
  bind(host: WorldMountHost): void {
    this.host = host;
    for (const slot of [...this.slots]) {
      if (!slot.mounted) continue;
      const clash = this.toolClash(slot.instance, []);
      if (!clash) continue;
      this.mounted.splice(this.mounted.indexOf(slot.instance), 1);
      this.slots.splice(this.slots.indexOf(slot), 1);
      this.missing.push({ id: slot.id, label: slot.label, declared: slot.declared, reason: clash });
    }
  }

  slot(id: string): WorldSlot {
    const slot = this.slots.find((s) => s.id === id);
    if (!slot) throw new Error(this.text.unknownWorld(id));
    return slot;
  }

  /** 所有槽位的实例(含未挂载的),给控制台拼面板、提示词文档与配置组用。 */
  instances(): World[] {
    return this.slots.map((s) => s.instance);
  }

  labelOf(id: string): string | undefined {
    return this.slots.find((s) => s.id === id)?.label;
  }

  async activate(id: string): Promise<string> {
    const slot = this.slot(id);
    if (slot.mounted) return this.text.alreadyRunning(slot.label);
    const def = slot.definition;
    if (!def) throw new Error(this.text.prebuilt(slot.label));
    const ctx = this.context(def);
    def.preflight?.(ctx);
    const clash = this.toolClash(slot.instance, this.mounted);
    if (clash) throw new Error(clash);
    this.persist(id, { enabled: true });
    try {
      await this.mountHost().mount(slot.instance);
    } catch (error) {
      this.persist(id, { enabled: false });
      slot.instance = def.create(ctx);
      throw error;
    }
    slot.mounted = true;
    this.host?.lifecycle?.({ kind: 'mounted', id, label: slot.label });
    return this.text.activated(slot.label, id);
  }

  async deactivate(id: string): Promise<string> {
    const slot = this.slot(id);
    const wasMounted = slot.mounted;
    if (wasMounted) await this.stopSlot(slot);
    this.persist(id, { enabled: false });
    if (wasMounted) this.host?.lifecycle?.({ kind: 'unmounted', id, label: slot.label });
    return this.text.deactivated(slot.label, id);
  }

  async restart(id: string): Promise<string> {
    const slot = this.slot(id);
    if (!slot.mounted) throw new Error(this.text.notActive(slot.label));
    await this.stopSlot(slot);
    const clash = this.toolClash(slot.instance, this.mounted);
    if (clash) throw new Error(clash);
    await this.mountHost().mount(slot.instance);
    slot.mounted = true;
    this.host?.lifecycle?.({ kind: 'restarted', id, label: slot.label });
    return this.text.restarted(slot.label);
  }

  /** 按 `worlds.<id>.enabled` 对账(`WorldContext.restart`)。 */
  async sync(id: string): Promise<void> {
    const slot = this.slot(id);
    const enabled = (slot.definition ? this.section(slot.definition) : { enabled: true }).enabled;
    if (enabled) {
      if (slot.mounted) await this.restart(id);
      else await this.activate(id);
    } else if (slot.mounted) {
      await this.stopSlot(slot);
      this.host?.lifecycle?.({ kind: 'unmounted', id, label: slot.label });
    }
  }

  private async stopSlot(slot: WorldSlot): Promise<void> {
    await this.mountHost().unmount(slot.id);
    slot.mounted = false;
    if (slot.definition) slot.instance = slot.definition.create(this.context(slot.definition));
  }

  /**
   * 工具名在一个 bot 内全局唯一:模型按名字调用,Core 按名字归属与隐藏。
   * 占了保留名或与挂载表里任何 World 撞名的 World 不挂,理由给操作员;约定是用自家短名做前缀。
   */
  private toolClash(mod: World, mounted: readonly World[]): string | null {
    const names = new Set(mod.tools().map((t) => t.name));
    const reserved = (this.host?.reservedToolNames?.() ?? []).filter((n) => names.has(n));
    if (reserved.length) return this.text.toolReserved(reserved);
    for (const other of mounted) {
      const shared = other.tools().map((t) => t.name).filter((n) => names.has(n));
      if (shared.length) return this.text.toolClash(this.labelOf(other.id) ?? other.id, shared);
    }
    return null;
  }

  private mountHost(): WorldMountHost {
    if (!this.host) throw new Error(this.text.unbound);
    return this.host;
  }

  private get text(): (typeof ASSEMBLY_TEXT)['zh'] {
    return pick(this.language, ASSEMBLY_TEXT);
  }

  /** `worlds.<id>` 活引用;缺段时按定义默认值补一段。 */
  private section(def: WorldDefinition<WorldSection>): WorldSection {
    const worlds = ((this.loaded.config as unknown as { worlds?: Record<string, WorldSection> }).worlds ??= {});
    return (worlds[def.id] ??= def.defaults());
  }

  private persist(id: string, patch: Record<string, unknown>): void {
    const worlds = (this.loaded.config as unknown as { worlds: Record<string, Record<string, unknown>> }).worlds;
    assignDeep(worlds[id], patch);
    updateJsonObject(this.cfgPath, (raw) => {
      const rawIo = (raw.worlds ??= {}) as Record<string, Record<string, unknown>>;
      const section = (rawIo[id] ??= {});
      assignDeep(section, patch);
    });
  }

  private context<S extends WorldSection>(def: WorldDefinition<S>): WorldContext<S> {
    const { loaded } = this;
    const cfg = loaded.config;
    return {
      id: def.id,
      cfg: this.section(def as unknown as WorldDefinition<WorldSection>) as S,
      timezone: cfg.timezone,
      language: this.language,
      botName: cfg.displayName,
      botDir: loaded.rootDir,
      packageDir: loaded.packageDir ?? loaded.rootDir,
      dataDir: loaded.dataDir,
      repoRoot: loaded.repoRoot ?? loaded.rootDir,
      secret: (name) => loaded.secret(name),
      storeSecret: (name, value) => {
        writeEnvLine(join(loaded.rootDir, '.env'), name, value);
        process.env[name] = value;
      },
      persist: (patch) => this.persist(def.id, patch as Record<string, unknown>),
      restart: () => this.sync(def.id),
    };
  }
}
