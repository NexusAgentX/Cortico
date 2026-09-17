import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponsesProvider } from '../../src/providers/openai-responses-compat/index.ts';
import { GenerationError } from '../../src/core/generation.ts';
import { createResponse, type StreamEvent } from '../../src/protocol/open-responses/index.ts';
import { responseRecords } from '../../src/protocol/open-responses/context.ts';

const usage = { input_tokens: 20, output_tokens: 5, total_tokens: 25,
  input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 2 } };
function resource(id = 'response') {
  return { ...createResponse(id, { model: 'test-model' }), status: 'completed' as const, usage };
}
function stream(events: unknown[]): Response {
  return new Response(events.map((event, sequence_number) => `data: ${JSON.stringify({ ...(event as object), sequence_number })}\n\n`).join(''));
}
const provider = () => new ResponsesProvider({ baseUrl: 'https://model.test/v1' });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Responses transport', () => {
  it('retries transient HTTP failures and returns each attempt with its own meters', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(Response.json(resource()));
    vi.stubGlobal('fetch', fetcher);
    const result = provider().respond({ model: 'test-model', input: 'hello' });
    await vi.advanceTimersByTimeAsync(1000);
    const generated = await result;
    expect(generated.attempts.map(a => [a.status, a.outcome, a.meters.input])).toEqual([
      [503, 'failed', null], [200, 'completed', 20],
    ]);
    expect(generated.attempts[0].id).not.toBe(generated.attempts[1].id);
  });

  it('retries an uncommitted stream failure and preserves partial usage', async () => {
    vi.useFakeTimers();
    const first = { ...resource('first'), status: 'in_progress', output: [] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(stream([{ type: 'response.created', response: first }]))
      .mockResolvedValueOnce(stream([{ type: 'response.created', response: { ...resource('second'), status: 'in_progress' } },
        { type: 'response.completed', response: resource('second') }])));
    const events: StreamEvent[] = [];
    const pending = provider().respond({ model: 'test-model', input: 'hello' }, { onEvent: event => events.push(event) });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.attempts.map(a => a.outcome)).toEqual(['failed', 'completed']);
    expect(result.attempts[0].meters.input).toBe(usage.input_tokens);
    expect(events.filter(e => e.type === 'response.created').map(e => e.response.id)).toEqual(['first', 'second']);
  });

  it('does not retry after visible text has been emitted', async () => {
    const response = { ...resource(), status: 'in_progress' };
    const item = { type: 'message', id: 'message', role: 'assistant', status: 'in_progress', content: [] };
    const fetcher = vi.fn().mockResolvedValue(stream([
      { type: 'response.created', response },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.content_part.added', output_index: 0, item_id: 'message', content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', output_index: 0, item_id: 'message', content_index: 0, delta: 'visible', logprobs: [] },
    ]));
    vi.stubGlobal('fetch', fetcher);
    let error: unknown;
    try { await provider().respond({ model: 'test-model', input: 'hello' }, { onEvent: () => {} }); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(GenerationError);
    expect((error as GenerationError).partial?.output).toMatchObject([{ content: [{ text: 'visible' }] }]);
    expect((error as GenerationError).attempts).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('marks a completed response discarded when the request ignores cancellation', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', async () => { controller.abort(); return Response.json(resource()); });
    const generated = await provider().respond({ model: 'test-model', input: 'hello' }, { signal: controller.signal });
    expect(generated.attempts[0]).toMatchObject({ outcome: 'discarded', meters: { input: 20, output: 5 } });
  });

  it('replays encrypted reasoning only to the same endpoint and credentials', async () => {
    const response = resource();
    response.output = [{ type: 'reasoning', id: 'reasoning', summary: [], encrypted_content: 'opaque' }];
    const fetcher = vi.fn().mockImplementation(async () => Response.json(response));
    vi.stubGlobal('fetch', fetcher);
    const first = provider();
    const generated = await first.respond({ model: 'test-model', input: 'hello' });
    const context = responseRecords(generated.response, generated.origin);
    await first.respond({ model: 'test-model' }, { context });
    expect(JSON.parse(fetcher.mock.calls[1][1].body).input).toMatchObject([{ encrypted_content: 'opaque' }]);
    await new ResponsesProvider({ baseUrl: 'https://other.test', apiKey: 'different' }).respond({ model: 'test-model' }, { context });
    expect(JSON.parse(fetcher.mock.calls[2][1].body).input).toEqual([]);
  });
});
