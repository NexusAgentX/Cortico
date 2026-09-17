<!-- Owner: src/providers/base.ts, src/providers/openai-responses-compat/native.ts -->
# Provider

`Provider` extends `ResponseClient.respond(request, options)` and optionally reports accepted MIME
types, a context window, token estimates and context-overflow errors. One instance is injected into
Core and used by its main and temporary sessions. The caller owns Provider construction and lifetime.
`Generation` returns the standard response, origin and attempts with nullable token meters.
`GenerationError` retains attempts and any partial response.

`ResponsesProvider` accepts `baseUrl`, an optional direct `apiKey`, `endpointPath` (default `/responses`),
`extraHeaders`, `extraBody`, an optional logger, media resolver and past-reasoning policy.
It uses HTTP and SSE without a model SDK dependency. It does not discover models or launch a server.
The model name and budgets are supplied in Core's `model` option.

Requests replay the full local context with `store: false`; system/developer text becomes instructions.
Encrypted reasoning is replayed only to the same endpoint, credentials and model. Plaintext reasoning
is retained locally but not replayed as native reasoning. `extraBody` is applied last and can override
wire fields. The caller is responsible for any such override matching Core's model and budget settings.

Transient network failures, HTTP 429 and 5xx can retry after 1, 4 and 10 seconds. HTTP 4xx other than
429 fail immediately. A stream that has emitted visible text or a tool call is not retried by the
transport. First-response timeouts are 300 seconds for streams and 120 seconds otherwise; stream
frame idle timeout is 120 seconds and content idle timeout is 300 seconds. Core's batch-level retry
policy is separate and preserves already recorded partial output and tool results.

Standard multimodal Items pass through. A supplied media resolver promotes local image handles to
inline image parts. Attachments remain in Core's file store or the external Persona's BlobStore.
Model responses keep raw usage; no prices, balances or billing ledger are computed.
