/**
 * Cortico bot 的统一装配入口。
 * 可由 core 公开字段机械派生的接线在此生成；具体 bot 内容由调用方增量提供。
 * 本文件不得依赖具体 World ID 或面板语义，`extensions` 原样转交。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type {
  ConfigGroup,
  CoreConfig,
  World,
  Logger,
  WorldLifecycleEvent,
  WorldPanelDecl,
  Persona,
  PromptDocDecl,
  ShutdownExternalCheck,
  ToolSchema,
} from './core/types.ts';
import type { LoadedConfig } from './core/config.ts';
import { coreConfigGroup } from './core/config.ts';
import { pick, resolveLanguage, type Language } from './core/language.ts';
import { updateJsonObject } from './config-file.ts';
import { isSupervised, requestRestart } from './boot.ts';
import { ExtensionManager, type ExtensionSet } from './extensions.ts';
import { WorldAssembly, type WorldDefinition, type WorldDeclaration, type WorldSection } from './world.ts';
import { Core, type WorldStopFailure } from './core/core.ts';
import { RESERVED_FRAME_NAMES } from './core/loop.ts';
import type { ResponseClient } from './core/generation.ts';
import { acquireInstanceLock, type InstanceLock } from './core/instance-lock.ts';
import { assembleSystemSegments, envPromptOverridePath, envPromptTemplateSource, renderWorldEnvPrompt, type EnvPromptDirs, type EnvPromptOrigin } from './core/prefix.ts';
import { aggregateUsage } from './core/cost.ts';
import { nowIso, withDeadline } from './core/util.ts';
import { closeRun } from './core/run.ts';
import { ProviderSettings } from './providers/console/settings.ts';
import { providerModules } from './providers/registry.ts';
import { readGroupValues, setByPath as setConfigPath } from './core/config-schema.ts';
import type { ConfigValues } from './core/config-schema.ts';
import {
  WebApp,
  type ConsoleWorldInfo,
  type WorldInfo,
  type PromptDocument,
  type StoragePart,
  type ToolOwner,
  type WebAppPromptDeps,
} from './web/server.ts';
import type { ConsolePageSource } from './web/console-pages.ts';
import {
  pageIdFor,
  type ConsolePageContribution,
} from './web/shared/console-protocol.ts';


/**
 * bot 专属的Persona、 World、层 2 默认值与控制台增量的装配边界。
 * 启动器与框架仅依赖此接口。
 */
export interface BotDefinition<C extends CoreConfig = CoreConfig> {
  /** 目录名以外的稳定标识,用于日志与控制台标题 */
  id: string;
  /** 一句话说明,启动器列表里显示 */
  description?: string;
  /** 层1+层2:框架默认 ← Persona的建议。World 的默认段不在这里,由 `withWorlds()` 补。 */
  defaults(): C;
  /**
   * 本机有的 World 实现:仓内目录加扩展,由启动器经 `withWorlds()` 填入,bot 包不写。
   * 按 `worlds.<id>.enabled` 决定哪些挂进 core;控制台可热激活 / 停用 / 重启。
   */
  worlds?: readonly WorldDefinition<WorldSection>[];
  /**
   * Persona为之设计的渠道。字符串 = World id:有实现的默认 `enabled: true`,没实现的在
   * 控制台是灰卡;对象 = 没有实现的占位,控制台展示它的 reason。有实现但没声明的 World
   * 按部署侧选配显示,默认关。
   */
  declares?: readonly WorldDeclaration[];
  /**
   * 造出Persona。配置此时已经合并完成;`worlds` 是**活的挂载表**(与 core 共用
   * 同一个数组,激活/停用就地增删),Persona持引用、用时再读。
   */
  build(loaded: LoadedConfig<C>, worlds: World[]): BotParts<C>;
}

export interface BotStartContext<C extends CoreConfig> {
  core: Core<C>;
  loaded: LoadedConfig<C>;
  /** 控制台实际监听的端口;不起控制台时为 null */
  port: number | null;
}

export interface BotParts<C extends CoreConfig = CoreConfig> {
  persona: Persona;
  /**
   * 预建的 World 实例(不经定义装配的那种:测试替身、一次性接线)。永远挂载,
   * 控制台只能停/起不能重建;同 id 会顶掉定义装出来的槽位。
   */
  worlds?: World[];
  llm?: ResponseClient;
  console?: ConsoleContribution;
  onStart?(ctx: BotStartContext<C>): void | Promise<void>;
  onStop?(): void | Promise<void>;
}

/**
 * 控制台增量。框架把能派生的都派生好了,这里只补它派生不出来的部分——
 * 也就是需要知道"这个 bot 是怎样的"的那些。
 */
export interface ConsoleContribution {
  /** false = 完全不起控制台(无头运行) */
  enabled?: boolean;
  /** 追加到框架那几条之后的可清除存储部分(如某个 World 自己的缓存) */
  storage?: StoragePart[];
  /** 追加的可调配置组(Persona那组;core 与各 World 的由框架收拢) */
  configGroups?: ConfigGroup[];
  /** `x-options` 下拉的活选项(如播放设备表) */
  configOptions?(kind: string): Array<{ value: string; label: string }>;
  /** 合并进状态快照的实现特有字段(框架给的基础字段在前,这里覆盖) */
  status?(): Record<string, unknown>;
  /**
   * bot 自有的固定提示词源文件(ORIENTATION 一类),与 World console().promptDocs 同形;
   * 读写由框架代办,列在 scope=persona 下(core 核心不持有任何提示词模板)。
   */
  promptDocs?: PromptDocDecl[];
  /**
   * 非主循环 session 的额外工具 schema。
   * 每个 session 的声明方负责在此补充其工具。
   */
  extraToolSchemas?(): ToolSchema[];
  /**
   * bot 级的控制台页(部署绑定的那些:模型档位、存档点、统一重置)。
   *
   * 与 `Persona.console?()` 分工:
   * Persona出**认知绑定**的(记忆视图、工作区、入梦);这里出**部署绑定**的
   * ——它们要写 config.json、要跨 owner 编排,不属于Persona的纯认知职责。
   *
   * bot 专属控制面只有这一条路:框架不再有任何具名扩展槽位。
   */
  consolePages?(ctx: ConsolePageBuildContext): ConsolePageContribution[];
}

/**
 * 框架在问 bot 要控制台页时**顺手交给它**的那些事实。
 *
 * 目前只有一样:完整的可清除存储清单。统一重置由 bot 编排、框架不提供通用
 * transaction,但那条只有在 bot 真能拿到**权威清单**时才成立——清单是框架拼的
 * (core 派生 + 各 World console().storage + bot 自己追加),bot 重造一份就是
 * 禁止的"两套实现"。
 */
export interface ConsolePageBuildContext {
  /** 权威的可清除存储清单,与 `/api/storage` 看到的是同一批对象。 */
  storage: readonly StoragePart[];
}

/** 关机仪式里的一步。`ok=false` 时 `detail` 说的是没走完的原因(超时或异常)。 */
export interface ShutdownStep {
  key: string;
  label: string;
  ok: boolean;
  elapsedMs: number;
  detail?: string;
}

/** 一次关机的账。本地步骤与外部状态分开记录，`complete` 同时要求两者通过。 */
export interface ShutdownReport {
  reason: string;
  localComplete: boolean;
  complete: boolean;
  steps: ShutdownStep[];
  externalChecks: ShutdownExternalCheck[];
}

export interface Bot<C extends CoreConfig = CoreConfig> {
  core: Core<C>;
  parts: BotParts<C>;
  /** World 槽位表:挂载表、未激活槽位与缺失声明。 */
  assembly: WorldAssembly;
  webApp: WebApp | null;
  /** 启动全部;返回控制台端口(未起控制台=null) */
  start(): Promise<{ port: number | null }>;
  stop(): Promise<void>;
  /**
   * 规范关机仪式。`stop()` 是"把东西关掉",这是"按顺序、带钟、留账地关掉":
   * 每一步单独计时,失败或超时都不阻断后面的步骤,最后把逐步结果交给调用方
   * (控制台显示、启动器决定退出码)。**不负责 `process.exit`** —— 进程什么时候
   * 走是启动器的事,库不替它决定。
   */
  shutdown(reason?: string): Promise<ShutdownReport>;
}

