import { describe, expect, it } from 'vitest';
import { CORE_DEFAULTS, createCoreConfig } from '../../src/core/config.ts';

describe('programmatic Core configuration', () => {
  it('fills independent defaults without sharing mutable nested objects', () => {
    const first = createCoreConfig({ batching: { quietGapMs: 10 } });
    const second = createCoreConfig();
    first.logging.file = 'error';
    expect(first.batching).toEqual({ ...CORE_DEFAULTS.batching, quietGapMs: 10 });
    expect(second.logging).toEqual(CORE_DEFAULTS.logging);
  });
  it.each([
    { batching: { maxBatchSize: 0 } }, { batching: { quietGapMs: NaN } },
    { batching: { minBatchAgeMs: 20, maxBatchAgeMs: 10 } }, { timezone: 'invalid-zone' },
  ])('rejects invalid runtime configuration %j', options => {
    expect(() => createCoreConfig(options)).toThrow();
  });
});
