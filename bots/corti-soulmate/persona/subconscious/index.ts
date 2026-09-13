import { message, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { hasRole, withoutPastReasoning } from 'cortico/protocol/open-responses/context-helpers.ts';
/**
 * 梦:交接之后从交接前的快照 fork 出同一个她,整理工作区。
 *
 * 策略归Persona;core 只提供 fork 原语。交接立即返回(对话不断流),梦在后台跑,
 * 单实例排队;surface 的文本经 onEmergence 回到主意识(MEMORY 3 + 一条注入)。
 */
import type { ForkOptions, CoreApi, Logger, ToolDef } from 'cortico/core/types.ts';
import type { BotConfig } from '../../index.ts';
import { estimateMessagesTokens, nowIso } from 'cortico/core/util.ts';
import { GenerationError } from 'cortico/core/generation.ts';
import { closeDanglingCalls, rebuildTail } from 'cortico/core/truncate.ts';
import { dreamOrientation, dreamTask } from './prompts.ts';

const errorLogData = (error: unknown): { err: string; body?: string } => ({
  err: String(error),
  ...(error instanceof GenerationError ? { body: error.body.slice(0, 500) } : {}),
});

export const DREAM = 'dream';

/** 固定预留给任务说明、工具结果和输出的 token */
const DREAM_RESERVE_TOKENS = 8_000;

export interface DreamDeps {
  cfg: BotConfig;
  core: CoreApi;
  /** 梦的工具面(文件工具 + 只读 World 工具);surface 由本类每次现造 */
  dreamTools: () => ToolDef[];
  /** 梦那一面的 "Using your tools" 说明(引导里要带) */
  toolUsageText: () => string;
  log: Logger;
  onEmergence: (text: string) => void;
}

export interface DreamStatus {
  dreaming: boolean;
}

export class Dream {
  private readonly d: DreamDeps;
  private dreaming = false;
  /** 单实例排队链:上一场梦没醒,下一场快照排队等 */
  private chain: Promise<void> = Promise.resolve();

  constructor(deps: DreamDeps) {
    this.d = deps;
  }

  getStatus(): DreamStatus {
    return { dreaming: this.dreaming };
  }

  /** 控制台工具编辑器用的梦侧工具 schema。 */
  getBaseToolSchemas(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    const defs = [...this.d.dreamTools(), this.makeSurfaceTool({ text: null })];
    const seen = new Set<string>();
    return defs
      .filter((tool) => (seen.has(tool.name) ? false : (seen.add(tool.name), true)))
      .map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  /** 强制入梦仍通过上下文交接事务,不创建独立生命周期。 */
  forceDreamAndTruncate(): boolean {
    if (this.dreaming) return false;
    return this.d.core.requestContextHandoff();
  }

  /** 排一场梦。快照不可变,晚点整理不丢东西;单实例防止并发写工作区。 */
  schedule(snapshot: ContextRecord[]): Promise<void> {
    const run = (): Promise<void> => this.run(snapshot);
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  /** surface 是每场梦私有的一次性工具,不属于 session 的基础工具集。 */
  private makeSurfaceTool(surfaced: { text: string | null }): ToolDef {
    return {
      name: 'surface',
      description:
        'Hand a short sleep summary back to the waking thread. One call only; if nothing is worth returning, do not call this.',
      tags: ['flow'],
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The summary: a few sentences, first person, conclusion only.' },
        },
        required: ['text'],
      },
      handler: async (args) => {
        const text = String(args.text ?? '').trim();
        if (!text) return '[bad input] text is empty';
        if (surfaced.text !== null) return '[already surfaced once; ending]';
        surfaced.text = text;
        return '[sleep summary captured; it reaches the waking thread when this fork ends]';
      },
    };
  }

  private async run(snapshot: ContextRecord[]): Promise<void> {
    const { cfg, log } = this.d;
    this.dreaming = true;
    const started = Date.now();
    log.info('梦开始', { sessionMessages: snapshot.length });
    try {
      // 引导追加在原快照后,以复用主 session 的 system 前缀缓存。
      const guide: ContextRecord = message('user', [
        dreamOrientation(),
        '━━━ Using your tools ━━━',
        this.d.toolUsageText(),
        dreamTask({ nowText: nowIso(cfg.timezone) }),
      ].join('\n\n'));

      const closed = closeDanglingCalls([...snapshot]);
      let head = 0;
      while (head < closed.length && hasRole(closed[head], 'system')) head++;
      const systemMsgs = closed.slice(0, head);
      const dynamic = closed.slice(head);
      const view = cfg.context.keepPastThinking ? dynamic : withoutPastReasoning(dynamic);
      const fixedTokens = estimateMessagesTokens([...systemMsgs, guide]);
      const dynamicBudget = Math.max(0, cfg.context.maxTokens - fixedTokens - DREAM_RESERVE_TOKENS);
      let inherited: ContextRecord[] = dynamic;
      if (estimateMessagesTokens(view) > dynamicBudget) {
        inherited = rebuildTail(view, dynamicBudget);
        // 单条消息仍超预算时放弃动态尾,保证 fork 不超过上下文上限。
        if (estimateMessagesTokens(inherited) > dynamicBudget) inherited = [];
      }

      const surfaced = { text: null as string | null };
      const summary = await this.spawn({
        id: DREAM,
        messages: [...systemMsgs, ...inherited, guide],
        tools: [...this.d.dreamTools(), this.makeSurfaceTool(surfaced)],
        stopWhen: () => surfaced.text !== null,
        wrapUpHint: 'Wrap up: call surface now with a short sleep summary if worth it, otherwise end quietly.',
        nudge: {
          when: (lastContent) => surfaced.text === null && lastContent.trim().length > 0,
          message:
            '[system] Your text has not been captured for the waking thread. Call surface once with a short sleep summary, otherwise end quietly.',
        },
      });
      log.info('梦结束', {
        ms: Date.now() - started,
        inheritedMessages: inherited.length,
        surfaced: surfaced.text !== null,
        summary: (summary ?? '').slice(0, 300),
      });
      if (surfaced.text !== null) this.d.onEmergence(surfaced.text);
    } catch (e) {
      log.error('梦失败', errorLogData(e));
    } finally {
      this.dreaming = false;
    }
  }

  private spawn(opts: ForkOptions): Promise<string> {
    return this.d.core.spawnFork(opts);
  }
}