/** 分步上限合计 33 秒；每一步超时只推进编排，不会取消外部 promise。 */
const SHUTDOWN_BUDGET_MS = {
  pause: 2_000,
  worlds: 22_000,
  core: 1_000,
  llm: 3_000,
  flush: 2_000,
  web: 3_000,
} as const;


/** 控制台看得见的框架级文案:存储页、可见性回执、关机仪式。中文是原文。 */
const BOT_TEXT = {
  zh: {
    noFile: '(无文件)',
    storage: {
      events: {
        label: '事件库(本次运行的分片)',
        note: '只抹本次运行落库的经历,更早的 run 目录不动;游标不回退',
        stat: (count: number, cursor: number, size: string) => `${count}条(游标至 ${cursor}) / ${size}`,
        cleared: (n: number) => `已清除本次运行的${n}条事件`,
      },
      session: {
        label: '主session(当前对话上下文)',
        note: '当场失忆重开(记忆内容与事件库不动,可经记忆与历史工具找回);最好在空闲时操作',
        stat: (records: number, ktok: number, size: string) => `${records}条 / ~${ktok}k tok / ${size}`,
        cleared: 'session已清空重开(system前缀+开场消息)',
      },
      runlog: {
        label: '运行日志(本次运行)',
        note: '纯观察日志,agent不可见,清除无副作用;更早的 run 目录不动',
        cleared: '运行日志已清空',
      },
      usage: {
        label: 'token用量流水(成本页数据源)',
        note: '每次LLM调用的历史用量/成本,纯观察,agent不可见,清除后成本页只剩本次运行以后的数据',
        stat: (n: number, size: string) => `${n}条 / ${size}`,
        cleared: (n: number) => `已清除${n}条用量记录`,
      },
      toolcalls: {
        label: '工具调用流水(工具名/原始参数/回执)',
        note: '主循环每次模型工具调用一行,纯观察,agent不可见',
        cleared: '工具调用流水已清空',
      },
      state: {
        label: 'core状态(人格状态袋/截断标记)',
        note: 'Persona存的那袋东西清空,截断状态归零;World 可见性保留',
        stat: (n: number, lastHandoff: string) => `人格状态${n}项 / 上次交接${lastHandoff}`,
        never: '无',
        cleared: 'core状态已重置为默认',
      },
      wakes: {
        label: '持久定时器(闹钟等)',
        note: '全部定时器取消(不产生通知)',
        stat: (n: number) => `${n}个待触发`,
        cleared: (n: number) => `已取消${n}个定时器`,
      },
      tracker: {
        label: 'session统计(usage/缓存命中)',
        note: '仪表数据清零(进行中的 session 保留条目);不影响运行',
        stat: (n: number) => `${n}个session`,
        cleared: 'session统计已清零',
      },
      pending: {
        label: '待投递事件(还没投给 agent 的那批)',
        note:
          '暂停期间积压的事件与心跳一律丢弃,继续之后不会再涌出来。'
          + '事件本身已经落库,历史工具照样查得到,丢的只是这一次唤醒。'
          + 'World 挂的待成文观察(人流读数这类)不在此列:它们的正文在发车刻才现渲染,'
          + '留着不会变陈旧,丢了反而会让 World 哑掉',
        stat: (n: number) => `${n}条待投递`,
        cleared: (n: number) => `已丢弃${n}条待投递事件`,
      },
    },
    visibility: {
      shown: (id: string) => `${id} 对 agent 重新可见。事件投递已恢复;前缀段与工具要等前缀重载才回来。`,
      hidden: (id: string) => `${id} 已对 agent 隐藏。新事件不再唤醒 agent(仍照常落库);前缀段与工具要等前缀重载才撤下。`,
      prefixReloaded: (kept: number) => `系统前缀与工具表已重载，保留当前session的${kept}条既有消息`,
    },
    shutdown: {
      pause: '按住事件投递',
      worlds: 'World 收尾(托管的外部进程与存档都在这一步)',
      core: 'Persona收尾',
      modulesTimedOut: 'World 收尾整体超时',
      externalState: (worldId: string) => `${worldId} 外部状态`,
      stopIncomplete: (detail: string) => `World 停止未完成，不能采用外部核验缓存:${detail}`,
      cacheReadFailed: (detail: string) => `读取已缓存的关机验证结果失败:${detail}`,
      manualCheck: '立即人工检查对应外部系统；在确认前不要假定外部服务已经结束。',
      llm: 'Provider 实例停机',
      flush: 'core 状态落盘',
      web: '关闭控制台',
      summarySkipped: '本地关机完成:有步骤被跳过',
      summaryComplete: '本地关机完成:各步全部走完',
      summaryUnverified: (items: string[]) => `本地关机完成,但外部状态未确认结束:${items.join('、')}(需人工确认)`,
    },
  },
  en: {
    noFile: '(no file)',
    storage: {
      events: {
        label: "Event store (this run's shard)",
        note: 'Wipes only what this run stored; earlier run directories are untouched and the cursor does not rewind',
        stat: (count: number, cursor: number, size: string) => `${count} records (cursor at ${cursor}) / ${size}`,
        cleared: (n: number) => `Cleared ${n} events from this run`,
      },
      session: {
        label: 'Main session (current conversation context)',
        note: 'Reopens with the context wiped on the spot (memory content and the event store stay, reachable through the memory and history tools); best done while idle',
        stat: (records: number, ktok: number, size: string) => `${records} records / ~${ktok}k tok / ${size}`,
        cleared: 'Session cleared and reopened (system prefix + opening message)',
      },
      runlog: {
        label: 'Run log (this run)',
        note: 'Observation-only log, invisible to the agent; clearing has no side effects and earlier run directories are untouched',
        cleared: 'Run log cleared',
      },
      usage: {
        label: 'Token usage ledger (source of the cost page)',
        note: 'Usage and cost of every LLM call, observation-only and invisible to the agent; after clearing, the cost page only shows data from this run onward',
        stat: (n: number, size: string) => `${n} records / ${size}`,
        cleared: (n: number) => `Cleared ${n} usage records`,
      },
      toolcalls: {
        label: 'Tool call ledger (tool name / raw arguments / receipt)',
        note: 'One line per model tool call in the main loop, observation-only and invisible to the agent',
        cleared: 'Tool call ledger cleared',
      },
      state: {
        label: 'Core state (persona state bag / truncation marks)',
        note: 'Empties the bag the Persona stores and resets truncation state; module visibility is kept',
        stat: (n: number, lastHandoff: string) => `${n} persona state entries / last handoff ${lastHandoff}`,
        never: 'none',
        cleared: 'Core state reset to defaults',
      },
      wakes: {
        label: 'Persistent timers (alarms and the like)',
        note: 'Cancels every timer (no notifications are produced)',
        stat: (n: number) => `${n} pending`,
        cleared: (n: number) => `Cancelled ${n} timers`,
      },
      tracker: {
        label: 'Session statistics (usage / cache hits)',
        note: 'Zeroes the gauges (sessions in progress keep their entries); does not affect the run',
        stat: (n: number) => `${n} sessions`,
        cleared: 'Session statistics zeroed',
      },
      pending: {
        label: 'Pending events (the batch not yet delivered to the agent)',
        note:
          'Events and heartbeats that piled up while paused are all discarded and will not pour out after resuming. '
          + 'The events themselves are already stored and the history tools still find them; only this wake is lost. '
          + 'Deferred observations hung by worlds (visitor counts and the like) are not included: their text is rendered at delivery time, '
          + 'keeping them never goes stale, and dropping them would silence the module',
        stat: (n: number) => `${n} pending`,
        cleared: (n: number) => `Discarded ${n} pending events`,
      },
    },
    visibility: {
      shown: (id: string) => `${id} is visible to the agent again. Event delivery has resumed; its prefix segment and tools return once the prefix is reloaded.`,
      hidden: (id: string) => `${id} is now hidden from the agent. New events no longer wake the agent (they are still stored); its prefix segment and tools are removed once the prefix is reloaded.`,
      prefixReloaded: (kept: number) => `System prefix and tool table reloaded; ${kept} existing messages of the current session kept`,
    },
    shutdown: {
      pause: 'Hold event delivery',
      worlds: 'Wind down IO worlds (managed external processes and world saves happen here)',
      core: 'Wind down the Persona',
      modulesTimedOut: 'World wind-down timed out as a whole',
      externalState: (worldId: string) => `${worldId} external state`,
      stopIncomplete: (detail: string) => `World stop incomplete, so the cached external verification cannot be used: ${detail}`,
      cacheReadFailed: (detail: string) => `Failed to read the cached shutdown verification: ${detail}`,
      manualCheck: 'Check the corresponding external system by hand now; do not assume the external service has ended until confirmed.',
      llm: 'Stop provider instances',
      flush: 'Persist core state',
      web: 'Close the console',
      summarySkipped: 'Local shutdown finished: some steps were skipped',
      summaryComplete: 'Local shutdown finished: every step completed',
      summaryUnverified: (items: string[]) => `Local shutdown finished, but external state is not confirmed ended: ${items.join(', ')} (manual confirmation needed)`,
    },
  },
};
type BotText = (typeof BOT_TEXT)['zh'];
const botText = (language: Language): BotText => pick(language, BOT_TEXT);

