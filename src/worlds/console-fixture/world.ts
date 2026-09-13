/**
 * 控制台边界的活体验收件。
 *
 * 它存在的唯一目的是**证明一件事**：新增一个 World，`src/web/**` 一个字都不用改，
 * 它的面板就会自己出现在控制台里——manifest 自动收录、bundle 自动发现、导航自动
 * 出现、进面板才 dynamic import、mount / unmount 生命周期成立。
 *
 * 这不是"测试里的假件"，而是一个真 World：走一模一样的 `World` 契约、一模一样的
 * 目录约定（`console/client.ts`）、一模一样的构建发现。假件证明不了边界，因为假件
 * 可以被特殊对待；这个东西不能。
 *
 * **它不会在任何真 bot 里被激活**——装配哪些 World 由 bot 自己决定，没有 bot 装它。
 */

import { fileURLToPath } from 'node:url';
import type { World, WorldHost, WorldConsoleDecl, ToolDef } from '../../core/types.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

interface ConsoleFixtureOptions {
  /** 允许多实例并存时区分（验收"两个 provider 互不串味"时用） */
  id?: string;
  label?: string;
}

export class ConsoleFixtureWorld implements World {
  readonly id: string;
  private readonly label: string;
  private host: WorldHost | null = null;
  private pings = 0;

  constructor(opts: ConsoleFixtureOptions = {}) {
    this.id = opts.id ?? 'console-fixture';
    this.label = opts.label ?? '控制台验收件';
  }

  /** 连验收件也走模板——留一条"文本可以不来自模板"的捷径,不变量就不成立了。 */
  envPromptVars(): Record<string, string> {
    return {};
  }

  tools(): ToolDef[] {
    return [];
  }

  console(): WorldConsoleDecl {
    return {
      // 这个 World 不连任何东西,装上就是通的;握过手之后 hint 里带上次数。
      lamps: [{
        label: '握手',
        state: 'online',
        ...(this.pings > 0 ? { hint: `${this.pings} 次` } : {}),
      }],
      badges: [{ label: '握手', value: this.pings, tone: this.pings > 0 ? 'on' : 'plain' }],
      // 面板以局部 id 和标题对象声明，id 不包含 World 前缀。
      panels: [
        { id: 'hello', title: '握手', description: '调一次 invoke,看徽标跟着变。' },
        { id: 'echo', title: '回声', description: '把参数原样送回来,验证 args 透传。' },
      ],
      invoke: async (panel, method, args) => {
        if (panel === 'hello' && method === 'ping') {
          this.pings++;
          return { ok: true, pings: this.pings, at: new Date().toISOString() };
        }
        if (panel === 'echo' && method === 'echo') {
          return { echoed: args };
        }
        throw new Error(`验收件不认识 ${panel}.${method}`);
      },
      promptDocs: [
        {
          key: `worlds.${this.id}.envPrompt`,
          title: `${this.label} · 环境提示词`,
          description: '验收件的一句话环境说明。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
  }

  async stop(): Promise<void> {
    this.host = null;
  }
}
