/**
 * Data plane of the two llamacpp panels. `runtime` owns the build and the process, `models`
 * is a thin skin over llama-server's `/models*` endpoints; both act on one endpoint by name.
 */
import type { ConsolePageContribution } from '../../../web/shared/console-protocol.ts';
import type { ProviderConsoleHost } from '../../console/types.ts';
import type { RouterCatalog, RouterModel } from '../catalog.ts';
import { LAUNCH_DEFAULTS, PINNED_RELEASE, backendChoices, defaultBackend, llamacppOptions } from '../options.ts';
import type { LlamaRuntime } from '../runtime.ts';
import { text } from '../strings.ts';

interface Control {
  runtime: LlamaRuntime;
  catalog: RouterCatalog;
}

export interface ModelsState {
  name: string;
  reachable: boolean;
  cacheDir: string;
  localModelsDir: string;
  models: RouterModel[];
}

export function llamacppConsole(host: ProviderConsoleHost): Partial<ConsolePageContribution> {
  const S = text(host.language);
  const control = (name: string): Control => host.instance(name).control as Control;
  const body = (args: unknown[]): Record<string, unknown> => {
    const [raw] = args;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(S.bodyRequired);
    const value = raw as Record<string, unknown>;
    if (typeof value.name !== 'string') throw new Error(S.instanceNameRequired);
    return value;
  };
  const entryOf = (name: string) => {
    const found = host.entries().find((entry) => entry.name === name);
    if (!found) throw new Error(S.instanceNameRequired);
    return found.entry;
  };
  return {
    panels: [
      { id: 'runtime', title: S.runtimePanel, description: S.runtimePanelDescription, getMethods: ['state'] },
      { id: 'models', title: S.modelsPanel, description: S.modelsPanelDescription, getMethods: ['state'] },
    ],
    invoke: async (panel, method, args) => {
      if (panel === 'runtime') {
        if (method === 'state')
          return Promise.all(host.entries().map(async ({ name }) => ({ name, ...(await control(name).runtime.state(host.language)) })));
        const value = body(args);
        const name = value.name as string;
        const { runtime } = control(name);
        if (method === 'enable') {
          const entry = entryOf(name);
          const options = llamacppOptions(entry);
          const backend = typeof value.backend === 'string' && backendChoices().includes(value.backend) ? value.backend : defaultBackend();
          host.save(name, {
            ...entry,
            options: {
              ...entry.options,
              runtime: { release: typeof value.release === 'string' && value.release.trim() ? value.release.trim() : PINNED_RELEASE, backend },
              launch: { ...LAUNCH_DEFAULTS, ...(options.launch ?? {}) },
            },
          });
          return { ok: true };
        }
        if (method === 'disable') {
          await runtime.stop(host.language);
          const entry = entryOf(name);
          const { runtime: _runtime, launch: _launch, ...rest } = entry.options ?? {};
          host.save(name, { ...entry, options: rest });
          return { ok: true };
        }
        if (method === 'install') {
          await runtime.install(host.language);
          return { ok: true };
        }
        if (method === 'start') return runtime.start(host.language);
        if (method === 'stop') return runtime.stop(host.language);
        throw new Error(S.unknownMethod);
      }
      if (panel === 'models') {
        if (method === 'state')
          return Promise.all(
            host.entries().map(async ({ name }): Promise<ModelsState> => {
              const { runtime, catalog } = control(name);
              const dirs = runtime.modelDirs();
              try {
                return { name, reachable: true, ...dirs, models: await catalog.list() };
              } catch {
                return { name, reachable: false, ...dirs, models: [] };
              }
            }),
          );
        const value = body(args);
        const { catalog } = control(value.name as string);
        if (method === 'reload') {
          await catalog.list(true);
          return { ok: true };
        }
        if (typeof value.model !== 'string' || !value.model.trim()) throw new Error(S.modelIdRequired);
        const model = value.model.trim();
        if (method === 'pull') await catalog.download(model);
        else if (method === 'load') await catalog.load(model);
        else if (method === 'unload' || method === 'cancel') await catalog.unload(model);
        else throw new Error(S.unknownMethod);
        return { ok: true };
      }
      throw new Error(S.unknownPanel);
    },
  };
}