const fileSize = (dir: string, rel: string, noFile: string): string => {
  const p = join(dir, rel);
  if (!existsSync(p)) return noFile;
  try {
    return `${(statSync(p).size / 1024).toFixed(1)}KB`;
  } catch {
    return '?';
  }
};

/** 框架级可清除存储表面,完全从 core 字段派生。 */
function deriveStorage<C extends CoreConfig>(core: Core<C>, dataDir: string, language: Language): StoragePart[] {
  const t = botText(language);
  const size = (dir: string, rel: string): string => fileSize(dir, rel, t.noFile);
  const s = t.storage;
  return [
    {
      key: 'events',
      label: s.events.label,
      kind: 'disk',
      location: `data/runs/${core.run.id}/events.jsonl`,
      danger: true,
      note: s.events.note,
      stat: () => s.events.stat(core.store.currentCount(), core.store.latestCursor(), size(core.run.dir, 'events.jsonl')),
      clear: () => s.events.cleared(core.store.clear()),
    },
    {
      key: 'session',
      label: s.session.label,
      kind: 'disk',
      location: 'data/session-main.jsonl',
      danger: true,
      // 一键清空时最后执行:清完即重建前缀+开场,保证"重开"落在全清后的世界上
      order: 10,
      note: s.session.note,
      stat: () =>
        s.session.stat(core.session.records.length, Math.round(core.session.estTokens() / 1000), size(dataDir, 'session-main.jsonl')),
      clear: async () => {
        await core.loop.clearSession();
        return s.session.cleared;
      },
    },
    {
      key: 'runlog',
      label: s.runlog.label,
      kind: 'disk',
      location: `data/runs/${core.run.id}/log.jsonl`,
      note: s.runlog.note,
      stat: () => size(core.run.dir, 'log.jsonl'),
      clear: () => {
        core.runlog.clear();
        return s.runlog.cleared;
      },
    },
    {
      key: 'usage',
      label: s.usage.label,
      kind: 'disk',
      location: 'data/usage.jsonl',
      note: s.usage.note,
      stat: () => s.usage.stat(core.usageLog.count(), size(dataDir, 'usage.jsonl')),
      clear: () => s.usage.cleared(core.usageLog.clear()),
    },
    {
      key: 'toolcalls',
      label: s.toolcalls.label,
      kind: 'disk',
      location: `data/runs/${core.run.id}/toolcalls.jsonl`,
      note: s.toolcalls.note,
      stat: () => core.toolLog.stat(),
      clear: () => {
        core.toolLog.clear();
        return s.toolcalls.cleared;
      },
    },
    {
      key: 'state',
      label: s.state.label,
      kind: 'disk',
      location: 'data/core-state.json',
      note: s.state.note,
      stat: () =>
        s.state.stat(Object.keys(core.state.data.persona).length, core.state.data.lastTruncateAt ?? s.state.never),
      clear: () => {
        core.state.clear();
        return s.state.cleared;
      },
    },
    {
      key: 'wakes',
      label: s.wakes.label,
      kind: 'disk',
      location: 'data/timers.json',
      note: s.wakes.note,
      stat: () => s.wakes.stat(core.timers.list().length),
      clear: () => s.wakes.cleared(core.timers.clearAll()),
    },
    {
      key: 'tracker',
      label: s.tracker.label,
      kind: 'memory',
      note: s.tracker.note,
      stat: () => s.tracker.stat(core.sessions.list().length),
      clear: () => {
        core.sessions.reset();
        return s.tracker.cleared;
      },
    },
    {
      // pending 在 session 之前清理,以缩短运行中 World 重新入队的窗口。
      // 清理同时复位 bus 的 ready 状态与批次计时器。
      key: 'pending',
      label: s.pending.label,
      kind: 'memory',
      order: 9,
      note: s.pending.note,
      stat: () => s.pending.stat(core.bus.pending()),
      // 只丢弃已发生的事件与候选票据。待投递成文项在发车时渲染，保留它们以执行 World 的复位逻辑。
      clear: () => s.pending.cleared(core.discardPendingEvents()),
    },
  ];
}

/**
 * 可编辑固定提示词由装配层、Persona与 World 各自声明的 `promptDocs` 组成。
 * 读写在此统一完成:读文件、计算 revision、原子写入。
 * 只上控制台的 World 实例也算:它的环境提示词在激活之前就该能改。
 *
 * World 的环境提示词(`role: 'envPrompt'`)有两层:World 自带的模板是默认,bot 目录下
 * `worlds/<Worldid>/ENV_PROMPT.md` 存在即整份覆盖。保存只写 bot 侧那份(首次保存时建出来),
 * World 自带的模板不经控制台改;`reset` 删掉覆盖文件即回到默认。
 *
 * 框架从不往代码包里写。环境提示词的写侧永远是部署目录;Persona 的模板没给 `deploymentPath`
 * 时读写同一个 `path`,仓内 bot 那是 git 工作树里的模板文件(开发者改它本来就是要进 git 的),
 * 扩展包来源的 bot(`packageReadOnly`)则只读——pnpm 把包文件硬链接进 store,透过链接写会
 * 改坏 store 里那份。
 */
