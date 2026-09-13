/**
 * Minecraft 引擎子进程的 IPC 协议。
 *
 * mineflayer 的 20Hz physicsTick、寻路 A*、执行器循环、world tick 均在引擎
 * 子进程中运行。主进程只承载轻量的 World 与跨进程转发。
 *
 * 跨界流量:
 * - 主 → 子:工具调用与面板调用(req/rep)、x-hot 配置快照与客户端窗口线索(cast);
 * - 子 → 主:事件(hreq,拿真实信封)、日志/用量/自省信号(note)、状态徽标与
 *   心跳行的推送缓存(note)。
 */
import type { LogNote } from '../../core/ipc-logger.ts';
import type {
  CognitionRequest, CognitionResult, EventEnvelope, EventTag, LLMUsage, WorldConsoleDecl,
  PushOptions, TriggerMode,
} from '../../core/types.ts';
import type { MinecraftConfigSection } from './config.ts';

/** 子进程里构造真 World 的一次性载荷 */
export interface EngineInit {
  timezone: string;
  botName: string;
  /** 账本目录 data/;null = 只在内存 */
  dataDir: string | null;
  cfg: MinecraftConfigSection;
}

/** 主 → 子:要回执的请求 */
export type EngineRequest =
  | { kind: 'init'; init: EngineInit }
  /**
   * `round` 是主进程侧认出来的**轮序号**(见 round.ts):ctx 里那个按轮新建的闭包
   * 过不了进程边界,所以在 proxy 那头认好再把号带过来。认不出来 = null。
   */
  | {
      kind: 'tool'; name: string; args: Record<string, unknown>; role: string;
      callId: string | null; round: number | null;
    }
  | { kind: 'panel'; panel: string; method: string; args: unknown[] }
  | { kind: 'storage-clear'; key: string }
  /**
   * 投递成文渲染:发车刻主进程回来现拿正文。
   * 子进程查 arm-deferred 时登记的渲染回调;null=蒸发。
   */
  | { kind: 'render-deferred'; type: string }
  | { kind: 'shutdown' };

/** 主 → 子:单向投递 */
export type EngineCast =
  /** x-hot 配置快照(整段替换值,不换对象身份) */
  | { kind: 'config'; cfg: MinecraftConfigSection }
  /**
   * 主进程侧那几个**可选**宿主能力此刻在不在。
   *
   * `host.cognition` 是 core 上的 getter,Persona的全局开关一关它就没了;
   * 而子进程的 World 要能用 `if (host.cognition)` 判断"这台机器上有没有这个档"
   * (契约就是这么写的)。所以这一位随配置同一条采样线推过来,子进程据此让
   * 自己那个句柄**真的消失**,而不是留一个调用起来必然报错的假句柄。
   */
  | { kind: 'caps'; cognition: boolean };

/** StoragePart 的可序列化描述(stat 现值随状态推送,clear 走请求) */
export interface StorageStat {
  key: string;
  label: string;
  kind: 'disk' | 'memory';
  group?: string;
  location?: string;
  danger?: boolean;
  note?: string;
  order?: number;
  stat: string;
}

/** 子 → 主:单向通知 */
export type EngineNote =
  | LogNote
  | { kind: 'usage'; usage: LLMUsage; opts?: Parameters<import('../../core/types.ts').WorldHost['reportUsage']>[1] }
  /**
   * 挂一条投递成文项(渲染回调过不了界:回调本体留在子进程登记表里,
   * 主进程代挂,发车刻经 render-deferred 请求回来现拿正文)。
   */
  | {
      kind: 'arm-deferred';
      type: string;
      senderKey?: string;
      meta?: Record<string, unknown>;
      tags?: readonly EventTag[];
      trigger?: TriggerMode;
    }
  | {
      kind: 'status';
      decl: Pick<WorldConsoleDecl, 'lamps' | 'badges' | 'links'>;
      storage: StorageStat[];
    };

/**
 * 子 → 主:宿主调用(有回执;拿真实结果)。
 * drain 的 filter 函数过不了界:跨进程宿主只支持"取本 World 来源的事件"这一种。
 */
export type HostRequest =
  | {
      kind: 'push';
      evt: Omit<EventEnvelope, 'cursor' | 'origin'> & { origin?: EventEnvelope['origin'] };
      opts?: PushOptions;
    }
  | { kind: 'drain' }
  /**
   * 认知外包一次请求(蓝图构思)。**工具白名单校验在主进程做**——那边的
   * `host.cognition` 是 core 包过的句柄,`req.tools` 会照本 World `tools()` 的
   * 真实工具名逐个核对(代理与真 World 共用 MINECRAFT_TOOL_DECLS,两侧逐字节一致)。
   * 主进程侧句柄不在时回一句带 `COGNITION_ABSENT` 前缀的 error:World 据此说清是能力不在。
   */
  | { kind: 'cognition'; req: CognitionRequest };

/** 认知外包 RPC 的回值(与 host.cognition.request 同一张脸) */
export type CognitionReply = CognitionResult;

export type MainToChild =
  | { t: 'req'; id: number; req: EngineRequest }
  | { t: 'hrep'; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'cast'; cast: EngineCast };

export type ChildToMain =
  | { t: 'rep'; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'hreq'; id: number; req: HostRequest }
  | { t: 'note'; note: EngineNote };
