import type { TeamConfig, TerminalTarget } from "../team-authority/contracts";
import type { TerminalAdapter } from "./terminal-adapter";
import { terminalTarget } from "./terminal-target";

/** The backend whose pane IDs the untyped legacy field was ever shaped to hold. */
const LEGACY_UNTYPED_BACKEND = "tmux";

/**
 * The Member terminal fields a session start is allowed to refresh. Teams that
 * record a backend write the typed target; only pre-binding Teams still write
 * the untyped legacy field.
 */
export type MemberTerminalUpdate =
  | { terminalTarget: TerminalTarget }
  | { tmuxPaneId: string };

/**
 * Where the current Pi process's terminal surface sits relative to its Team's
 * binding. This is a derived observation of the running process, never durable
 * authority, so it is recomputed at every session start.
 *
 * - `placed`: inside the Team's backend, with a target worth persisting.
 * - `unlocated`: inside the Team's backend, but the backend exposes no target.
 * - `foreign`: a different backend from the one the Team is bound to.
 * - `nested`: the named backend is visible only through an inner carrier.
 */
export type SessionTerminalPlacement =
  | { kind: "placed"; update: MemberTerminalUpdate }
  | { kind: "unlocated" }
  | { kind: "foreign"; expected: string; actual: string | null }
  | { kind: "nested"; backend: string };

/**
 * Observe placement without deciding what to do about it.
 *
 * A backend-bound Team never consults legacy pane environment, so an inherited
 * nested `TMUX_PANE` cannot be mistaken for ownership. A pre-binding Team may
 * still refresh the untyped field, but only from tmux, so this code path can no
 * longer manufacture a record that files a non-tmux pane ID under `tmuxPaneId`.
 */
export function placeSessionTerminal(
  config: Pick<TeamConfig, "name" | "terminalBackend">,
  current: TerminalAdapter | null,
  legacyPaneEnv?: string,
): SessionTerminalPlacement {
  if (!config.terminalBackend) {
    // A tmux pane environment is itself tmux evidence, so it still refreshes the
    // untyped field. Absent that, only a tmux backend may supply the ID, so this
    // path can no longer file a non-tmux pane ID under `tmuxPaneId`.
    const legacyId = legacyPaneEnv
      || (current?.name === LEGACY_UNTYPED_BACKEND ? current.currentTargetId?.() : undefined);
    return legacyId ? { kind: "placed", update: { tmuxPaneId: legacyId } } : { kind: "unlocated" };
  }
  if (!current || current.name !== config.terminalBackend) {
    return { kind: "foreign", expected: config.terminalBackend, actual: current?.name ?? null };
  }
  if (!current.isDirectCarrier()) {
    return { kind: "nested", backend: config.terminalBackend };
  }
  const targetId = current.currentTargetId?.();
  return targetId
    ? { kind: "placed", update: { terminalTarget: terminalTarget(config.terminalBackend, "pane", targetId) } }
    : { kind: "unlocated" };
}

/**
 * How this process learned it belongs to a Team. A launcher sets the teammate
 * environment as a contract it is responsible for honoring; a resumed Session
 * is the operator's own process, recognized from its durable Session file.
 */
export type TeamIdentitySource = "launch_env" | "resumed_session";

/**
 * Whether this process may act as a current Member, and what it may persist.
 * Refusal carries its own remedy text and its own process disposition, so no
 * call site has to decide either.
 */
export type TeamSessionAdmission =
  | { kind: "admitted"; update?: MemberTerminalUpdate }
  | { kind: "refused"; reason: string; exitProcess: boolean };

/**
 * Decide admission from placement alone. A foreign process must not bind: its
 * Membership would then name a terminal surface in a backend the process isn't
 * in, and every later lifecycle operation would target the wrong surface while
 * reporting success.
 */
export function admitTeamSession(
  config: TeamConfig,
  role: string,
  placement: SessionTerminalPlacement,
  identity: TeamIdentitySource,
): TeamSessionAdmission {
  if (placement.kind === "foreign" || placement.kind === "nested") {
    const reason = placement.kind === "foreign"
      ? `Team ${config.name} is bound to terminal backend ${placement.expected}, but this Pi process `
        + `is running in ${placement.actual ?? "no detected terminal backend"}. Refusing to bind ${role}: `
        + "one Team epoch owns terminal surfaces in exactly one backend. Relaunch this process from "
        + `${placement.expected}, or create a separate Team from this terminal.`
      : `Team ${config.name} is bound to terminal backend ${placement.backend}, but this Pi process is `
        + `inside a nested terminal carrier. Refusing to bind ${role}: a Team worker must be directly `
        + `carried by its bound backend. Relaunch it directly from ${placement.backend}.`;
    return {
      kind: "refused",
      reason,
      // A launcher-spawned process that cannot serve its Team has no reason to
      // exist, and leaving it idle hides the launcher bug behind a live pane.
      // A resumed Session is the operator's own terminal, so it degrades to an
      // unbound agent instead of being closed underneath them.
      exitProcess: identity === "launch_env",
    };
  }
  return placement.kind === "placed"
    ? { kind: "admitted", update: placement.update }
    : { kind: "admitted" };
}
