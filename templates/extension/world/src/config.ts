import type { ConfigGroup } from 'cortico/core/types.ts';

/** config.json 的 `worlds.example` 段。`enabled` 恒为 false:启用与否由 bot 的 declares 与部署决定。 */
export interface ExampleConfigSection {
  enabled: boolean;
  /** `example_echo` 回执的开头一句;热改。 */
  greeting: string;
}

export const EXAMPLE_DEFAULTS: ExampleConfigSection = {
  enabled: false,
  greeting: 'Example says:',
};

/** 本 World 的可调项。一个旋钮是一条 JSON Schema 属性,控制台按它渲染,没有手写表单。 */
export const EXAMPLE_CONFIG_GROUP: ConfigGroup = {
  id: 'world:example',
  owner: 'world:example',
  schema: {
    type: 'object',
    title: 'Example',
    description: '示例 World 的旋钮。',
    properties: {
      'worlds.example.greeting': {
        type: 'string',
        title: '回执开头',
        description: 'example_echo 回执的第一句。',
        'x-hot': true,
      },
    },
  },
};
