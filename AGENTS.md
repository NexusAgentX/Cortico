# AGENTS.md

Read [PHILOSOPHY.md](PHILOSOPHY.md) before changing prompting, tools, Memory or context.
State any conflict with these rules before building.

## Design and boundaries

- Core owns event scheduling, sessions, model/tool execution, capacity checks and recovery.
  It contains no application-specific branching or interpretation of Memory.
- Persona supplies semantic context, session declarations, behavioral policy and Memory operations.
- World supplies external events, tools and environment text. It does not modify Memory or call
  a concrete Persona implementation.
- Provider implements model communication. Each Core receives one client; the caller owns its lifetime.
- Bot is a programmatic assembly. Credentials, data directories, process management and external
  services belong to the caller. Do not add built-in applications, a console or deployment machinery.
- Prefer semantic instructions over hard-coded decisions. Model-limit workarounds are explicit fallbacks.
- Treat this repository as unpublished. Change interfaces directly without compatibility or migration layers.

## Names

| Unit | Location | Contracts |
|---|---|---|
| Core | `src/core/` | `Core`, `CoreApi`, `CoreOptions`, `CoreConfig` |
| Persona | Caller-owned | `Persona` |
| Memory | Caller-owned | `BlobStore` for attachment access |
| World | Caller-owned; factory contract in `src/world.ts` | `World`, `WorldHost`, `WorldDefinition` |
| Provider | `src/providers/` | `Provider`, `ResponseClient` |
| Bot | `src/bot.ts` | `BotDefinition`, `createBot()` |

- Use `Options`, `Context`, `Definition`; use `*Host` for the interface handed to a component.
- File names use kebab-case. Tests mirror the source unit they cover.
- Runtime lifecycle uses `start/stop`; Core attaches Worlds with `mount/unmount`.
- Events use `<world>.<noun>`, tools use `<world>_<verb_phrase>`.
- Durations include their units (`Ms`, `Sec`, `Minutes`); directories end in `Dir`, files in `File`.
- Timestamps use `At` for ISO strings and `AtMs` for epoch milliseconds.
- npm scripts use `<verb>:<object>` except standard package commands such as `test`.

## Writing

Lead with the result and state the current invariant. Keep comments for facts that cannot be inferred
from the code. Remove redundant prose, UI narration, incident history, hype and manufactured contrasts.
Use plain language and precise behavior, conditions and units. Review comments and documentation after
interface edits so they do not describe removed behavior.

Each page under `docs/` and each code-unit README names its owner in the first line. Update the page
when its owner changes. PHILOSOPHY.md describes the technical stance and is exempt. Plans and temporary
notes belong in `scratch/`; retired history belongs in `deprecated/`. Both are gitignored.

## Validation

- Run `pnpm test` and `pnpm run typecheck` before every commit.
- Test behavior with real temporary files, event stores and runtime components; script only the model.
- Do not contact real model services or start a real application to verify changes.
- Use exported defaults in assertions. Avoid tests that only assert a mock received a constant.
- Fixtures and examples use no real vendor or model names, except the actual protocol/adapter identifier.
- Validate external boundaries; do not add defensive branches for states ruled out by the contract.

## Scratch and Git

- Put disposable scripts, probes and dumps in `scratch/`, never a tracked source directory.
- Commit each coherent milestone with tests and type checking green.
- Stage explicit paths. Never use `git add -A`, `git add .` or `git commit -a`.
- Do not push, open pull requests or rewrite published history unless asked.
- Use Conventional Commits: `<type>(<scope>): <description>`, with lowercase ASCII type and scope.
  Scopes follow paths with `src/` omitted; omit scope for repository-wide changes. Keep the subject
  below 72 characters and omit the trailing period.
- Mark breaking API or data changes with `!` and a `BREAKING CHANGE:` footer describing the new contract.
  No migration is required for this unpublished codebase.
