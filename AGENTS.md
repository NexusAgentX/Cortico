# AGENTS.md

Rules for working in this repository. [PHILOSOPHY.md](PHILOSOPHY.md) says what Cortico is;
this file says how work here is done. When a request conflicts with either, say so before
building.

## 1. Design stance

Read PHILOSOPHY.md before changing how an agent is prompted, given tools, given memory, or
handed context. Two of its rules settle most design questions:

- **Design toward the frontier.** A mechanism that exists only to work around a current model's
  limit is a fallback, and is written, named and documented as one.
- **Minimal priors.** Prefer a semantic instruction the agent applies with judgment over
  hard-coded control flow. Reserve control flow for what is genuinely mechanical and for cases
  where a wrong judgment is unrecoverable.

## 2. Names

| Layer | Directory | Code |
|---|---|---|
| Core | `src/core/`; assembly in `src/bot.ts` and `src/world.ts` | `Core`, `CoreApi`, `CoreConfig`, `EventEnvelope` |
| Persona | `bots/<name>/persona/` | `Persona` |
| Memory | `<deployment>/memory/`; the Persona chooses the path (Cormini and CortiV use `workspace/`) | none; Core reaches it only through a directory path and blob handles |
| World | `src/worlds/<id>/`, listed in `src/worlds/index.ts`; external ones are extensions | `World`, `WorldHost`, `WorldDefinition`, `WorldContext` |
| Bot | `bots/<name>/index.ts` | `BotDefinition`, `createBot()` |

Core-side facilities, not layers: providers (`src/providers/`, `ProviderModule`), the console
(`src/web/`), the extension loader (`src/extensions/`). An extension is an npm package that
supplies one World, one provider or one bot; those three are the extension points. A deployment
(`deployments/<name>/`) holds one bot's config, secrets, Memory and run data; none of it is
tracked.

One name all the way through: a World's config section is `worlds.<id>`, its console page id
`world:<id>`, its manifest `kind` is `world`; packages are `cortico-world-*`,
`cortico-provider-*`, `cortico-bot-*`. Chinese UI text keeps Core, Persona, Memory and World
as proper nouns and calls an extension 扩展.

Conventions that hold across the repository:

- **One prefix per World**, the id in PascalCase (`Minecraft`, `Pvz`, `QQ`, `WebSearch`), on its
  contract exports: `<PREFIX>` definition, `<Prefix>ConfigSection`, `<PREFIX>_DEFAULTS`,
  `<PREFIX>_CONFIG_GROUP`, `<PREFIX>_TOOL_DECLS`, `<PREFIX>_PANEL_DECLS`, the `<Prefix>World`
  class and its `<Prefix>WorldProxy`. Internal helpers carry no prefix; engine-ipc types
  (`EngineInit`, `EngineRequest`, `HostRequest`, `MainToChild`) are unprefixed in every World.
- **Fixed files per World**: `definition.ts` (the definition), `config.ts` (config section,
  defaults, config groups, secret names), `world.ts` (the class); a World that runs in a child
  process adds `proxy.ts`, `engine-child.ts`, `engine-ipc.ts`. The child process is 引擎子进程 in
  prose and `engine` in identifiers. File names are kebab-case.
- **Tools** are `<id>_<verb phrase>` in snake_case (`mc_` is the fixed short form for minecraft).
  **Events** use `type` as `<id>.<noun>` with no hyphen inside a segment, `source` is the World id,
  `senderKey` is `<id>` or `<id>.<lane>`, `ts` comes from `nowIso(timezone)`.
- **Config keys**: a duration carries its stored unit (`Ms`, `Sec`, `Minutes`); a directory ends in
  `Dir`, a file in `File`; a component's switch is `enabled` inside that component's object; other
  booleans are affirmative verb phrases; caps are `max<Noun>`.
- **Types**: `Options` never `Opts`, `Context` never `Ctx`. `Definition` is what an extension point
  exports; `Decl` is what a World or Persona declares to the console; `*Host` is the surface Core
  hands a collaborator, `*Api` the surface a Persona uses on Core. Discriminant field is `kind`,
  except the event envelope's `type`. Timestamps are `*At` (ISO) or `*AtMs`; durations `*Ms`.
