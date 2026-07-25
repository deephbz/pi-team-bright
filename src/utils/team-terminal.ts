import { getAdapterByName, getTerminalAdapter } from "../adapters/terminal-registry";
import type { TeamConfig, TerminalTarget } from "./models";
import type { TerminalAdapter } from "./terminal-adapter";
import { hasPersistedTerminalTarget } from "./terminal-target";

/**
 * Resolve lifecycle operations from durable Team authority. Detection is a
 * compatibility fallback only for Team records created before terminalBackend
 * existed; persisted Teams never switch because the current environment did.
 */
export function terminalForTeam(config: TeamConfig): TerminalAdapter {
  if (!config.terminalBackend) {
    if (config.members.some(hasPersistedTerminalTarget)) {
      throw new Error(`Team ${config.name} has terminal targets but predates terminalBackend; refusing ambient backend dispatch. Stop the Team and migrate or recreate it with the current PiTeams version.`);
    }
    const legacy = getTerminalAdapter();
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
export function currentTerminalForTeam(config: TeamConfig): TerminalAdapter {
  const terminal = terminalForTeam(config);
  if (!config.terminalBackend) return terminal;
  const current = getTerminalAdapter();
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
