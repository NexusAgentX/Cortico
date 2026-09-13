/**
 * Core 默认配置与深合并工具。
 * 本文件仅声明 core 参数和无归属的部署事实。Persona与 World 各自声明参数，
 * 四层合并由 `src/deploy.ts` 执行；core 不依赖具体Persona或 World。
 */
import type { CoreConfig } from './types.ts';
import type { PriceDefinition } from '../providers/pricebook.ts';
import type { ConfigGroup } from './config-schema.ts';
import { pick, type Language } from './language.ts';

/** core 配置组的文案。中文是原文;英文与之同义。 */
const CORE_GROUP_TEXT = {
  zh: {
    title: '合批、LLM 层与日志',
    description: 'core 自己的机械设施:什么时候投递攒好的事件,发给 LLM 前怎么处理历史思维链,以及运行日志落盘与打印的门槛。',
    quietGap: {
      title: '安静窗口',
      description: '最后一条消息之后安静这么久才投递;调大＝等对方把话说完再叫醒。⚠仅影响走合批的 World——控制台消息即时投递(urgent)。',
    },
    minBatchAge: {
      title: '最短攒批',
      description: '第一条消息到了之后至少攒这么久。防止细水长流的事件源每来一条就叫醒一次(那种间隔往往大于安静窗口,光靠安静窗口拦不住)。',
    },
    maxBatchAge: {
      title: '最长扣留',
      description: '消息流不断时也最多攒这么久就强制投递。',
    },
    maxBatchSize: {
      title: '单批上限',
      suffix: '条',
      description: '积压到这么多条就立刻投递,不再等钟。',
    },
    keepPastThinking: {
      title: '保留历史思维链',
      description: '开＝把上一轮的推理带进下一轮(她接着上次想,不从零开始);关＝每轮丢弃,省输入 token。落盘 session 不受影响。',
    },
    firstTurn: {
      title: '合成首轮对话(风格锚)',
      description: '发给 LLM 时在系统前缀之后注入一轮预写的对话来回,锚定语言风格。默认关。内容是这份部署自己的(prompts/FIRST_TURN_*.md,不随代码包发布),在「设置 → 首轮对话」编辑;内容为空时开着也不注入。只进请求,不落盘。',
    },
    logFile: {
      title: '日志落盘门槛',
      description: '低于这一级的记录不写 data/runs/<run>/log.jsonl。trace 是高频状态机(注视/姿态过渡、每拍),排查演出节奏时才开。',
    },
    logConsole: {
      title: '日志打印门槛',
      description: '低于这一级的记录不打到控制台窗口。',
    },
    logAreas: {
      title: '按区域覆盖落盘门槛',
      description: '`区域=级别` 逗号分隔,区域可带 `.*`:如 `worlds.vtuber.state=trace,worlds.minecraft.*=info`。最长前缀命中优先;留空=全按上面的门槛。',
    },
  },
  en: {
    title: 'Batching, LLM layer and logging',
    description: 'The core\'s own machinery: when accumulated events are delivered, how past reasoning is handled before a call, and the thresholds for writing and printing the run log.',
    quietGap: {
      title: 'Quiet window',
      description: 'Deliver only after this much silence since the last message; raise it to let the other side finish before waking. ⚠ Affects batched worlds only: console messages are delivered immediately (urgent).',
    },
    minBatchAge: {
      title: 'Minimum batch age',
      description: 'Accumulate at least this long after the first message. Stops a slow trickle of events from waking once per event (such gaps are often longer than the quiet window, which alone cannot hold them).',
    },
    maxBatchAge: {
      title: 'Maximum hold',
      description: 'Even with a continuous stream, force delivery after this long.',
    },
    maxBatchSize: {
      title: 'Batch size limit',
      suffix: 'items',
      description: 'Deliver immediately once this many items are queued, without waiting for the clock.',
    },
    keepPastThinking: {
      title: 'Keep past reasoning',
      description: 'On = carry the previous turn\'s reasoning into the next one (she continues where she left off); off = drop it every turn to save input tokens. The persisted session is unaffected.',
    },
    firstTurn: {
      title: 'Synthetic first turn (style anchor)',
      description: 'Inject a pre-written exchange right after the system prefix on every call to anchor the language style. Off by default. The content belongs to this deployment (prompts/FIRST_TURN_*.md, not shipped with the code package) and is edited under Settings → First turn; when empty, nothing is injected even if enabled. Request-only, never persisted.',
    },
    logFile: {
      title: 'Log file threshold',
      description: 'Records below this level are not written to data/runs/<run>/log.jsonl. trace is the high-frequency state machine (gaze and posture transitions, every beat); enable it only when debugging performance pacing.',
    },
    logConsole: {
      title: 'Log print threshold',
      description: 'Records below this level are not printed to the console window.',
    },
    logAreas: {
      title: 'Per-area file threshold overrides',
      description: 'Comma-separated `area=level`; an area may end in `.*`, e.g. `worlds.vtuber.state=trace,worlds.minecraft.*=info`. The longest matching prefix wins; leave empty to use the thresholds above everywhere.',
    },
  },
};

