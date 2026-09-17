<!-- Owner: src/core/core.ts, src/bot.ts -->
# Cortico

Cortico is a general-purpose, event-driven Agent core for Node.js 22+ and TypeScript.
It runs persistent sessions, delivers events, dispatches tools, and hands off context.
The caller supplies a Persona, Worlds, one Provider client, model settings and a data directory.

## Components

- **Core** owns scheduling, sessions, tool execution, capacity checks, timers and recovery.
- **Persona** supplies context, session declarations, handoff policy and Memory operations.
- **World** supplies an environment description, events, tools and optional output observers.
- **Provider** implements model requests. `openai-responses-compat` is included.
- **Bot** is a programmatic assembly of these components.

Memory belongs to the caller's Persona. There are no bundled Personas or Worlds, web console,
extension package manager, deployment manager or model-server launcher.

## Development

```sh
pnpm install
pnpm test
pnpm run typecheck
```

The source is ESM TypeScript. Use a TypeScript-aware runtime such as `tsx` in the host project.
[The minimal example](examples/minimal.ts) implements a caller-owned Persona and World:

```ts
import { ResponsesProvider } from './src/providers/openai-responses-compat/index.ts';
import { createExample } from './examples/minimal.ts';

const provider = new ResponsesProvider({
  baseUrl: 'https://model.example/v1',
  apiKey: 'supplied-by-your-application',
});
const agent = createExample({
  dataDir: '/absolute/path/to/agent-data',
  provider,
  model: { model: 'your-model', thinking: false, contextWindow: 32000, maxTokens: 4096 },
  onText: text => process.stdout.write(text),
});
await agent.start();
await agent.send('Hello');
// Call await agent.stop() when your application is ready to shut down.
```

`send()` archives and queues the event; it does not wait for model completion.
The application owns credentials, process lifecycle and any external services.

## Runtime contracts

Create `Core` directly with `CoreOptions`, or use `createBot({ build: () => options })`.
`Core.start()` starts the mounted Worlds and the event loop. `Core.stop()` drains the loop,
stops Worlds and saves state, returning any failures. Concurrent stop calls share one operation.
To resume after stopping, create a new Core with the same data directory. One live Core may
write a data directory at a time; the caller enforces that ownership.

`core.mount(world)` and `core.unmount(id)` update the environment prefix and tool table.
Main-session tools combine the Persona's declaration with mounted World tools. Other sessions
use their own declared tools. Each Core uses one injected model client for all sessions.

The data directory stores the persistent session, event shards, Core state, timers, attachments
and run logs. Usage counters remain in memory; raw model usage stays on generation results.
There is no billing or separate usage, tool-call or transcript ledger.

See [runtime contracts](docs/runtime.md), [model transport](docs/providers.md), and
[design principles](PHILOSOPHY.md). 中文说明见 [README_zh.md](README_zh.md).

## License

MIT. The bundled Open Responses schema and generated types retain their Apache-2.0 notice
in [src/protocol/open-responses/LICENSE](src/protocol/open-responses/LICENSE).
