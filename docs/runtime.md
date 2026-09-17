<!-- Owner: src/core/core.ts, src/core/types.ts, src/core/loop.ts -->
# Runtime contracts

`CoreOptions` requires `dataDir`, `persona`, `provider` and `model`; `worlds` and `config` are optional.
The constructor creates file stores and attaches `CoreApi` before reading Persona session declarations.
Exactly one declaration must be both persistent and event-receiving. The model configuration belongs
to the Core instance; there is no endpoint registry or runtime switching mechanism.

Persona supplies ordered system segments, optional synthetic session-head Items, tools and lifecycle
hooks. Core joins system segment text without adding a separator. Mounted World descriptions are
passed to Persona in id order. `World.environment()` supplies current text without file-template or
console dependencies. Main-session tools combine declared Persona tools and mounted World tools.
World and session output observers receive standard Responses events.

`start()` loads the persistent session, starts Worlds, starts timers and runs the main loop.
`mount()` starts a new World when running and rebuilds its prefix and tools; `unmount()` stops it,
invalidates its host and rebuilds the prefix. Failed or timed-out stop operations are reported while
other Worlds continue stopping. Callers serialize lifecycle changes and own external resources.
`stop()` is idempotent, drains the loop for up to one second and allows each World twenty seconds to
stop. It saves Core state and returns failures. Stop does not dispose the caller-owned Provider.
Create a fresh Core to resume a stopped instance's data directory.

## Events and tools

`WorldHost.pushEvent()` assigns a cursor, archives an event and queues it unless `deliver: false`.
`pushDeferred()` queues a renderer evaluated at delivery; deferred items are not restart-persistent.
`pushCandidate()` archives source events and applies a projection at delivery.

WakeBus supports `preempt`, `flush`, `debounce` and `piggyback`. Debounce is bounded by the minimum
and maximum batch age, quiet gap and maximum batch size. Operator pause and Persona delivery gates
control consumption. External events become paired event-frame tool results by default; a Session
may choose user-message delivery. Internal events enter user messages.

Tools execute in model order. Stream-complete calls can execute eagerly; `barrierAfter` prevents later
calls from executing in the same response. `endsTurn` finishes the batch. Invalid JSON, unknown tools
and handler exceptions produce paired failure receipts. Shutdown seals the loop against late model
or tool output. Tool handlers receive an AbortSignal and must respect cancellation before side effects.

## Context and recovery

Input capacity is the smaller of the configured and Provider-reported context windows, minus the
configured output budget. Unknown capacity imposes no guessed token cap. Provider token estimation
is optional; Core otherwise estimates from text. Persona chooses handoff content; Core repairs tool
pairing and enforces known capacity. Session-head Items are inserted per request and not persisted.

Event cursors are monotonic across run shards. Session history, delivery cursor, Persona state,
failure state and timers survive restart. The queue itself does not; Core replays eligible external
events beyond the delivery watermark. Memory attachments are resolved through Persona's BlobStore;
new event and tool attachments are content-addressed under `media/`.

Each run has event and log records under `runs/`. Session usage statistics are in memory. Generation
results include each attempt's nullable token meters; unknown measurements remain unknown there.
The caller must provide an exclusive data directory for each live Core.
