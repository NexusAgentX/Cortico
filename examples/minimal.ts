/** Caller-owned Persona and World connected through the public Core contracts. */
import { createBot } from '../src/bot.ts';
import type { ModelSpec, Persona, World, WorldHost } from '../src/core/types.ts';
import type { Provider } from '../src/providers/base.ts';
import { nowIso } from '../src/core/util.ts';

export interface ExampleOptions {
  dataDir: string;
  provider: Provider;
  model: ModelSpec;
  onText(text: string): void;
}

export function createExample(options: ExampleOptions) {
  let host: WorldHost | null = null;
  const world: World = {
    id: 'example',
    environment: () => 'Messages arrive from the caller. Reply in plain text.',
    tools: () => [],
    outputTap: () => ({
      onEvent: event => {
        if (event.type === 'response.output_text.delta') options.onText(event.delta);
      },
    }),
    start: async value => { host = value; },
    stop: async () => { host = null; },
  };
  const persona: Persona = {
    attach: () => {},
    systemSegments: async context => context.worlds.map(world => ({ title: world.id, text: world.envPrompt })),
    declareSessions: () => [{ id: 'main', label: 'Main', persistent: true, receivesEvents: true,
      eventDelivery: 'user', rounds: () => ({ soft: 4, hard: 8 }), tools: () => [] }],
    blobs: {
      get: () => null,
      put: () => { throw new Error('This example does not store Memory attachments'); },
      list: () => [],
    },
  };
  const bot = createBot({ build: () => ({ dataDir: options.dataDir, provider: options.provider,
    model: options.model, persona, worlds: [world] }) });
  return {
    ...bot,
    async send(text: string) {
      if (!host) throw new Error('Start the example before sending an event');
      return host.pushEvent({ type: 'example.message', source: world.id, text, ts: nowIso('UTC') }, { trigger: 'flush' });
    },
  };
}
