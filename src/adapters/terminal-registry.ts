/**
 * Terminal Registry
 *
 * Manages terminal adapters and provides automatic selection based on
 * the current environment.
 */

import { hostEnv, type HostEnv } from "../env/host-env";
import { TerminalAdapter } from "../utils/terminal-adapter";
import { HerdrAdapter } from "./herdr-adapter";
import { TmuxAdapter } from "./tmux-adapter";
import { ZellijAdapter } from "./zellij-adapter";
import { CmuxAdapter } from "./cmux-adapter";
import { Iterm2Adapter } from "./iterm2-adapter";
import { WezTermAdapter } from "./wezterm-adapter";
import { WindowsAdapter } from "./windows-adapter";

/**
 * Available terminal adapters, ordered by priority
 *
 * Detection order (first match wins):
 * 1. Herdr - if this process has a live Herdr pane identity
 * 2. tmux - if TMUX env is set
 * 3. Zellij - if ZELLIJ env is set and not in tmux
 * 4. cmux - if CMUX_SOCKET_PATH or CMUX_WORKSPACE_ID env is set
 * 5. iTerm2 - if TERM_PROGRAM=iTerm.app and not in tmux/zellij/cmux
 * 6. WezTerm - if WEZTERM_PANE env is set and not in tmux/zellij/cmux
 * 7. Windows - if platform is win32 and not in tmux/zellij/cmux/iTerm2/WezTerm
 */
const actorAdapters = new WeakMap<HostEnv, TerminalAdapter[]>();

function adapters(): TerminalAdapter[] {
  const env = hostEnv();
  const existing = actorAdapters.get(env);
  if (existing) return existing;
  const created: TerminalAdapter[] = [
    // Herdr can intentionally carry nested TMUX variables, so pane-local Herdr
    // identity must win before tmux detection.
    new HerdrAdapter(),
    new TmuxAdapter(),
    new ZellijAdapter(),
    new CmuxAdapter(),
    new Iterm2Adapter(),
    new WezTermAdapter(),
    new WindowsAdapter(),
  ];
  actorAdapters.set(env, created);
  return created;
}

/**
 * Cached detected adapter per actor
 */
const cachedAdapters = new WeakMap<HostEnv, TerminalAdapter>();
const pendingAdapters = new WeakMap<HostEnv, Promise<TerminalAdapter | null>>();

/** Coalesce cold detection without blocking Herdr callers. Cache only positive evidence. */
export async function getTerminalAdapterAsync(): Promise<TerminalAdapter | null> {
  const env = hostEnv();
  const cached = cachedAdapters.get(env);
  if (cached) return cached;
  const pending = pendingAdapters.get(env);
  if (pending) return pending;
  const read = Promise.resolve().then(async () => {
    for (const adapter of adapters()) {
      if (await (adapter.detectAsync ? adapter.detectAsync() : adapter.detect())) {
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

/**
 * Detect and return the appropriate terminal adapter for the current environment.
 *
 * Detection order (first match wins): Herdr, tmux, Zellij, cmux, iTerm2,
 * WezTerm, then Windows. Herdr deliberately wins over inherited nested tmux
 * identity.
 *
 * @returns The detected terminal adapter, or null if none detected
 */
export function getTerminalAdapter(): TerminalAdapter | null {
  const env = hostEnv();
  const cachedAdapter = cachedAdapters.get(env);
  if (cachedAdapter) return cachedAdapter;

  for (const adapter of adapters()) {
    if (adapter.detect()) {
      cachedAdapters.set(env, adapter);
      return adapter;
    }
  }

  return null;
}

/**
 * Get a specific terminal adapter by name.
 *
 * @param name - The adapter name (e.g., "tmux", "zellij", "cmux", "iTerm2", "WezTerm", "Windows")
 * @returns The adapter instance, or undefined if not found
 */
export function getAdapterByName(name: string): TerminalAdapter | undefined {
  const cachedAdapter = cachedAdapters.get(hostEnv());
  if (cachedAdapter?.name === name) return cachedAdapter;
  return adapters().find(a => a.name === name);
}

/**
 * Get all available adapters.
 *
 * @returns Array of all registered adapters
 */
export function getAllAdapters(): TerminalAdapter[] {
  return [...adapters()];
}

/**
 * Clear the cached adapter (useful for testing or environment changes)
 */
export function clearAdapterCache(): void {
  pendingAdapters.delete(hostEnv());
  cachedAdapters.delete(hostEnv());
}

/**
 * Set a specific adapter (useful for testing or forced selection)
 */
export function setAdapter(adapter: TerminalAdapter): void {
  pendingAdapters.delete(hostEnv());
  cachedAdapters.set(hostEnv(), adapter);
}

/**
 * Check if any terminal adapter is available.
 *
 * @returns true if a terminal adapter was detected
 */
export function hasTerminalAdapter(): boolean {
  return getTerminalAdapter() !== null;
}

/**
 * Check if the current terminal supports spawning separate OS windows.
 *
 * @returns true if the detected terminal supports windows (iTerm2, WezTerm, Windows, cmux)
 */
export function supportsWindows(): boolean {
  const adapter = getTerminalAdapter();
  return adapter?.supportsWindows() ?? false;
}

/**
 * Get the name of the currently detected terminal adapter.
 *
 * @returns The adapter name, or null if none detected
 */
export function getTerminalName(): string | null {
  return getTerminalAdapter()?.name ?? null;
}