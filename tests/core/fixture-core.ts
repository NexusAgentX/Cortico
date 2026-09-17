import { Core as StandardHarness, type CoreOptions } from '../../src/core/core.ts';
import type { CoreConfig } from '../../src/core/types.ts';
import { activeSpec, type LoadedConfig } from './helpers.ts';
import { SessionLog } from './fixture-session.ts';
import { adaptClient, records, type FixtureClient, type FixtureForkOptions } from './fixture-protocol.ts';
import type { ForkOptions } from '../../src/core/types.ts';
export * from '../../src/core/core.ts';
export class Core<C extends CoreConfig = CoreConfig> extends StandardHarness {
  declare readonly session: SessionLog;
  readonly loaded: LoadedConfig<C>;
  constructor(loaded: LoadedConfig<C>, deps: { persona: CoreOptions['persona']; worlds: NonNullable<CoreOptions['worlds']>; llm: FixtureClient | CoreOptions['provider'] }) {
    super({ config: loaded.config, dataDir: loaded.dataDir, persona: deps.persona,
      worlds: deps.worlds, provider: adaptClient(deps.llm), model: activeSpec(loaded.config) });
    this.loaded = loaded;
    Object.setPrototypeOf(this.session, SessionLog.prototype);
  }
  override spawnFork(options: ForkOptions | FixtureForkOptions): Promise<string> { return super.spawnFork({ ...options, messages: records(options.messages) }); }
}
