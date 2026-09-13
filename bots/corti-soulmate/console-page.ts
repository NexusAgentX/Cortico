/**
 * corti-soulmate 的 bot 级控制台页 —— **部署绑定**的三块:存档点、
 * 统一重置、强制入梦(= 强制一次交接,梦随之在后台跑)。
 *
 * 与 `Persona.console?()`(`bots/corti-soulmate/persona/consoleSurface.ts`)的分工:
 *
 * - Persona出**认知绑定**的:工作区 / Memory 分层 / 版本历史。换一份Persona,
 *   那三块就该跟着换。
 * - 这里出**部署绑定**的:它们要跨 owner 编排
 *   (统一重置 = persona 回滚 + 清框架存储)、或者本来就是一次运维动作(存档点、
 *   强制入梦)。同一个Persona换台机器部署,这三块可以完全不一样。
 *
 * **为什么不在 `console/` 目录里**:那个目录按约定是浏览器端的(构建脚本按目录名
 * 收入口,tsconfig.web.json 拿 DOM lib 单独 check)。这份是 Node 侧的,放进去会被
 * 拿 DOM 的那份配置检查到,而它 import 的是服务端类型。与 cormini 同一个摆法。
 */
import type { StoragePart } from 'cortico/core/types.ts';
import type {
  ConsoleCheckpointEntry, ConsoleMediumStatus,
  WebAppCheckpointDeps,
} from 'cortico/web/server.ts';
import {
  pageIdFor,
  type ConsolePanelDecl,
  type ConsolePageContribution,
} from 'cortico/web/shared/console-protocol.ts';

// ---------------------------------------------------------------------------
// 面板声明
// ---------------------------------------------------------------------------

/**
 * 部署面这一页的名字(冒号后那截),与 bot id 相同——于是它和Persona自报的
 * 那半**共用** `persona:corti-soulmate` 这一个 id。
 *
 * 这不是冲突,是有意的:`src/bot.ts` 的 `mergePersonaContributions` 会把同 id 的
 * 两半合成一页(面板拼接,`invoke` 按 panel 归属分派)。合并之后,
 * "认知绑定 vs 部署绑定"那条线**只决定代码写在哪个文件**,不再是用户看得见的
 * 边界——同一页、同一个 bundle。asset key 也因此只有一个,
 * 与构建脚本按目录出的那份产物对得上。
 */
export const CORTI_OPS_PAGE_NAME = 'corti';

/**
 * 统一重置与强制入梦的 bot 侧接口；人格领域类型由提供方持有。
 */
export interface CortiResetDeps {
  /** `parts` 是框架提供的权威存储清单;实现决定清除范围与执行顺序。 */
  run(checkpoint: string, parts: StoragePart[]): Promise<{
    ok: boolean;
    persona: string;
    results: Array<{ key: string; ok: boolean; result: string }>;
  }>;
}

/** 手动强制"入梦→截断→唤醒"(人工操作)。 */
export interface CortiDreamDeps {
  /** 已在入梦或截断中则不重复触发,返回 ok:false 说明原因。 */
  trigger(): { ok: boolean; message: string };
}

export const CORTI_OPS_PANELS: ConsolePanelDecl[] = [
  {
    id: 'checkpoints',
    title: '存档点',
    description: 'persona/ 的 git tag。新建会先把当前改动提交进去;checkpoint0 是出厂基线。',
  },
  {
    id: 'reset',
    title: '统一重置',
    description: '回滚 persona 到某个存档点,并按序清空全部 core 存储。不可撤销的运维动作。',
  },
  {
    id: 'dream',
    title: '强制入梦',
    description: '手动触发一次交接,交接完成后梦在后台整理工作区。已在进行中不会重复触发。',
  },
];

// ---------------------------------------------------------------------------
// 返回形状(浏览器那一半 import 不到本文件,两边靠这些注释对齐)
// ---------------------------------------------------------------------------

export interface OpsApplied<S> {
  ok: true;
  result: string;
  state: S;
}

export interface OpsCheckpointsState {
  status: ConsoleMediumStatus;
  checkpoints: ConsoleCheckpointEntry[];
}

/** 重置面板要展示"到底会清掉哪些东西",所以把清单的可显示部分一起回。 */
export interface OpsStoragePart {
  key: string;
  label: string;
  kind: 'disk' | 'memory';
  location?: string;
  danger?: boolean;
  note?: string;
}

export interface OpsResetState {
  status: ConsoleMediumStatus;
  checkpoints: ConsoleCheckpointEntry[];
  parts: OpsStoragePart[];
  /** 清单齐不齐。不齐就不许按下去——半次重置比不重置危险得多。 */
  ready: boolean;
  /** `ready:false` 时的原因,原样显示 */
  reason: string | null;
}

export interface OpsResetResult {
  ok: boolean;
  persona: string;
  results: Array<{ key: string; ok: boolean; result: string }>;
}

export interface OpsDreamState {
  dreaming: boolean;
}

// ---------------------------------------------------------------------------
// 重置的存储清单闸门
// ---------------------------------------------------------------------------

