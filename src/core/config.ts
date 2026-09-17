import { LOG_LEVEL_RANK, type CoreConfig } from './types.ts';

export const CORE_DEFAULTS: CoreConfig = {
  timezone: 'UTC',
  batching: { quietGapMs: 2500, minBatchAgeMs: 0, maxBatchAgeMs: 15000, maxBatchSize: 100 },
  context: { keepPastThinking: true },
  logging: { file: 'debug', console: 'info', areas: '' },
};

export type CoreConfigOptions = {
  timezone?: string;
  batching?: Partial<CoreConfig['batching']>;
  context?: Partial<CoreConfig['context']>;
  logging?: Partial<CoreConfig['logging']>;
};

export function createCoreConfig(options: CoreConfigOptions = {}): CoreConfig {
  const config = { ...CORE_DEFAULTS, ...options,
    batching: { ...CORE_DEFAULTS.batching, ...options.batching },
    context: { ...CORE_DEFAULTS.context, ...options.context },
    logging: { ...CORE_DEFAULTS.logging, ...options.logging },
  };
  new Intl.DateTimeFormat('en', { timeZone: config.timezone });
  for (const [key, value] of Object.entries(config.batching)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid batching.${key}`);
  }
  if (!Number.isInteger(config.batching.maxBatchSize) || config.batching.maxBatchSize < 1)
    throw new Error('batching.maxBatchSize must be a positive integer');
  if (config.batching.minBatchAgeMs > config.batching.maxBatchAgeMs)
    throw new Error('batching.minBatchAgeMs exceeds maxBatchAgeMs');
  if (typeof config.context.keepPastThinking !== 'boolean') throw new Error('Invalid context.keepPastThinking');
  for (const level of [config.logging.file, config.logging.console]) {
    if (!(level in LOG_LEVEL_RANK)) throw new Error('Invalid logging level');
  }
  return config;
}
