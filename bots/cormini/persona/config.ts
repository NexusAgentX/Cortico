import type { ConfigGroup } from 'cortico/core/types.ts';

/**
 * 上下文阶段三个裁量(`ContextStagePolicy`)的控制台配置组。归属 `persona`:容量是
 * Persona的参数,core 只持 `hardTokens` 物理钳制与两个策略开关。渲染位置在
 * 「设置 → 运行参数」(`settingsPage: true`),操作员的心智模型里这是系统设置。
 *
 * 每个以 Cormini 为骨架的 bot 各声明一次,`id` 按 bot 取;没有这一组的 bot,这三个数在
 * 控制台上没有位置,只能改 config.json。
 */
export function contextStageConfigGroup(id: string): ConfigGroup {
  return {
    id,
    owner: 'persona',
    settingsPage: true,
    schema: {
      type: 'object',
      title: '上下文与交接',
      // 这些文案进的是纯文本节点(`.tsecdesc` / `.tdesc`),写 Markdown 星号只会原样显示。
      description:
        '一个 session 阶段能装多长、满了怎么交接。'
        + '三个名字长得像,管的是三件事:这里的「交接阈值」是塞满多少就交接;'
        + '「模型窗口」(model.contextWindow)是模型物理上收得下多少,在「设置 → 模型与供应商」,'
        + '交接阈值必须小于它,越过由 core 钳制;「单轮上限」(model.maxTokens)是她一次回答最多生成多少。',
      properties: {
        'context.maxTokens': {
          type: 'integer',
          title: '上下文交接阈值(context.maxTokens)',
          minimum: 8000,
          maximum: 2_000_000,
          multipleOf: 1000,
          'x-suffix': 'tok',
          'x-hot': true,
          description:
            '塞满多少就交接:session 估算长到这么多 token 就交接、进下一阶段。'
            + '调小=交接更频繁、每次丢更多上下文(计划活不长);调大=她记得住更长的一段,但每轮输入更贵。'
            + '不是模型窗口,也不是单轮生成上限——见本组说明。',
        },
        'context.keepRatio': {
          type: 'number',
          title: '交接保留比例',
          minimum: 0.05,
          maximum: 0.9,
          multipleOf: 0.01,
          'x-suffix': '×',
          'x-hot': true,
          description: '交接笔记的预算 = 交接阈值 × 此比例:清空前最近的一段按这个 token 数装进笔记,更早的只留计数。',
        },
        'context.softRatio': {
          type: 'number',
          title: '软阈值比例',
          minimum: 0.1,
          maximum: 1,
          multipleOf: 0.01,
          'x-suffix': '×',
          'x-hot': true,
          description: '超过 交接阈值×此比例 后先提示一轮;那一轮自然结束时才真正交接。',
        },
      },
    },
  };
}
