import { afterEach, describe, expect, it } from 'vitest';
import { fixtureWorld, mountSettings, change, button, flush } from './provider-settings-fixture.ts';
let cleanup: () => void = () => {};
afterEach(() => cleanup());
describe('Provider 模型档编辑', () => {
  it('未指定温度显示空值，0 保留为显式温度；保存前只修改草稿', async () => {
    const view = await mountSettings();
    cleanup = view.cleanup;
    const temperature = view.root.querySelector('[aria-label="温度"]');
    expect(temperature.value).toBe('');
    change(temperature, '0');
    expect(view.cfg.providers.primary.spec!.temperature).toBeUndefined();
    expect(view.guard()).toBeTruthy();
    button(view.root, '保存').click();
    await flush();
    expect(view.read().providers.primary.spec.temperature).toBe(0);
    expect(view.guard()).toBeNull();
  });
  it('清空温度移除字段，同时保存模型、推理档与输出上限', async () => {
    const view = await mountSettings(
      undefined,
      {},
      { model: 'fixture-flash', thinking: false, temperature: 1.2 },
    );
    cleanup = view.cleanup;
    change(view.root.querySelector('[aria-label="温度"]'), '');
    change(view.root.querySelector('[aria-label="模型"]'), 'fixture-pro');
    change(view.root.querySelector('[aria-label="推理档位"]'), 'high');
    change(view.root.querySelector('[aria-label="最大输出 token"]'), '2048');
    button(view.root, '保存').click();
    await flush();
    expect(view.read().providers.primary.spec).toEqual({
      model: 'fixture-pro',
      thinking: true,
      reasoningEffort: 'high',
      maxTokens: 2048,
    });
  });
  it('无效温度拒绝整个保存，保留草稿和原配置', async () => {
    const view = await mountSettings();
    cleanup = view.cleanup;
    change(view.root.querySelector('[aria-label="温度"]'), '3');
    change(view.root.querySelector('[aria-label="模型"]'), 'changed');
    button(view.root, '保存').click();
    await flush();
    expect(view.cfg.providers.primary.spec!.model).toBe('fixture-pro');
    expect(view.guard()).toBeTruthy();
    expect(view.root.textContent).toContain('temperature 必须在');
  });
  it('展示模块声明的温度限制', async () => {
    const view = await mountSettings();
    cleanup = view.cleanup;
    expect(view.root.textContent).toContain(fixtureWorld.temperatureNote);
  });
});