/**
 * 统一重置要清的是**全部** core 存储(事件库、session、状态、定时器、用量…)。
 * 框架经 `ConsolePageBuildContext.storage` 把权威清单交给 bot(与 `/api/storage`
 * 是同一批对象),所以正常情况下清单是齐的。
 *
 * 但这道闸留着:清单里认不出 core 那几条关键项就**不许执行**。
 * 半次重置(persona 回到出厂态、session 还活在回滚前的世界)比不重置危险得多——
 * 接线哪天断了,宁可拒绝执行,也不要清一半。
 *
 * 闸门用"有没有这两个键"判断,而不是数条数:数条数会随任何一个 World 增删而误判。
 */
const REQUIRED_PART_KEYS = ['session', 'events'];

function readiness(parts: StoragePart[]): { ready: boolean; reason: string | null } {
  const missing = REQUIRED_PART_KEYS.filter((k) => !parts.some((p) => p.key === k));
  if (missing.length === 0) return { ready: true, reason: null };
  return {
    ready: false,
    reason:
      `拿不到完整的存储清单(缺 ${missing.join(' / ')})。框架在装配期把清单拼给了 WebApp,`
      + '但没有接缝把它交回 bot,所以这里不敢执行半次重置——'
      + '暂时请走旧的「控制台 › 存档点 › 回滚到此」。',
  };
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

export interface CortiOpsDeps {
  /** 这一页的名字(冒号后那截)。asset key 与它同源,所以由装配层一处说了算。 */
  name: string;
  label: string;
  checkpoints: WebAppCheckpointDeps;
  /** 介质状态(HEAD / 脏 / 存档点),存档点与重置两个面板都要显示 */
  status(): ConsoleMediumStatus;
  reset: CortiResetDeps;
  /**
   * 重置要清的存储清单。**bot 自己闭包持有**——`CortiResetDeps.run` 那个
   * `parts` 参数在改走控制台页之后就不该由框架回传了。
   */
  storage(): StoragePart[];
  dream: CortiDreamDeps;
  dreamState(): OpsDreamState;
}

async function runReset(deps: CortiOpsDeps, args: unknown[]): Promise<OpsResetResult> {
  const checkpoint = typeof args[0] === 'string' ? args[0].trim() : '';
  if (!checkpoint) throw new Error('缺少 checkpoint 名');
  const parts = deps.storage();
  const gate = readiness(parts);
  if (!gate.ready) throw new Error(gate.reason ?? '存储清单不完整');
  return deps.reset.run(checkpoint, parts);
}

/**
 * 一个 `persona:<name>` 贡献。**面板与浏览器扩展同进同退**:这里声明的三个局部 id
 * 就是 `bots/corti-soulmate/console/client.ts` 里 `panels` 的三个键,
 * `tests/web/persona-corti-console.test.ts` 拿两份清单对咬。
 */
export function cortiConsolePages(deps: CortiOpsDeps): ConsolePageContribution[] {
  return [{
    id: pageIdFor('persona', deps.name),
    kind: 'persona',
    label: deps.label,
    panels: CORTI_OPS_PANELS,
    invoke: async (panel: string, method: string, args: unknown[]): Promise<unknown> => {
      if (panel === 'checkpoints') {
        const state = (): OpsCheckpointsState => ({
          status: deps.status(),
          checkpoints: deps.checkpoints.list(),
        });
        switch (method) {
          case 'state':
            return state();
          case 'create': {
            const name = typeof args[0] === 'string' ? args[0].trim() : '';
            if (!name) throw new Error('缺少 checkpoint 名');
            const note = typeof args[1] === 'string' ? args[1] : '';
            return { ok: true, result: deps.checkpoints.create(name, note), state: state() };
          }
          case 'remove': {
            const name = typeof args[0] === 'string' ? args[0].trim() : '';
            if (!name) throw new Error('缺少 checkpoint 名');
            return { ok: true, result: deps.checkpoints.remove(name), state: state() };
          }
          // 存档点列表上的「回滚到此」与「统一重置」面板是同一次事务,
          // 走同一个 `runReset`——两个入口、一份实现。
          case 'rollback':
            return runReset(deps, args);
          default:
            throw new Error(`未知面板方法: ${panel}.${method}`);
        }
      }
      if (panel === 'reset') {
        if (method === 'state') {
          const parts = deps.storage();
          const gate = readiness(parts);
          const out: OpsResetState = {
            status: deps.status(),
            checkpoints: deps.checkpoints.list(),
            parts: parts.map((p) => ({
              key: p.key,
              label: p.label,
              kind: p.kind,
              ...(p.location ? { location: p.location } : {}),
              ...(p.danger ? { danger: true } : {}),
              ...(p.note ? { note: p.note } : {}),
            })),
            ready: gate.ready,
            reason: gate.reason,
          };
          return out;
        }
        if (method === 'run') return runReset(deps, args);
        throw new Error(`未知面板方法: ${panel}.${method}`);
      }
      if (panel === 'dream') {
        if (method === 'state') return deps.dreamState();
        if (method === 'trigger') {
          const out = deps.dream.trigger();
          return { ...out, state: deps.dreamState() };
        }
        throw new Error(`未知面板方法: ${panel}.${method}`);
      }
      throw new Error(`未知面板: ${panel}`);
    },
  }];
}
