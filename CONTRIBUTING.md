# Contributing

Read [PHILOSOPHY.md](PHILOSOPHY.md) and [AGENTS.md](AGENTS.md) before changing runtime contracts.
Keep application semantics in caller-owned Persona and World implementations.

Run `pnpm test` and `pnpm run typecheck` before each commit. Tests use temporary file stores and
scripted model responses; they do not contact model services. Add behavioral coverage for runtime
changes and update the document that owns the changed contract.

Use Conventional Commits and stage explicit paths. Do not commit credentials, Memory or runtime data.
