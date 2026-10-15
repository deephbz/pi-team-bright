import { hostEnv } from "../env/host-env";
import { getAdapterByName, getTerminalAdapter, getTerminalAdapterAsync } from "../adapters/terminal-registry";
import type { TeamConfig, TerminalTarget } from "../team-authority/contracts";
import type { TerminalAdapter } from "./terminal-adapter";
import { hasPersistedTerminalTarget } from "./terminal-target";

/**
 * Resolve lifecycle operations from durable Team authority. Detection is a
 * compatibility fallback only for Team records created before terminalBackend
 * existed; persisted Teams never switch because the current environment did.
 */
export async function terminalForTeamAsync(config: TeamConfig): Promise<TerminalAdapter> {
  if (config.terminalBackend || config.members.some(hasPersistedTerminalTarget)) return terminalForTeam(config);
  const detected = await getTerminalAdapterAsync();
  return terminalForTeam(config, () => detected);
}

export async function currentTerminalForTeamAsync(config: TeamConfig): Promise<TerminalAdapter> {
  if (config.terminalBackend === "herdr") return currentTerminalForTeam(config);
  // Resolve persisted authority before ambient detection, including corrupt legacy records.
  if (config.terminalBackend || config.members.some(hasPersistedTerminalTarget)) terminalForTeam(config);
  const detected = await getTerminalAdapterAsync();
  return currentTerminalForTeam(config, () => detected);
}

export function terminalForTeam(config: TeamConfig, detect = getTerminalAdapter): TerminalAdapter {
  if (!config.terminalBackend) {
    if (config.members.some(hasPersistedTerminalTarget)) {
      throw new Error(`Team ${config.name} has terminal targets but predates terminalBackend; refusing ambient backend dispatch. Stop the Team and migrate or recreate it with the current PiTeams version.`);
    }
    const legacy = detect();
    if (!legacy) {
      throw new Error(`Team ${config.name} predates terminalBackend and no terminal adapter is available; stop and recreate the Team with the current PiTeams version.`);
    }
    return legacy;
  }
  const terminal = getAdapterByName(config.terminalBackend);
  if (!terminal) {
    throw new Error(`Team ${config.name} requires terminal backend ${config.terminalBackend}, but this PiTeams version doesn't register it.`);
  }
  for (const member of config.members) {
    if (member.isActive !== false && member.terminalTarget) {
      assertTargetSupportedByTerminal(terminal, member.terminalTarget);
    }
  }
  return terminal;
}

/** Spawning/resume needs the process to be inside the Team's selected backend. */
export function currentTerminalForTeam(config: TeamConfig, detect = getTerminalAdapter): TerminalAdapter {
  const terminal = terminalForTeam(config, detect);
  if (!config.terminalBackend) return terminal;
  if (config.terminalBackend === "herdr") {
    const env = hostEnv().process.env;
    if (env.HERDR_ENV !== "1" || !env.HERDR_PANE_ID || !env.HERDR_TAB_ID || !terminal.isDirectCarrier()) throw new Error("Herdr launch requires a direct pane-local Team carrier.");
    // Bounded async placement proves the target. No synchronous server detection precedes it.
    return terminal;
  }
  const current = detect();
  if (!current || current.name !== config.terminalBackend) {
    throw new Error(`Team ${config.name} is bound to ${config.terminalBackend}, but this Pi process is running in ${current?.name || "no detected terminal backend"}; refusing to mix terminal backends in one Team epoch.`);
  }
  if (!current.isDirectCarrier()) {
    throw new Error(`Team ${config.name} is bound to ${config.terminalBackend}, but this Pi process is inside a nested terminal carrier; workers must be launched directly by the Team backend.`);
  }
  return terminal;
}

/** Reject a corrupt target that asks a pane-only backend to stop a window. */
export function assertTargetSupportedByTerminal(terminal: TerminalAdapter, target: TerminalTarget): void {
  if (target.kind === "window" && !terminal.supportsWindows()) {
    throw new Error(`Terminal target ${target.targetId} is a window, but Team backend ${terminal.name} doesn't support windows; refusing lifecycle operation.`);
  }
}

export function detectedTerminalOrThrow(): TerminalAdapter {
  const terminal = getTerminalAdapter();
  if (!terminal) throw new Error("No terminal adapter detected.");
  return terminal;
}