- **Verbs**: runtime objects `start/stop`; Core attaching a World `mount/unmount`; the assembly
  layer `activate/deactivate`; console client objects `mount/dispose`. Factories are `create*`.
  Hooks are `on<Moment>`; a World hook never shares a Persona hook's name with a different
  signature. Abbreviations allowed in locals: `req rep msg err opts cfg ctx`; one style per World.
- **Environment variables** are `CORTICO_*`. npm scripts are `<verb>:<object>`. `tests/<layer>/`
  mirrors `src/<layer>/`; a test file is named after the file it covers.

## 3. Boundaries

1. **Core is semantics-free.** `src/core/` names no kind of bot: no branching on a session id,
   no bot vocabulary, no assumption that Memory is a file tree. Bot-specific behavior is a hook
   the Persona fills in.
2. **Context text comes from the Persona.** Core writes no prose for the model; an empty hook
   produces nothing.
3. **Platform details stay in their World.** Core knows no group, friend or message id. A World
   never writes to Memory and never binds a Persona's tools.
4. **Defaults live with their owner.** Core parameters in `src/core/config.ts`, Persona choices
   in the Persona's config, World parameters in the World. A bot package may override a World's
   defaults; a deployment overrides everything. The model behind an endpoint belongs to the
   provider entry and is invisible to the Persona.
5. **Tunables are declared, never hand-built.** A knob is a JSON Schema property in its owner's
   `ConfigGroup`; the console renders it. Adding a World or a Persona leaves `src/web/**`
   byte-identical, and `tests/web/acceptance-zero-diff.test.ts` enforces that.

## 4. Writing

These rules apply to comments, documents and commit messages alike. A sentence stays only if it
carries a fact the reader needs and cannot get from the code.

- Conclusion first, mechanism second.
- State the invariant, not the runtime story and not the negotiation that produced it. History
  belongs in git.
- No manufactured contrast ("A, not B" where nobody proposed B). No paraphrase of the request
  that produced the code. No issue, decision or section numbers.
- Do not name the bot; write "bot" when a referent is unavoidable.
- A field comment is one or two sentences on one topic. The contract goes on the interface, the
  architecture in the module header or the owning document.
- No defensive code for states the types or the caller rule out; validate at real boundaries
  only.
- No test that asserts a mock was called with a constant. Test behavior against real or
  realistically faked components; when a call count is the behavior, say so in the test name.

## 5. Tests

- Assert the contract, not incidental values: compare with the exported default, not a literal.
- Real components: real git repos, real ports, a real event store. Only the LLM is scripted.
- No network in tests. Real-service checks live in `scripts/` and run by hand.

## 6. Commands

- `pnpm test` and `pnpm run typecheck` are green before every commit; browser code is checked by
  `pnpm typecheck:web`.
- `pnpm build:web` after changing `src/web/client/`, `src/web/shared/` or any
  `console/client.ts`. Never while a bot process is alive on this machine: the running console
  serves the bundle being overwritten.
- Never start a real bot to verify a change. Use tests, `pnpm dev:console` (fake data) or a
  script under `scratch/`.
- `pnpm logq` queries run logs; `pnpm check:extension <dir>` validates an extension package;
  `pnpm audit:release` runs the release audit.

## 7. Scratch

Disposable work (probes, one-off scripts, dumps, experiments) goes under `scratch/`
(gitignored), never into `scripts/`, `src/`, `bots/` or another tracked tree. Promote it
deliberately when it becomes a tool.

## 8. Documentation

- Every page under `docs/` and every README of a code unit names, in its first line, the file
  or interface it shadows: its owner. The commit that changes the owner changes the page.
- Text without a code owner (plans, migration records, decision history) lives in `scratch/`
  while active and in `deprecated/` when retired. Both are gitignored.
- PHILOSOPHY.md is exempt: it is written for a first-time reader and may repeat other files.

## 9. Git

- Commit at every milestone: a change stated in one sentence that leaves
  `pnpm test && pnpm run typecheck` green. Smaller than a feature, larger than one file; an
  additive step and its migration are two commits.
- Stage by explicit path. Other sessions may have uncommitted work in this tree, so
  `git add -A`, `git add .` and `git commit -a` are never used.
- Subject line says what changed and why; bullets carry what the diff does not show (the
  rejected alternative, the invariant relied on, what the tests now cover).
- Committing is not pushing. Push, open pull requests or rewrite published history only when
  asked.