function derivePrompts<C extends CoreConfig>(
  parts: BotParts<C>,
  assembly: WorldAssembly,
  contribution: ConsoleContribution,
  timezone: string,
  dirs: EnvPromptDirs,
  packageReadOnly: boolean,
): WebAppPromptDeps | undefined {
  const personaDocs = parts.persona.console?.().promptDocs ?? [];
  // 同 key 先到先得:装配层的声明可以覆盖Persona自报的同名源
  // (部署把某份文件换成自己的那份时用;测试也靠这个换临时文件)。
  const seen = new Set<string>();
  const docs = [
    ...(contribution.promptDocs ?? []).map((d) => ({ ...d, scope: 'persona' as const })),
    ...personaDocs.map((d) => ({ ...d, scope: 'persona' as const })),
    // 未激活槽位的模板也列出来:接入前就要能改。
    ...assembly.instances()
      .flatMap((m) => (m.console?.()?.promptDocs ?? []).map((d) => ({ ...d, scope: 'world' as const, worldId: m.id }))),
  ].filter((d) => (seen.has(d.key) ? false : (seen.add(d.key), true)));
  if (docs.length === 0) return undefined;
  const byKey = new Map(docs.map((d) => [d.key, d]));
  const revisionOf = (content: string): string => createHash('sha256').update(content).digest('hex');

  /** 一份模板此刻读哪份文件、存到哪份文件。`origin` 只有 World 的环境提示词才有。 */
  const sourceOf = (d: (typeof docs)[number]): { readPath: string; writePath: string; origin?: EnvPromptOrigin } => {
    if (d.scope === 'world' && d.role === 'envPrompt') {
      const { path, origin } = envPromptTemplateSource(d, d.worldId, dirs);
      // 写永远落在部署层:部署者调出来的提示词是私有资产,不该写进代码包被一起发出去。
      const writeDir = dirs.deploymentDir;
      return { readPath: path, writePath: writeDir ? envPromptOverridePath(writeDir, d.worldId) : d.path, origin };
    }
    // Persona的模板同一条道理:声明方给了部署侧覆盖路径,写就落到那边。
    // `d.path` 已经是声明方解析过的"此刻该读哪一份"。
    if (d.deploymentPath) {
      return {
        readPath: d.path,
        writePath: d.deploymentPath,
        origin: d.path === d.deploymentPath ? 'deployment' : 'package',
      };
    }
    return { readPath: d.path, writePath: d.path };
  };

  /**
   * 每个占位符**此刻**填什么。编辑器把它显示在旁注里——比任何文字描述都直观。
   * World 的直接问 World;Persona的走可选的 promptVarValues()。取值失败不该拖垮
   * 整个页面,所以逐个吞掉异常(旁注少一条,总好过编辑器打不开)。
   */
  const varValues = async (): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    try {
      Object.assign(out, await parts.persona.promptVarValues?.({
        now: new Date(),
        timezone,
      }) ?? {});
    } catch { /* Persona报不出来就不报 */ }
    for (const m of assembly.instances()) {
      try {
        Object.assign(out, (await m.envPromptVars()) ?? {});
      } catch { /* 单个 World 报不出来不连坐其它 */ }
    }
    return out;
  };

  /** 声明的源文件可以尚不存在(部署侧的文本在首次保存前没有那份文件):读作空。 */
  const readSource = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');

  const readDoc = (d: (typeof docs)[number], values: Record<string, string>): PromptDocument => {
    const { readPath, origin } = sourceOf(d);
    const content = readSource(readPath);
    return {
      ...(d.role ? { role: d.role } : {}),
      ...(origin ? { origin } : {}),
      ...(d.vars?.length
        ? {
            vars: d.vars.map((v) => ({
              ...v,
              ...(Object.prototype.hasOwnProperty.call(values, v.name) ? { value: values[v.name] } : {}),
            })),
          }
        : {}),
      key: d.key,
      title: d.title,
      scope: d.scope,
      description: d.description,
      content,
      revision: revisionOf(content),
    };
  };
  return {
    list: async () => {
      const values = await varValues();
      return docs.map((d) => readDoc(d, values));
    },
    prefix: () => assembleSystemSegments({
      persona: parts.persona,
      worlds: assembly.mounted,
      now: new Date(),
      timezone,
      dirs,
    }),
    write: (key, content, baseRevision) => {
      const doc = byKey.get(key);
      if (!doc) throw new Error(`未知提示词模板: ${key}`);
      if (packageReadOnly && doc.scope === 'persona' && !doc.deploymentPath) {
        throw new Error(`${doc.title} 住在扩展包里,包内文件只读;要让它可改,bot 包在这份模板的声明里给出 deploymentPath。`);
      }
      const { readPath, writePath, origin } = sourceOf(doc);
      if (baseRevision) {
        const cur = revisionOf(readSource(readPath));
        if (cur !== baseRevision) throw new Error(`${doc.title} 已在别处被修改,请重新载入后再保存`);
      }
      mkdirSync(dirname(writePath), { recursive: true });
      const tmp = `${writePath}.tmp-${Math.random().toString(36).slice(2, 10)}`;
      try {
        writeFileSync(tmp, content, 'utf8');
        renameSync(tmp, writePath);
      } catch (error) {
        try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* 保留原始写入错误 */ }
        throw error;
      }
      return origin ? `已保存 ${doc.title}(写入本 bot 的覆盖文件,World 自带的模板未动)` : `已保存 ${doc.title}`;
    },
    reset: (key) => {
      const doc = byKey.get(key);
      if (!doc) throw new Error(`未知提示词模板: ${key}`);
      const { writePath, origin } = sourceOf(doc);
      if (!origin) throw new Error(`${doc.title} 不是 World 的环境提示词,没有 World 默认可恢复`);
      if (origin === 'module') return `${doc.title} 本来就在用 World 默认`;
      unlinkSync(writePath);
      return `已删除本 bot 对 ${doc.title} 的覆盖,回到 World 默认`;
    },
  };
}

/**
 * 三态清单与控制台页适配只用得到 core 的这一件事实。写成结构类型而不是
 * `Core<C>`,是为了让"这两个函数只依赖可见性"在签名上说得出口。
 */
type WorldVisibilityFacts = Pick<Core<CoreConfig>, 'worldVisibility'>;

/**
 * 三态清单去掉 `envPrompt` 的那一份。
 *
 * 两条路要的东西不一样:manifest 只要三态事实与声明,`/api/worlds` 还要那段
 * 渲染好的环境提示词。渲染要读模板文件并插值,是这批事实里唯一贵的一步,而灯要
 * 秒级刷新——所以贵的那步单独一层,只有真需要的调用方付。
 */
export type WorldFacts =
  | Omit<WorldInfo, 'envPrompt'>
  | Extract<ConsoleWorldInfo, { status: 'inactive' | 'missing' }>;

/** 槽位表 → 控制台那份三态清单(不含 envPrompt):挂载=active,有定义没挂=inactive,声明了没定义=missing。 */
export function deriveWorldFacts(
  core: WorldVisibilityFacts,
  assembly: WorldAssembly,
): WorldFacts[] {
  const { visibility, driftedWorlds } = core.worldVisibility();
  const slots: WorldFacts[] = assembly.slots.map((slot) => {
    const m = slot.instance;
    // 控制台内容由 World 声明;框架不按 World id 分支。显示名也归它报,不报用定义里的。
    let decl;
    try {
      decl = m.console?.();
    } catch {
      decl = undefined;
    }
    const label = decl?.label ?? slot.label;
    if (!slot.mounted) {
      return { id: slot.id, status: 'inactive' as const, label, declared: slot.declared };
    }
    return {
      id: m.id,
      status: 'active' as const,
      label,
      declared: slot.declared,
      workspace: `worlds/${m.id}`,
      tools: m.tools().map((t) => t.name),
      visible: visibility[m.id] !== false,
      prefixDrifted: driftedWorlds.includes(m.id),
      ...(decl?.lamps?.length ? { lamps: decl.lamps } : {}),
      ...(decl?.badges ? { badges: decl.badges } : {}),
      ...(decl?.links ? { links: decl.links } : {}),
    };
  });
  const missing: WorldFacts[] = assembly.missing.map((m) => ({
    id: m.id,
    status: 'missing' as const,
    label: m.label,
    declared: m.declared ?? true,
    reason: m.reason,
  }));
  return [...slots, ...missing];
}

/** 三态清单 + 每个已挂 World 那段渲染好的环境提示词(`/api/worlds` 用)。 */
async function deriveWorldInfo(
  core: WorldVisibilityFacts,
  assembly: WorldAssembly,
  dirs: EnvPromptDirs,
): Promise<ConsoleWorldInfo[]> {
  return Promise.all(deriveWorldFacts(core, assembly).map(async (facts) => {
    if (facts.status !== 'active') return facts;
    return { ...facts, envPrompt: (await renderWorldEnvPrompt(assembly.slot(facts.id).instance, dirs)).text };
  }));
}

