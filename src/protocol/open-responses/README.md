<!-- Owner: src/protocol/open-responses/index.ts, src/protocol/open-responses/generated.ts -->
# Open Responses

`openapi.json` contains the published 2026-04-24 Open Responses schema.
`generated.ts` contains its TypeScript types, schema version and source digest.
The schema and generated types retain the Apache-2.0 license in `LICENSE`.

`context.ts` wraps standard Items in local persistence metadata; `context-log.ts` reads and writes
those records. `stream.ts` validates event ordering, Item identity and terminal response consistency.
`tokens.ts` estimates context occupancy. Protocol metadata is separate from model wire content.
