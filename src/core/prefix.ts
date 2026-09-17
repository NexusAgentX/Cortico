/** Persona owns the system text; Core supplies the mounted Worlds in stable id order. */
import type { World, Persona, PrefixSegment, WorldPrefixContext } from './types.ts';

export interface AssembleSystemDeps {
  persona: Persona;
  worlds: World[];
  now: Date;
  timezone: string;
}

export async function collectWorldContexts(worlds: World[]): Promise<WorldPrefixContext[]> {
  return Promise.all([...worlds].sort((a, b) => a.id.localeCompare(b.id)).map(async world => ({
    id: world.id, envPrompt: await world.environment(),
  })));
}

export async function assembleSystemSegments(deps: AssembleSystemDeps): Promise<PrefixSegment[]> {
  return deps.persona.systemSegments({ now: deps.now, timezone: deps.timezone,
    worlds: await collectWorldContexts(deps.worlds) });
}

export async function assembleSystem(deps: AssembleSystemDeps): Promise<string> {
  return (await assembleSystemSegments(deps)).map(segment => segment.text).join('');
}