/**
 * 全部槽位的可清除存储。槽位实例会在停用/重启时重建,所以 stat/clear 每次都
 * 解析到当前实例上同 key 的那一项;装配期报过的 key 就是清单的全部。
 */
function deriveSlotStorage(assembly: WorldAssembly): StoragePart[] {
  return assembly.slots.flatMap((slot) =>
    (slot.instance.console?.()?.storage ?? []).map((part): StoragePart => {
      const current = (): StoragePart => {
        const found = slot.instance.console?.()?.storage?.find((p) => p.key === part.key);
        if (!found) throw new Error(`${slot.id} 的存储项 ${part.key} 在当前实例上不存在`);
        return found;
      };
      return { ...part, stat: () => current().stat(), clear: () => current().clear() };
    }),
  );
}


// World 到控制台页的适配。panel id 在一页内唯一，使用声明方给出的局部 id，不剥除或追加前缀。

/**
 * 把一个 World 这一刻的 `console()` 声明适配成一份控制台页贡献。
 *
 * **对所有 World 一视同仁**:不按 World id 分支,也不重算三态——`availability` /
 * `declared` / `reason` / `agentVisible` / `prefixDrifted` 一律取
 * `deriveWorldInfo` 已经算好的那份事实。没有对应事实条目的(只上控制台、
 * 目录里也没列的实例)按未激活计。
 *
 * `console()` 抛错就让它抛:ConsolePageRegistry 逐 source 隔离,一个坏 World
 * 不会带走别人的页。
 */
/**
 * 导出是为了让 `scripts/dev-console.ts` 走**同一条**适配路径。开发态自己拼一份
 * contribution 的话,两边的归一化早晚会漂,而漂出来的差异只会在真跑的时候暴露。
 */
/** 声明侧的 panel 形状 → manifest 形状。id 已经是局部的,不做任何改写。 */
function normalizePanelDecls(
  panels: readonly WorldPanelDecl[],
): Array<{ id: string; title: string; description?: string; getMethods?: readonly string[] }> {
  return panels.map((p) => ({
    id: p.id,
    title: p.title,
    ...(p.description ? { description: p.description } : {}),
    ...(p.getMethods ? { getMethods: [...p.getMethods] } : {}),
  }));
}

export function ioPageContribution(
  worldId: string,
  label: string,
  info: WorldFacts | undefined,
  mod: World | undefined,
): ConsolePageContribution {
  const decl = mod?.console?.();
  const declaredPanels = decl?.panels ?? [];
  const out: ConsolePageContribution = {
    id: pageIdFor('world', worldId),
    kind: 'world',
    label: decl?.label ?? label,
    availability: info?.status ?? 'inactive',
  };
  if (decl?.lamps?.length) out.lamps = decl.lamps;
  if (decl?.badges?.length) out.badges = decl.badges;
  if (declaredPanels.length) out.panels = normalizePanelDecls(declaredPanels);
  if (decl?.links?.length) out.links = decl.links;
  if (decl?.config?.length) out.config = decl.config;
  if (decl?.promptDocs?.length) out.promptDocs = decl.promptDocs;
  if (decl?.storage?.length) out.storage = decl.storage;
  if (info?.declared !== undefined) out.declared = info.declared;
  if (info?.status === 'missing') out.reason = info.reason;
  if (info?.status === 'active') {
    if (info.visible !== undefined) out.agentVisible = info.visible;
    if (info.prefixDrifted !== undefined) out.prefixDrifted = info.prefixDrifted;
  }
  const invoke = decl?.invoke;
  if (invoke) {
    out.invoke = (panel, method, args) =>
      invoke(panel, method, args);
  }
  // 流式面与 invoke 同形转发:框架只做 panel id 的反归一化,连接语义全归 World。
  const stream = decl?.stream;
  if (stream) {
    out.stream = (panel, socket) =>
      stream(panel, socket);
  }
  return out;
}

/**
 * 每个 World(已挂载的、只上控制台的、目录里未激活/未装上的)各出一个
 * `ConsolePageSource`。装配层决定收什么,`WebApp` 只负责聚合与转交。
 */
/**
 * Persona自报的控制面 → 一页 `persona:<botId>`。
 *
 * 与 IO 那条走同一套归一化,所以Persona与 World 在控制台眼里是同一种东西——
 * 这正是"换人格 Web Core 零修改"要的形状。
 */
export function personaPageContribution(
  botId: string,
  label: string,
  core: Persona,
): ConsolePageContribution | null {
  const decl = core.console?.();
  if (!decl) return null;
  const declaredPanels = decl.panels ?? [];
  const out: ConsolePageContribution = {
    id: pageIdFor('persona', botId),
    kind: 'persona',
    label,
    availability: 'active',
  };
  if (decl.badges?.length) out.badges = decl.badges;
  if (declaredPanels.length) out.panels = normalizePanelDecls(declaredPanels);
  if (decl.config?.length) out.config = decl.config;
  if (decl.promptDocs?.length) out.promptDocs = decl.promptDocs;
  if (decl.storage?.length) out.storage = decl.storage;
  const invoke = decl.invoke;
  if (invoke) {
    out.invoke = (panel, method, args) =>
      invoke(panel, method, args);
  }
  return out;
}

/**
 * 把若干份同 id 的人格侧贡献合成一份。
 *
 * `invoke` 按 **panel 归属**分派:哪一份声明了这个 panel 就转给哪一份。所以两半
 * 各写各的、互不知道对方存在,而面板 id 撞了会被 `validateContributions` 当场
 * 判重复(那是正确的——两个实现抢同一个面板,静默选一个才是灾难)。
 */
export function mergePersonaContributions(
  id: string,
  label: string,
  core: ConsolePageContribution | null,
  extras: readonly ConsolePageContribution[],
): ConsolePageContribution | null {
  const parts = [core, ...extras].filter((c): c is ConsolePageContribution => !!c);
  if (parts.length === 0) return null;
  if (parts.length === 1 && parts[0]) return parts[0];

  const out: ConsolePageContribution = {
    id,
    kind: 'persona',
    label: parts.find((p) => p.label)?.label ?? label,
    availability: 'active',
  };
  const badges = parts.flatMap((p) => p.badges ?? []);
  if (badges.length) out.badges = badges;
  const links = parts.flatMap((p) => p.links ?? []);
  if (links.length) out.links = links;
  const config = parts.flatMap((p) => p.config ?? []);
  if (config.length) out.config = config;
  const promptDocs = parts.flatMap((p) => p.promptDocs ?? []);
  if (promptDocs.length) out.promptDocs = promptDocs;
  const storage = parts.flatMap((p) => p.storage ?? []);
  if (storage.length) out.storage = storage;

  const panels = parts.flatMap((p) => p.panels ?? []);
  if (panels.length) out.panels = panels;

  /** panel id → 声明它的那一份。 */
  const owner = new Map<string, ConsolePageContribution>();
  for (const p of parts) {
    for (const panel of p.panels ?? []) {
      if (!owner.has(panel.id)) owner.set(panel.id, p);
    }
  }
  if (parts.some((p) => p.invoke)) {
    out.invoke = async (panel, method, args) => {
      const target = owner.get(panel);
      if (!target?.invoke) throw new Error(`没有面板数据面: ${panel}`);
      return target.invoke(panel, method, args);
    };
  }
  if (parts.some((p) => p.stream)) {
    out.stream = (panel, socket) => {
      const target = owner.get(panel);
      if (!target?.stream) throw new Error(`没有流式面: ${panel}`);
      target.stream(panel, socket);
    };
  }
  return out;
}

