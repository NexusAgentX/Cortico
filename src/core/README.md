<!-- Owner: src/core/core.ts, src/core/types.ts, src/core/loop.ts -->
# Core

`core.ts` assembles the event store, Session, timers, state, loop and injected Provider.
`types.ts` defines Persona, World, CoreApi, tools and events. The public runtime contract is
[documented here](../../docs/runtime.md).

| Files | Responsibility |
|---|---|
| `loop.ts`, `fork.ts` | Main and temporary model/tool loops |
| `bus.ts` | Event scheduling, batching, preemption and delivery gates |
| `session.ts`, `sessions.ts` | Persistent context and in-memory session statistics |
| `event-store.ts`, `state.ts`, `run.ts`, `timers.ts` | File persistence and recovery |
| `prefix.ts`, `truncate.ts`, `markers.ts` | Persona prefix assembly, pairing and mechanical context markers |
| `blobs.ts` | Attachment handles and content-addressed media |
| `generation.ts` | Model request/result and attempt contracts |
| `config.ts` | Programmatic defaults and validation |
| `util.ts`, `log-context.ts` | Logging, time and per-call anchors |
