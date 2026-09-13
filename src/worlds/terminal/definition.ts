import type { WorldDefinition } from '../../world.ts';
import { TERMINAL_DEFAULTS, type TerminalConfigSection } from './config.ts';
import { TerminalWorld } from './world.ts';

export const TERMINAL: WorldDefinition<TerminalConfigSection> = {
  id: 'terminal',
  label: '终端对话',
  defaults: () => ({ ...TERMINAL_DEFAULTS }),
  // 控制台语言随 ctx 进 World:World 整个按它切换文案与环境提示词模板(不传 = 中文)。
  create: (ctx) => new TerminalWorld({
    timezone: ctx.timezone,
    botName: ctx.botName,
    cfg: ctx.cfg,
    language: ctx.language,
  }),
};
