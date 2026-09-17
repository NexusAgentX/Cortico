import { Core, type CoreOptions } from './core/core.ts';

export interface BotDefinition {
  build(): CoreOptions;
}

export interface Bot {
  core: Core;
  start(): Promise<void>;
  stop(): ReturnType<Core['stop']>;
}

export function createBot(definition: BotDefinition): Bot {
  const core = new Core(definition.build());
  return { core, start: () => core.start(), stop: () => core.stop() };
}
