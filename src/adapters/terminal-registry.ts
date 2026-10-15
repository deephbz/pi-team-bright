import { hostEnv, type HostEnv } from "../env/host-env";
import type { SynchronousTerminalAdapter, TerminalAdapter, SpawnOptions } from "../utils/terminal-adapter";
import { HerdrAdapter } from "./herdr-adapter";
import { TmuxAdapter } from "./tmux-adapter";
import { ZellijAdapter } from "./zellij-adapter";
import { CmuxAdapter } from "./cmux-adapter";
import { Iterm2Adapter } from "./iterm2-adapter";
import { WezTermAdapter } from "./wezterm-adapter";
import { WindowsAdapter } from "./windows-adapter";

/**
 * Preserve one-stage backends: their process starts during prepare. Target CAS
 * fences Herdr launches only. These Promise methods do not make synchronous
 * backend internals nonblocking.
 */
function normalize(backend: SynchronousTerminalAdapter): TerminalAdapter {
  function prepare(options: SpawnOptions): void {
    if (backend instanceof Iterm2Adapter) {
      const last = options.panePlacement?.workerPaneIds.at(-1);
      backend.setSpawnContext(last?.startsWith("iterm_") ? { lastSessionId: last.replace("iterm_", "") } : {});
    }
  }
  return {
    name: backend.name,
    currentTargetId: () => backend.currentTargetId?.() ?? null,
    isDirectCarrier: () => backend.isDirectCarrier(),
    detect: async () => backend.detect(),
    renamePane: async (id, label) => { backend.renamePane?.(id, label); },
    prepareSpawn: async options => { prepare(options); return backend.spawn(options); },
    prepareWindow: async options => { prepare(options); return backend.spawnWindow(options); },
    startPrepared: async () => ({ state: "started", fact: "carrier_start_accepted" }),
    kill: async id => backend.kill(id),
    isAlive: async id => backend.isAlive(id),
    setTitle: title => backend.setTitle(title),
    supportsWindows: () => backend.supportsWindows(),
    killWindow: async id => backend.killWindow(id),
    isWindowAlive: async id => backend.isWindowAlive(id),
  };
}

const actorAdapters = new WeakMap<HostEnv, TerminalAdapter[]>();
function adapters(): TerminalAdapter[] {
  const env = hostEnv();
  const existing = actorAdapters.get(env);
  if (existing) return existing;
  // Pane-local Herdr identity wins over inherited nested tmux variables.
  const created = [new HerdrAdapter(), ...[
    new TmuxAdapter(), new ZellijAdapter(), new CmuxAdapter(),
    new Iterm2Adapter(), new WezTermAdapter(), new WindowsAdapter(),
  ].map(normalize)];
  actorAdapters.set(env, created);
  return created;
}

const cachedAdapters = new WeakMap<HostEnv, TerminalAdapter>();
const pendingAdapters = new WeakMap<HostEnv, Promise<TerminalAdapter | null>>();

/** Coalesce cold detection. Cache only positive evidence within this host. */
export async function getTerminalAdapter(): Promise<TerminalAdapter | null> {
  const env = hostEnv();
  const cached = cachedAdapters.get(env);
  if (cached) return cached;
  const pending = pendingAdapters.get(env);
  if (pending) return pending;
  const read = Promise.resolve().then(async () => {
    for (const adapter of adapters()) {
      if (await adapter.detect()) {
        if (pendingAdapters.get(env) === read) cachedAdapters.set(env, adapter);
        return adapter;
      }
    }
    return null;
  });
  pendingAdapters.set(env, read);
  try { return await read; }
  finally { if (pendingAdapters.get(env) === read) pendingAdapters.delete(env); }
}

/** Resolve persisted backend authority without ambient detection. */
export function getAdapterByName(name: string): TerminalAdapter | undefined {
  const cachedAdapter = cachedAdapters.get(hostEnv());
  if (cachedAdapter?.name === name) return cachedAdapter;
  return adapters().find(a => a.name === name);
}

export function clearAdapterCache(): void {
  pendingAdapters.delete(hostEnv());
  cachedAdapters.delete(hostEnv());
}

export function setAdapter(adapter: TerminalAdapter): void {
  pendingAdapters.delete(hostEnv());
  cachedAdapters.set(hostEnv(), adapter);
}
