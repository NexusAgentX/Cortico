import type { ModelSpec } from './types.ts';
import type { Request, Response, StreamEvent, Usage } from '../protocol/open-responses/index.ts';
import type { ContextRecord, ItemOrigin } from '../protocol/open-responses/context.ts';

/** Missing meters remain null. Native details are retained for future reconciliation. */
export interface TokenMeters {
  input: number | null;
  output: number | null;
  total: number | null;
  cachedInput: number | null;
  uncachedInput: number | null;
  reasoning: number | null;
  details?: Record<string, { quantity: number | null; unit: string }>;
  native: Record<string, unknown> | null;
}
export interface ProviderAttempt {
  id: string;
  generationId: string;
  ordinal: number;
  origin: ItemOrigin;
  startedAt: string;
  elapsedMs: number;
  requestId: string | null;
  responseId: string | null;
  outcome: 'completed' | 'incomplete' | 'failed' | 'aborted' | 'discarded';
  status: number | null;
  serviceTier: string | null;
  requestedServiceTier?: string | null;
  meters: TokenMeters;
}
export interface GenerateOptions {
  signal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
  role?: string;
  sessionId?: string;
  /** Local context retains output reasoning and media references alongside the request Items. */
  context?: readonly ContextRecord[];
  nativeSpec?: ModelSpec;
  origin?: ItemOrigin;
}
export interface Generation {
  response: Response;
  origin: ItemOrigin;
  attempts: ProviderAttempt[];
}
export interface ResponseClient {
  respond(request: Request, options?: GenerateOptions): Promise<Generation>;
}
export class GenerationError extends Error {
  constructor(message: string, readonly attempts: ProviderAttempt[], readonly partial: Response | null,
    readonly origin: ItemOrigin, readonly status = 0, readonly body = '', options?: ErrorOptions) {
    super(message, options);
    this.name = 'GenerationError';
  }
}
export function unknownMeters(): TokenMeters {
  return { input: null, output: null, total: null, cachedInput: null, uncachedInput: null, reasoning: null, native: null };
}
export function standardUsage(meters: TokenMeters): Usage | null {
  const { input, output, total, cachedInput, reasoning } = meters;
  if (input === null || output === null || total === null || cachedInput === null || reasoning === null) return null;
  return { input_tokens: input, output_tokens: output, total_tokens: total,
    input_tokens_details: { cached_tokens: cachedInput }, output_tokens_details: { reasoning_tokens: reasoning } };
}
