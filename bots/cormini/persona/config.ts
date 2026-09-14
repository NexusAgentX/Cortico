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
      description:
        '模型窗口与单次输出上限在「语言模型」页配置。上下文达到模型硬限制时由 Core 强制交接。',
      properties: {
        'context.maxTokens': {
          type: 'integer',
          title: '上下文阶段预算',
          minimum: 8000,
          maximum: 2_000_000,
          multipleOf: 1000,
          'x-suffix': 'tok',
          'x-hot': true,
          description:
            '上下文超过阶段预算 × 软阈值比例时先提示；下一批结束时仍超出则交接。',
        },
        'context.keepRatio': {
          type: 'number',
          title: '交接保留比例',
          minimum: 0.05,
          maximum: 0.9,
          multipleOf: 0.01,
          'x-suffix': '×',
          'x-hot': true,
          description: '交接笔记的 token 预算 = 阶段预算 × 此比例。笔记保留最近内容，更早的部分只留计数。',
        },
        'context.softRatio': {
          type: 'number',
          title: '软阈值比例',
          minimum: 0.1,
          maximum: 1,
          multipleOf: 0.01,
          'x-suffix': '×',
          'x-hot': true,
          description: '上下文预警阈值 = 阶段预算 × 此比例。',
        },
      },
    },
  };
}
