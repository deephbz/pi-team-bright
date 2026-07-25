import type { Member, TeamConfig, TerminalTarget } from "./models";

function validTarget(value: unknown): value is TerminalTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Partial<TerminalTarget>;
  return typeof target.backend === "string" && !!target.backend
    && (target.kind === "pane" || target.kind === "window")
    && typeof target.targetId === "string" && !!target.targetId;
}

/** Validate the persisted shape without inferring backend ownership from an ID. */
export function assertTerminalTargetShape(value: unknown, context: string): asserts value is TerminalTarget {
  if (!validTarget(value)) {
    throw new Error(`${context} must contain a non-empty backend, pane/window kind, and targetId.`);
  }
}

export function terminalTarget(backend: string, kind: TerminalTarget["kind"], targetId: string): TerminalTarget {
  const target = { backend, kind, targetId };
  assertTerminalTargetShape(target, "Terminal target");
  return target;
}

/**
 * Read a Member target. Legacy fields remain readable only when the Team or
 * caller already supplies the owning backend; target prefixes are never used
 * as backend evidence.
 */
export function memberTerminalTarget(member: Member, teamBackend?: string): TerminalTarget | undefined {
  if (member.terminalTarget) return { ...member.terminalTarget };
  if (!teamBackend) return undefined;
  if (member.windowId) return terminalTarget(teamBackend, "window", member.windowId);
  if (member.tmuxPaneId) return terminalTarget(teamBackend, "pane", member.tmuxPaneId);
  return undefined;
}

export function assertTeamTerminalTarget(config: TeamConfig, member: Member): TerminalTarget | undefined {
  const target = memberTerminalTarget(member, config.terminalBackend);
  if (!target) return undefined;
  if (!config.terminalBackend) {
    throw new Error(`Team ${config.name} has a terminal target for ${member.name} but no terminalBackend; stop the Team and migrate its terminal binding before lifecycle operations.`);
  }
  if (target.backend !== config.terminalBackend) {
    throw new Error(`Terminal target for ${member.name} uses ${target.backend}, but Team ${config.name} is bound to ${config.terminalBackend}; refusing a cross-backend lifecycle operation.`);
  }
  return target;
}

export function hasPersistedTerminalTarget(member: Member): boolean {
  return !!(member.terminalTarget || member.tmuxPaneId || member.windowId);
}
