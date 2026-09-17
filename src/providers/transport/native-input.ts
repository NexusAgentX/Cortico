import type { Request } from '../../protocol/open-responses/index.ts';
import { record, type ContextRecord } from '../../protocol/open-responses/context.ts';
import type { GenerateOptions } from '../../core/generation.ts';

export function requestContext(request: Request, options: GenerateOptions): readonly ContextRecord[] {
  if (options.context) return options.context;
  if (typeof request.input === 'string') return [record({ type: 'message', role: 'user', content: request.input })];
  return (request.input ?? []).map(item => record(item));
}