/**
 * core 自己那组可调项的声明;控制台按 JSON Schema 通用渲染。
 * 只声明**它拥有的**参数——Persona与各 World 各自声明自己的那组。
 * 文案按控制台语言给;结构与取值范围两种语言完全一致。
 */
export function coreConfigGroup(language: Language): ConfigGroup {
  const t = pick(language, CORE_GROUP_TEXT);
  return {
    id: 'core',
    owner: 'core',
    schema: {
      type: 'object',
      title: t.title,
      description: t.description,
      properties: {
        'batching.quietGapMs': {
          type: 'integer',
          title: t.quietGap.title,
          minimum: 100,
          maximum: 600_000,
          multipleOf: 100,
          'x-scale': 1000,
          'x-suffix': 's',
          'x-hot': true,
          description: t.quietGap.description,
        },
        'batching.minBatchAgeMs': {
          type: 'integer',
          title: t.minBatchAge.title,
          minimum: 0,
          maximum: 600_000,
          multipleOf: 100,
          'x-scale': 1000,
          'x-suffix': 's',
          'x-hot': true,
          description: t.minBatchAge.description,
        },
        'batching.maxBatchAgeMs': {
          type: 'integer',
          title: t.maxBatchAge.title,
          minimum: 1000,
          maximum: 3_600_000,
          multipleOf: 500,
          'x-scale': 1000,
          'x-suffix': 's',
          'x-hot': true,
          description: t.maxBatchAge.description,
        },
        'batching.maxBatchSize': {
          type: 'integer',
          title: t.maxBatchSize.title,
          minimum: 1,
          maximum: 1000,
          'x-suffix': t.maxBatchSize.suffix,
          'x-hot': true,
          description: t.maxBatchSize.description,
        },
        'context.keepPastThinking': {
          type: 'boolean',
          title: t.keepPastThinking.title,
          'x-hot': true,
          description: t.keepPastThinking.description,
        },
        'context.firstTurn': {
          type: 'boolean',
          title: t.firstTurn.title,
          'x-hot': true,
          description: t.firstTurn.description,
        },
        'logging.file': {
          type: 'string',
          title: t.logFile.title,
          enum: ['trace', 'debug', 'info', 'warn', 'error'],
          'x-hot': true,
          description: t.logFile.description,
        },
        'logging.console': {
          type: 'string',
          title: t.logConsole.title,
          enum: ['trace', 'debug', 'info', 'warn', 'error'],
          'x-hot': true,
          description: t.logConsole.description,
        },
        'logging.areas': {
          type: 'string',
          title: t.logAreas.title,
          'x-hot': true,
          description: t.logAreas.description,
        },
      },
    },
  };
}

/** 中文版常量:开发态脚本与测试直接引用。运行时由 `createBot` 按部署语言构建。 */
export const CORE_CONFIG_GROUP: ConfigGroup = coreConfigGroup('zh');

