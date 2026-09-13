/**
 * 最小完整的 World:一条生命周期事件、一个工具、一段环境提示词、一个旋钮。
 *
 * 边界照 docs/worlds.md:事件与回执只陈述系统能确认的事实;World 这一侧的状态变化(这里是
 * 挂载本身)投事件告知 bot;工具的使用时机写在环境提示词里,description 只放工具自己的定义;
 * 不碰 Memory,不绑 Persona 的工具。
 */
import { fileURLToPath } from 'node:url';
import type { ToolDef, World, WorldConsoleDecl, WorldHost } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { EXAMPLE_CONFIG_GROUP, type ExampleConfigSection } from './config.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

export interface ExampleWorldOptions {
  /** `worlds.example` 的活引用。 */
  cfg: ExampleConfigSection;
  timezone: string;
}

export class ExampleWorld implements World {
  readonly id = 'example';

  constructor(private readonly opts: ExampleWorldOptions) {}

  /** 只报值;前缀文本一律来自 ENV_PROMPT.md 模板。 */
  envPromptVars(): Record<string, string> {
    return { 'example.greeting': this.opts.cfg.greeting };
  }

  tools(): ToolDef[] {
    return [this.echoTool()];
  }

  console(): WorldConsoleDecl {
    return {
      config: [EXAMPLE_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.example.envPrompt',
          title: 'Example · 环境提示词',
          description: '示例 World 进 system 前缀的那一段。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [{ name: 'example.greeting', description: '配置里的回执开头,此刻的值。' }],
        },
      ],
    };
  }

  /** 挂载是 World 这一侧的状态变化,投一条事件告知 bot;`origin: 'internal'` = World 报自己的机制。 */
  async start(host: WorldHost): Promise<void> {
    await host.pushEvent({
      type: 'example.started',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text: 'Example World 已挂载,example_echo 可用。',
    });
  }

  async stop(): Promise<void> {}

  private echoTool(): ToolDef {
    return {
      name: 'example_echo',
      description: 'Echo the given text back, prefixed with the configured greeting.',
      tags: ['read'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: 'Text to echo.' },
        },
        required: ['text'],
      },
      handler: async (args) => `${this.opts.cfg.greeting} ${String(args.text ?? '')}`,
    };
  }
}