export function deriveConsolePageSources(
  core: WorldVisibilityFacts,
  // persona 只在给了 `bot` 时才用得上,所以是可选的——只装 IO 的调用方
  // (以及测试)不必造一个Persona出来。
  parts: { assembly: WorldAssembly; persona?: Persona },
  /**
   * bot 自身的标识与显示名;人格那一页用它命名。
   *
   * `configGroups` 是 bot 级声明的那批旋钮(`ConsoleContribution.configGroups`)。
   * 它们要跟着人格那一页走:控制台按**声明的归属**决定一组旋钮画在哪一页,
   * 不认领就落回框架自己的设置页。Persona自报的那半在 `core.console().config`,
   * 两半在 `mergePersonaContributions` 里合成同一页。
   */
  bot?: { id: string; label: string; configGroups?: readonly ConfigGroup[] },
  /** 装配层追加的 bot 级控制台页(模型档位、存档点、统一重置这些部署绑定的)。 */
  extra?: () => ConsolePageContribution[],
): () => ConsolePageSource[] {
  const { assembly } = parts;
  const labelOf = (id: string): string => assembly.labelOf(id) ?? id;
  return () => {
    // registry 枚举一轮后会对每个 source 各调一次 contribute();三态事实按轮共享,
    // 否则 N 个 World 要各算一遍全量事实。
    //
    // 这条路要的是三态与声明,**不是** envPrompt——灯走的就是这条路,而它按秒刷新。
    let once: Map<string, WorldFacts> | null = null;
    const infos = (): Map<string, WorldFacts> => {
      once ??= new Map(deriveWorldFacts(core, assembly).map((i) => [i.id, i]));
      return once;
    };
    const instances = new Map<string, World>(assembly.slots.map((s) => [s.id, s.instance]));
    const ids = [...assembly.slots.map((s) => s.id), ...assembly.missing.map((m) => m.id)];
    const sources: ConsolePageSource[] = ids.map((id) => ({
      id: pageIdFor('world', id),
      contribute: () =>
        ioPageContribution(id, labelOf(id), infos().get(id), instances.get(id)),
    }));

    // Persona自报的那一个。没实现 console() 就没有,不是错误。
    const persona = parts.persona;
    const selfId = bot ? pageIdFor('persona', bot.id) : null;
    const extras = extra?.() ?? [];

    /**
     * Persona自报的那半，与装配层贡献的**同 id** 那半，合成一页。
     *
     * 两条接缝都以 bot 命名，不合的话就是同 id 重复 → 校验把**两个**一起丢掉。
     * 而且 asset key 就是 page id、构建按目录只出一份产物，拆成两个 id 的话
     * 必然有一个找不到自己的扩展。
     *
     * 合并之后那条"认知绑定 vs 部署绑定"的线**只决定代码写在哪**，不再是用户
     * 看得见的边界——同一页、同一个 bundle。这也是它该有的
     * 分量：那是包的组织问题，不是控制台的概念。
     */
    if (bot && selfId) {
      const own = extras.filter((c) => c.id === selfId);
      // bot 级声明的旋钮也是这一页的:装配层写在别处只是代码组织,
      // 对控制台来说它们与Persona自报的那批同属一页。
      // 标了 settingsPage 的组不认领:注册照旧(createBot 已把它收进 /api/config),
      // 控制台"未认领落回设置页"的规则会把它画到 设置 → 运行参数 的最下面。
      const claimedGroups = (bot.configGroups ?? []).filter((g) => g.settingsPage !== true);
      const botConfig: ConsolePageContribution[] = claimedGroups.length
        ? [{ id: selfId, kind: 'persona', label: bot.label, config: claimedGroups }]
        : [];
      sources.push({
        id: selfId,
        contribute: () => mergePersonaContributions(
          selfId,
          bot.label,
          persona ? personaPageContribution(bot.id, bot.label, persona) : null,
          [...own, ...botConfig],
        ),
      });
    }
    // 其余 bot 级的页各占一个 source,一个炸了不影响其余
    // (隔离在 registry 里,按 source 逐个 try)。
    for (const c of extras) {
      if (selfId && c.id === selfId) continue; // 已并入上面那条
      sources.push({ id: c.id, contribute: () => c });
    }
    return sources;
  };
}


