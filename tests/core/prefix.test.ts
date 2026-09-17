import { expect, it } from 'vitest';
import { assembleSystem } from '../../src/core/prefix.ts';
import { makeFakeIO, makeFakePersona } from './helpers.ts';

it('supplies current World descriptions in id order and concatenates only Persona text', async () => {
  const world = makeFakeIO('b', [], 'before');
  const persona = makeFakePersona();
  persona.systemSegments = async ({ worlds }) => worlds.map(world => ({ title: world.id, text: `[${world.envPrompt}]` }));
  const deps = { persona, worlds: [world, makeFakeIO('a', [], 'first')], now: new Date(), timezone: 'UTC' };
  expect(await assembleSystem(deps)).toBe('[first][before]');
  world.environment = async () => 'after';
  expect(await assembleSystem(deps)).toBe('[first][after]');
  persona.systemSegments = async () => [];
  expect(await assembleSystem(deps)).toBe('');
});
