import type { ModelSpec } from '../core/types.ts';
import type { ContextRecord } from '../protocol/open-responses/context.ts';
import type { Request } from '../protocol/open-responses/index.ts';
import type { GenerateOptions, Generation, GenerationError, ResponseClient } from '../core/generation.ts';

/** A caller-owned model client, shared by all sessions in one Core. */
export interface Provider extends ResponseClient {
  contextWindow?(model: string): number | undefined;
  accepts?(mime: string): boolean;
  estimateTokens?(records: readonly ContextRecord[], spec: ModelSpec): number;
  contextOverflow?(error: GenerationError): boolean;
}

export abstract class BaseProvider implements Provider {
  abstract respond(request: Request, options?: GenerateOptions): Promise<Generation>;
}
