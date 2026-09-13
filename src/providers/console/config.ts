import type { ConfigGroup, ConfigProperty } from '../../core/config-schema.ts';
import type { LLMProviderEntry } from '../../core/types.ts';
import type { Language } from '../../core/language.ts';
import { text } from './strings.ts';

/** Modules that pass no `language` keep their Chinese titles. */
export function connectionGroup(
  name: string,
  entry: LLMProviderEntry,
  fields: Record<string, ConfigProperty> = {},
  language: Language = 'zh',
): ConfigGroup {
  const S = text(language);
  const prefix = `providers.${name}.`;
  return {
    id: `llm.${entry.kind}.${name}`,
    owner: `provider:${entry.kind}`,
    schema: {
      type: 'object',
      title: name,
      description: S.connectionDescription,
      properties: Object.fromEntries(
        Object.entries({
          baseUrl: { type: 'string', title: S.baseUrl, 'x-hot': true },
          secret: {
            type: 'string',
            title: S.secret,
            'x-hot': true,
            description: S.secretDescription,
          },
          multimodal: { type: 'boolean', title: S.multimodal, 'x-hot': true },
          ...fields,
        } satisfies Record<string, ConfigProperty>).map(([path, schema]) => [
          prefix + path,
          schema,
        ]),
      ),
    },
  };
}
