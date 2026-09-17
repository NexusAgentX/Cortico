import type { World } from './core/types.ts';
export type { World, WorldHost, WorldPrefixContext } from './core/types.ts';

/** Caller-owned configuration is passed directly to the World factory. */
export interface WorldDefinition<Config = unknown> {
  id: string;
  create(config: Config): World;
}
