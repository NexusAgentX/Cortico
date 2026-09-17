import type { ModelSpec, ToolSchema } from '../../src/core/types.ts';
import type { Request } from '../../src/protocol/open-responses/index.ts';
import type { GenerateOptions } from '../../src/core/generation.ts';
export function requestSpec(request: Request, options: GenerateOptions): ModelSpec {
  return { ...options.nativeSpec, model: request.model ?? options.nativeSpec?.model ?? '',
    thinking: options.nativeSpec?.thinking ?? request.reasoning?.effort !== 'none',
    ...(request.reasoning?.effort && request.reasoning.effort !== 'none' ? { reasoningEffort: request.reasoning.effort } : {}),
    ...(options.nativeSpec?.reasoningEffort === 'max' ? { reasoningEffort: 'max' } : {}),
    ...(request.temperature != null ? { temperature: request.temperature } : {}),
    ...(request.max_output_tokens != null ? { maxTokens: request.max_output_tokens } : {}),
  };
}

export function requestTools(request: Request): ToolSchema[] | undefined {
  return request.tools?.map(tool => ({ name: tool.name, description: tool.description ?? '', parameters: tool.parameters ?? {} }));
}
