import { createResponse, type Response, type StreamEvent } from '../../protocol/open-responses/index.ts';
import { ResponseAccumulator, ResponseProtocolError } from '../../protocol/open-responses/stream.ts';
import { standardUsage, unknownMeters, type TokenMeters } from '../../core/generation.ts';
import { responseMeters } from './response-meters.ts';

export interface ResponseAssembly {
  feed(payload: unknown, emit: (event: StreamEvent) => void): void;
  finish(emit: (event: StreamEvent) => void): Response;
  snapshot(): Response | null;
  meters(): TokenMeters;
  serviceTier(): string | null;
}

/**
 * Validate native Responses Items before notifying observers.
 * Normalize response.reasoning_text.* to the schema name response.reasoning.* before validation.
 */
export class NativeResponseAssembly implements ResponseAssembly {
  private readonly accumulator = new ResponseAccumulator();
  private usage = unknownMeters();
  private tier: string | null = null;
  feed(payload: unknown, emit: (event: StreamEvent) => void): void {
    if (!payload || typeof payload !== 'object') throw new ResponseProtocolError('Invalid native Responses event');
    if ('type' in payload && (payload.type === 'response.reasoning_text.delta' || payload.type === 'response.reasoning_text.done'))
      payload = { ...payload, type: payload.type.replace('reasoning_text', 'reasoning') };
    let event = payload as StreamEvent;
    if ('response' in event) {
      const raw = event.response;
      if (!raw || typeof raw.id !== 'string' || typeof raw.model !== 'string' || !Array.isArray(raw.output)) throw new ResponseProtocolError('Invalid native Responses resource');
      if (typeof raw.service_tier === 'string') this.tier = raw.service_tier;
      if (raw.usage) this.usage = responseMeters(raw.usage);
      event = { ...event, response: { ...createResponse(raw.id, { model: raw.model }), ...raw, usage: standardUsage(this.usage) } };
    }
    this.accumulator.accept(event);
    emit(event);
    if (event.type === 'error') throw new ResponseProtocolError(`Native response error: ${JSON.stringify(event)}`);
  }
  finish(): Response { return this.accumulator.finish(); }
  snapshot(): Response | null { return this.accumulator.snapshot(); }
  serviceTier(): string | null { return this.tier; }
  meters(): TokenMeters { return structuredClone(this.usage); }
}

export interface ParsedResponse {
  response: Response;
  meters: TokenMeters;
  serviceTier: string | null;
}