export function createBot<C extends CoreConfig>(
  loaded: LoadedConfig<C>,
  definition: BotDefinition<C>,
  /**
   * `extensions`:启动时加载的扩展集,控制台的扩展面由它对账。不给 = 控制台没有那一页。
   * 它的 `bot` 说明这份部署的 bot 来自扩展包,包内的提示词模板因此只读。
   */
  opts: { extensions?: ExtensionSet } = {},
): Bot<C> {
  const cfg = loaded.config;
  // 环境提示词的两个覆盖层:包(层 2,进版本控制)与部署(层 3,不进)。控制台只写层 3。
  const promptDirs: EnvPromptDirs = {
    packageDir: loaded.packageDir ?? loaded.rootDir,
    deploymentDir: loaded.rootDir,
  };
  // 控制台语言:config.json 的 language 赢,否则按进程读一次系统语言。整场固定。
  const language = resolveLanguage(cfg.language);
  const text = pick(language, BOT_TEXT);
  const assembly = new WorldAssembly(loaded, definition.worlds ?? [], definition.declares ?? []);
  const parts = definition.build(loaded, assembly.mounted);
  if (parts.worlds?.length) assembly.addPrebuilt(parts.worlds);
  const contribution = parts.console ?? {};

  const core = new Core<C>(loaded, {
    persona: parts.persona,
    worlds: assembly.mounted,
    llm: parts.llm,
  });
  // World 生命周期是装配层的事实,Persona经时机钩子得知;想告诉 agent 由它自己注入。
  const notifyLifecycle = (event: WorldLifecycleEvent): void => {
    parts.persona.onWorldLifecycle?.(event);
  };
  assembly.bind({
    mount: (mod) => core.mountWorld(mod),
    unmount: async (id) => { await core.unmountWorld(id); },
    lifecycle: notifyLifecycle,
    // World 不得占用 Core 的保留帧名与 Persona 自有工具名;绑定时先把启动期已挂载的扫一遍。
    reservedToolNames: () => [...RESERVED_FRAME_NAMES, ...(parts.persona.ownToolNames?.() ?? [])],
  });

  // 未激活槽位的配置组也收:参数要在激活前就能改(激活时才构造实例读它们)。
  const configGroups: ConfigGroup[] = [
    coreConfigGroup(language),
    ...(contribution.configGroups ?? []),
    ...assembly.instances().flatMap((m) => m.console?.()?.config ?? []),
  ];

  // 端点表归全局(`<部署根>/providers/`),这份部署的 config.json 只留 activeProvider。
  const providerSettings = new ProviderSettings(cfg,core.providers,join(loaded.rootDir,'config.json'),loaded.providersDir ?? join(loaded.rootDir,'providers'));
  const allConfigGroups = () => [...configGroups,...providerSettings.groups()];
  const llmManagers = new Map<string,{stop():Promise<unknown>}>([['providers',{stop:()=>core.providers.stopAll()}]]);

  let webApp: WebApp | null = null;

  /**
   * 关机的**唯一**入口,两条路(控制台按钮、启动器收到信号)共用。
   *
   * 只跑一次:第二次进来拿到的是同一个 promise、同一份账。关机途中再点一次按钮
   * 不该把 World 的 `stop()` 跑第二遍 —— 那些 `stop()` 里有不少不是幂等的
   * (子进程 RPC、设备句柄、外部进程的 stdin)。
   */
  let shutdownOnce: Promise<ShutdownReport> | null = null;
  let coreStopOnce: Promise<void> | null = null;
  const stopCore = (): Promise<void> => {
    coreStopOnce ??= (async () => { await parts.onStop?.(); })();
    return coreStopOnce;
  };
  /**
   * 单实例锁。取在 start() 的第一步:控制台端口、托管 server、 World 的外部连接
   * 全在它后面,拦住的话一个副作用都还没发生。
   */
  let instanceLock: InstanceLock | null = null;

  const beginShutdown = (
    reason: string,
    opts: { closeWeb: boolean; exit: boolean },
  ): Promise<ShutdownReport> => {
    shutdownOnce ??= runShutdown({
      reason,
      core,
      worlds: [...assembly.mounted],
      stopCore,
      llmManagers,
      // 控制台那条把控制台留到最后关:这份账还要经它回给正在看页面的人。
      webApp: opts.closeWeb ? webApp : null,
      log: core.runlog.logger('shutdown'),
      language,
    }).then((report) => {
      instanceLock?.release();
      instanceLock = null;
      if (opts.exit) {
        // 回执先出门,再收控制台与进程。反过来的话操作员只看得到"连接断开",
        // 而"世界到底存上没有"正是他按这颗按钮想知道的事。
        setTimeout(() => {
          void Promise.resolve(webApp?.stop()).finally(() => {
            // 有步骤被跳过就用非零退出码说出来(日志里有逐步明细)。
            process.exit(report.complete ? 0 : 1);
          });
        }, 300);
      }
      return report;
    });
    return shutdownOnce;
  };

  if (contribution.enabled !== false) {
    const startedAt = new Date().toISOString();
    /**
     * 可清除存储清单在装配期生成一次，/api/storage 与 bot 的 consolePages 共用这些对象。
     * 贡献方须在 console().storage 中声明全部项目；stat 和 clear 可延迟执行，子进程代理也须在装配期提供完整声明。
     */
    const consoleStorage: StoragePart[] = [
      ...deriveStorage(core, loaded.dataDir, language),
      ...(parts.persona.console?.()?.storage ?? []),
      ...deriveSlotStorage(assembly),
      ...(contribution.storage ?? []),
    ];
    webApp = new WebApp({
      store: core.store,
      memoryDir: loaded.memoryDir,
      dataDir: loaded.dataDir,
      botDir: loaded.rootDir,
      language,
      sessions: core.sessions,
      storage: consoleStorage,
      usage: { aggregate: (opts) => aggregateUsage(core.usageLog.readAll(), opts), status: () => core.usageLog.status() },
      config: {
        groups: () => allConfigGroups().map((group) => ({ group, values: group.owner.startsWith('provider:') ? providerSettings.values(group.id) : readGroupValues(cfg, group) })),
        set: (groupId: string, values: ConfigValues) => {
          const group = allConfigGroups().find((g) => g.id === groupId);
          if (group?.owner.startsWith('provider:')) return providerSettings.setConfig(groupId,values);
          if (!group) return `没有这一组配置: ${groupId}`;
          const root = cfg as unknown as Record<string, unknown>;
          for (const [path, v] of Object.entries(values)) setConfigPath(root, path, v);
          return `${group.schema.title}已更新,已写回 ${persistConfig(loaded, values)}`;
        },
        // 先问 bot(Persona自己那几组),再依次问 World 定义;第一个给出非空表的赢。
        options: (kind) => {
          const own = contribution.configOptions?.(kind);
          if (own?.length) return own;
          for (const def of definition.worlds ?? []) {
            const opts = def.configOptions?.(kind, language);
            if (opts?.length) return opts;
          }
          return [];
        },
      },
      worlds: async () => deriveWorldInfo(core, assembly, promptDirs),
      // 控制台页的三路来源:World、Persona自报(认知绑定)、
      // 装配层追加(部署绑定)。三者在控制台眼里是同一种东西。
      consolePageSources: () => [...deriveConsolePageSources(
        core,
        { assembly, persona: parts.persona },
        {
          id: definition.id,
          label: cfg.displayName || definition.id,
          // CORE_CONFIG_GROUP 不在其列:那是框架自己的旋钮,留在设置页。
          ...(contribution.configGroups?.length ? { configGroups: contribution.configGroups } : {}),
        },
        contribution.consolePages
          ? () => contribution.consolePages!({ storage: consoleStorage })
          : undefined,
      )(),...providerSettings.sources()],
      worldVisibility: {
        state: () => core.worldVisibility(),
        set: (id, visible) => {
          core.setWorldVisible(id, visible);
          notifyLifecycle({ kind: 'visibility', id, label: assembly.labelOf(id) ?? id, visible });
          return visible ? text.visibility.shown(id) : text.visibility.hidden(id);
        },
      },
      sessionControl: {
        reloadPrefix: async () => {
          await core.loop.reloadSystemPrefix();
          return text.visibility.prefixReloaded(Math.max(0, core.session.records.length - 1));
        },
      },
      run: {
        pause: () => core.bus.setPaused(true),
        resume: () => core.bus.setPaused(false),
        isPaused: () => core.bus.isPaused(),
        // 关机键。仪式在这里跑完并把逐步结果回给页面,**之后**才退进程——
        // 顺序反了的话操作员只会看到浏览器报"连接断开",不知道世界存没存上。
        shutdown: () => beginShutdown('控制台关机键', { closeWeb: false, exit: true }),
        // 标志先落盘再关机:关机途中被硬杀,启动器照样能读到标志把进程拉起来。
        restart: () => {
          requestRestart(loaded.dataDir);
          return beginShutdown('控制台重启键', { closeWeb: false, exit: true });
        },
        supervised: isSupervised(),
      },
      ...(opts.extensions ? { extensions: new ExtensionManager(loaded.repoRoot ?? loaded.rootDir, opts.extensions) } : {}),
      debug: {
        sessionMessages: () => core.session.records,
        firstTurnMessages: () => core.loop.activeFirstTurn(),
        onSessionAppend: (cb) => core.session.onAppend(cb),
        onSessionReset: (cb) => core.session.onReset(cb),
        onEvent: (cb) => core.store.onAppend(cb),
        onRunlog: (cb) => core.runlog.onWrite(cb),
        recentLog: (limit) => core.runlog.recent(limit),
        runId: () => core.run.id,
        toolSchemas: () => core.loop.getToolSchemas(),
      },
      toolSchemas: {
        list: () => {
          // 归属按声明方算:World 自报的工具名归那个 World,其余都是Persona声明的
          // (core 自己不声明工具,流程类工具同样归Persona)。
          const byWorld = new Map<string, ToolOwner>();
          for (const m of assembly.mounted) {
            const label = assembly.labelOf(m.id);
            const owner: ToolOwner = { kind: 'world', id: m.id, ...(label ? { label } : {}) };
            for (const t of m.tools()) byWorld.set(t.name, owner);
          }
          const extras = (contribution.extraToolSchemas?.() ?? []).map((s) => ({ ...s, tags: [] }));
          const byName = new Map<string, ToolSchema & { owner: ToolOwner }>();
          for (const s of [...core.loop.getToolSchemas(), ...extras]) {
            if (byName.has(s.name)) continue;
            const owner = byWorld.get(s.name) ?? { kind: 'persona' as const };
            byName.set(s.name, {
              name: s.name, description: s.description, parameters: s.parameters, owner,
            });
          }
          return [...byName.values()];
        },
      },
      getStatus: () => ({
        displayName: cfg.displayName,
        startedAt,
        loop: core.loop.getStatus(),
        eventCount: core.store.latestCursor(),
        ...(contribution.status?.() ?? {}),
      }),
      log: core.runlog.logger('console'),
      prompts: derivePrompts(parts, assembly, contribution, cfg.timezone, promptDirs, opts.extensions?.bot !== undefined),
      // 激活/停用/重启全部热生效:槽位表按定义重建实例,core 连带重建前缀。
      worldActivation: {
        set: (id, enabled) => (enabled ? assembly.activate(id) : assembly.deactivate(id)),
        restart: (id) => assembly.restart(id),
      },
    });
  }

  const app = webApp;
  return {
    core,
    parts,
    assembly,
    webApp,
    async start() {
      instanceLock ??= acquireInstanceLock(loaded.dataDir, {
        force: process.argv.includes('--force-second-instance'),
        log: core.runlog.logger('boot'),
      });
      // 先起控制台:core 启动过程的日志与"启动即暂停"状态,一打开就能看到
      const port = app ? await app.start(cfg.web.port) : null;
      // 活跃 provider 是托管端点时先把 server 拉起来(不等就绪——健康轮询在托管器里,
      // 控制台可观察;bot 常以"启动即暂停"起,operator 看到 running 再继续)。
      // 全局端点表里没有模块认领的条目(模块已删、扩展没装):控制台看不见它们,只能在这里出声。
      const orphans = Object.entries(cfg.providers).filter(([, entry]) => !providerModules.some((m) => m.id === entry.kind)).map(([name, entry]) => `${name}(kind=${entry.kind})`);
      if (orphans.length) core.runlog.logger('provider').warn('端点条目没有对应的 Provider 模块,不可用', { orphans });
      void core.providers.start(cfg.activeProvider).catch(error=>core.runlog.logger('provider').error('Provider 启动失败',{error:String(error)}));
      await parts.onStart?.({ core, loaded, port });
      await core.start();
      return { port };
    },
    async stop() {
      await core.stop();
      await stopCore();
      await Promise.all([...llmManagers.values()].map((m) => m.stop()));
      if (app) await app.stop();
      instanceLock?.release();
      instanceLock = null;
    },
    shutdown: (reason?: string) =>
      beginShutdown(reason ?? '外部请求', { closeWeb: true, exit: false }),
  };
}