/** core 拥有的机械参数 + 部署事实 + 控制台观测参数。 */
export const CORE_DEFAULTS = {
  /** bot 的展示名(控制台标题、终端出方消息的 from)。框架不预设身份。 */
  displayName: 'bot',
  timezone: 'Asia/Shanghai',
  /**
   * LLM 供应端点表(部署事实):框架只默认给 DeepSeek 云端这一条(OpenAI Responses Compatible
   * 模块的 deepseek 预设),全局端点表不在时它是种子。
   *
   * 订阅额度那一类端点(OAuth 授权、自带授权面板)由外部 provider 包提供:装上之后
   * 它的端点条目写在 `<部署根>/providers/<端点名>/config.json` 里,框架这张表不认领。
   */
  providers: {
    deepseek: {
      kind: 'openai-responses-compat' as const,
      baseUrl: 'https://api.deepseek.com',
      secret: 'DEEPSEEK_API_KEY',
      // 用哪个模型也是部署事实(与 baseUrl 同一类),整组归 provider——Persona
      // 拿不到也不问。只有这一条带默认值:开箱能跑的那个端点得有个模型名。
      spec: { model: 'deepseek-flash', thinking: false },
      // 报价默认 0(明确免费):真实单价由操作者在控制台填。
      pricing: [{
        models: ['*'], currency: 'USD', basis: 'marginal', source: 'console',
        rules: [{ meter: 'cachedInput', perMillion: 0 }, { meter: 'uncachedInput', perMillion: 0 }, { meter: 'output', perMillion: 0 }],
      }] as PriceDefinition[],
    },
  },
  activeProvider: 'deepseek',
  web: { port: 7777 },
  paths: { memory: 'memory', data: 'data' },
  /** 合批设施;Persona可经调参工具改 */
  batching: { quietGapMs: 2500, minBatchAgeMs: 0, maxBatchAgeMs: 15000, maxBatchSize: 100 },
  /** 发给 LLM 前的机械处理,属 LLM 层 */
  context: { keepPastThinking: true, firstTurn: false },
  /** 运行日志门槛;trace 默认不落盘 */
  logging: { file: 'debug' as const, console: 'info' as const, areas: '' },
} as const;


export function cloneConfigValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneConfigValue(item)) as T;
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = cloneConfigValue(item);
    return out as T;
  }
  return value;
}

/** 后一层覆盖前一层的深合并(数组整体替换);四层合并靠它逐层套用 */
export function deepMerge<T>(base: T, patch: Partial<T> | undefined): T {
  if (patch === undefined) return cloneConfigValue(base);
  if (Array.isArray(base) || Array.isArray(patch)) {
    return cloneConfigValue((patch as T) ?? base);
  }
  if (typeof base === 'object' && base !== null && typeof patch === 'object' && patch !== null) {
    const out = cloneConfigValue(base) as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      const bv = (base as Record<string, unknown>)[k];
      out[k] = bv !== undefined && typeof bv === 'object' && bv !== null && !Array.isArray(bv)
        ? deepMerge(bv, v as never)
        : cloneConfigValue(v);
    }
    return out as T;
  }
  return cloneConfigValue((patch as T) ?? base);
}

/**
 * 装配好的一次部署。`config` 是热改即时生效的活对象——四层合并后
 * 所有人运行时共享同一个引用。
 */
export interface LoadedConfig<C extends CoreConfig = CoreConfig> {
  /**
   * 活配置。类型参数让部署层把自己那份完整配置(core 段 + Persona段 +
   * 各 World 段)传入,而 core 只依赖 CoreConfig 部分。
   */
  config: C;
  /**
   * 按名字取密钥。core 不认识 `BRAVE_API_KEY` 这种名字:哪个 World 需要
   * 哪个变量,由 World 自己声明,装配层照名字取给它。
   */
  secret(name: string): string;
  /** 这份**部署**的目录(config.json / .env / data/ 所在) */
  rootDir: string;
  /**
   * 这份部署引用的 **bot 代码包**目录。提示词模板、演出包这些"层 2 归包"的东西按它找。
   * 同一个包可以背好几份部署,所以它与 `rootDir` 是两回事。
   * 缺省(测试替身、assemble 入口)时按 `rootDir` 算:那种场合包与部署本来就是同一个目录。
   */
  packageDir?: string;
  /**
   * 全局 LLM 端点表的根(`<部署根>/providers/`)。每个端点在它下面有自己一格,
   * 目录内部结构归 provider 模块解释。跨部署共享,所以它不在 `rootDir` 底下。
   * 缺省(手搭 LoadedConfig 的测试替身)按 `<rootDir>/providers` 算。
   */
  providersDir?: string;
  repoRoot?: string;
  /** 解析后的绝对路径 */
  memoryDir: string;
  dataDir: string;
}