/**
 * 关机仪式的编排。**与具体 World 无关**:框架不知道谁在托管一个要存档的游戏世界,
 * 存档发生在那个 World 自己的 `stop()` 里(只有它知道要往哪个子进程的 stdin 写什么)。
 * 这里只保证两件事 —— 顺序对,以及**每一步都有钟**。
 *
 * 顺序的理由,逐条:
 *
 *  1. 先按住总线。收尾途中还在投递唤醒的话,她可能正好下一条指令又去挖方块,
 *     而世界马上就要存盘了。事件照常落库,只是不再叫醒。
 *  2. World 停。托管的外部进程(MC 服务端、观察者客户端)都挂在这一步下面,
 *     存档也在这里发生 —— 所以它拿的预算最大。
 *  3. 托管 LLM server 停。它没有要落盘的东西,纯粹是别留孤儿进程。
 *  4. 落盘。日志(runlog / usage / toolcalls / events / session)全是
 *     `appendFileSync`,写完就在盘上,没有缓冲要冲 —— 真正只存在于内存里的是
 *     core 状态袋,这一步就是把它写下去。
 *  5. 控制台最后关。前面每一步的结果都还要经它报给正在看页面的人。
 *
 * 任何一步超时都只记一笔往下走:关机卡在中途,比少走一步糟得多。
 */
async function runShutdown<C extends CoreConfig>(ctx: {
  reason: string;
  core: Core<C>;
  /** 开始关机那一刻的挂载表快照 */
  worlds: readonly World[];
  stopCore: () => Promise<void>;
  llmManagers: Map<string, {stop():Promise<unknown>}>;
  webApp: WebApp | null;
  log: Logger;
  /** 步骤名与总结行回给控制台,按控制台语言;日志行不跟。 */
  language: Language;
}): Promise<ShutdownReport> {
  const t = pick(ctx.language, BOT_TEXT).shutdown;
  const steps: ShutdownStep[] = [];
  let externalChecks: ShutdownExternalCheck[] = [];
  let modulesSettled = false;
  let moduleFailures: WorldStopFailure[] = [];
  const run = async (
    key: string,
    label: string,
    budgetMs: number,
    work: () => Promise<unknown> | unknown,
  ): Promise<void> => {
    const t0 = Date.now();
    try {
      await withDeadline(Promise.resolve().then(work), budgetMs, label);
      steps.push({ key, label, ok: true, elapsedMs: Date.now() - t0 });
      ctx.log.info(`关机 ✓ ${label}`, { elapsedMs: Date.now() - t0 });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      steps.push({ key, label, ok: false, elapsedMs: Date.now() - t0, detail });
      ctx.log.warn(`关机 ✗ ${label}(跳过,继续下一步)`, { detail });
    }
  };

  ctx.log.warn(`开始关机(${ctx.reason})`);
  await run('pause', t.pause, SHUTDOWN_BUDGET_MS.pause, () => {
    ctx.core.bus.setPaused(true);
  });
  await run('worlds', t.worlds, SHUTDOWN_BUDGET_MS.worlds, async () => {
    moduleFailures = await ctx.core.stop();
    modulesSettled = true;
    if (moduleFailures.length > 0) {
      throw new Error(moduleFailures.map((failure) => `${failure.worldId}:${failure.detail}`).join('；'));
    }
  });
  await run('core', t.core, SHUTDOWN_BUDGET_MS.core, ctx.stopCore);
  externalChecks = ctx.worlds.flatMap((module) => {
    if (!module.shutdownVerification) return [];
    const stopFailure = !modulesSettled
      ? t.modulesTimedOut
      : moduleFailures.find((failure) => failure.worldId === module.id)?.detail;
    if (stopFailure) {
      return [{
        key: `${module.id}.shutdown-verification`,
        label: t.externalState(module.id),
        status: 'unknown' as const,
        detail: t.stopIncomplete(stopFailure),
        manualAction: t.manualCheck,
      }];
    }
    try {
      return module.shutdownVerification().map((check) => ({ ...check }));
    } catch (error) {
      return [{
        key: `${module.id}.shutdown-verification`,
        label: t.externalState(module.id),
        status: 'unknown' as const,
        detail: t.cacheReadFailed(error instanceof Error ? error.message : String(error)),
        manualAction: t.manualCheck,
      }];
    }
  });
  await run('llm', t.llm, SHUTDOWN_BUDGET_MS.llm, () =>
    Promise.all([...ctx.llmManagers.values()].map((m) => m.stop())));
  await run('flush', t.flush, SHUTDOWN_BUDGET_MS.flush, () => {
    // 日志与 session 是 appendFileSync,写的时候就在盘上;这里只补内存里那一份。
    ctx.core.state.save();
  });
  const app = ctx.webApp;
  if (app) await run('web', t.web, SHUTDOWN_BUDGET_MS.web, () => app.stop());

  const localComplete = steps.every((s) => s.ok);
  const externalComplete = externalChecks.every((check) => check.status === 'verified-ended');
  const complete = localComplete && externalComplete;
  for (const check of externalChecks) {
    if (check.status === 'verified-ended') continue;
    ctx.log.error(`[P0] 外部状态未确认结束:${check.label}`, {
      status: check.status,
      detail: check.detail,
      manualAction: check.manualAction,
    });
  }
  // 总结行使用 complete，涵盖本地步骤与外部状态确认。
  const unverified = externalChecks.filter((check) => check.status !== 'verified-ended');
  const summary = !localComplete
    ? t.summarySkipped
    : complete
      ? t.summaryComplete
      : t.summaryUnverified(unverified.map((check) => `${check.label}=${check.status}`));
  ctx.log.emit('warn', summary, {
    event: 'shutdown-summary',
    data: {
      steps: steps.map((s) => `${s.label}=${s.ok ? 'ok' : s.detail}`),
      externalChecks: externalChecks.map((check) => `${check.label}=${check.status}`),
    },
  });
  closeRun(ctx.core.run, {
    endedAt: nowIso(ctx.core.config.timezone),
    lastCursor: ctx.core.store.latestCursor(),
    complete,
    reason: ctx.reason,
  });
  return { reason: ctx.reason, localComplete, complete, steps, externalChecks };
}

/** 把一组配置项写回这个 bot 的 config.json(其余段原样保留) */
function persistConfig<C extends CoreConfig>(loaded: LoadedConfig<C>, values: ConfigValues): string {
  const cfgPath = join(loaded.rootDir, 'config.json');
  updateJsonObject(cfgPath, (raw) => {
    for (const [path, v] of Object.entries(values)) setConfigPath(raw, path, v);
  });
  return 'config.json';
}
