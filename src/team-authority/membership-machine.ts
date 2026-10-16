import type { Member, TerminalTarget } from "./contracts";

/**
 * The durable Membership lifecycle as one total state machine.
 *
 * `parseMembership` reads every persisted Member shape. `transitionMembership`
 * is the only writer of the lifecycle fields: it returns the next state and the
 * exact field patch. The on-disk Member schema does not change. Process and
 * terminal evidence stay outside the machine; events carry the evidence that a
 * guard needs.
 */

export type LaunchPhase = "requested" | "started" | "refused" | "unknown";
export type DeactivationReason = NonNullable<Member["deactivationReason"]>;
export type PriorGeneration = NonNullable<NonNullable<Member["launch"]>["priorGeneration"]>;
export interface LaunchFence {
  launchId: string;
  phase: LaunchPhase;
  requestedAt: number;
  observedAt?: number;
  fact?: string;
  prior?: PriorGeneration;
}
/** A recorded carrier location. Legacy pane or window fields count as a target. */
export type MembershipTarget = TerminalTarget | "legacy";

export type InvalidMembershipReason =
  | "missing_membership_id"
  | "both_session_and_pending_launch"
  | "missing_session_and_pending_launch";

export type MembershipState =
  | { kind: "inactive"; reason?: DeactivationReason }
  | { kind: "invalid"; reason: InvalidMembershipReason }
  /** Unbound. `capability` is the single-use pendingLaunchId; old records may lack `launch`. */
  | { kind: "prepared"; capability: string; launch?: LaunchFence; target?: MembershipTarget }
  | { kind: "bound"; sessionFile: string; launch?: LaunchFence; target?: MembershipTarget };

/**
 * How the Team's terminal backend starts a process. A two-stage backend (Herdr)
 * records the target before it starts the process. A one-stage backend starts
 * the process inside prepare, before the target write.
 */
export type CarrierLaunchKind = "two_stage" | "one_stage";

/** Evidence that authorizes deactivation of a Membership that may own a process. */
export type StopAuthority =
  /** The terminal stopped the target, or exact runtime evidence proves exit. */
  | "process_stopped"
  /** Durable state proves no process (see mayOwnProcess); the shell found no exact runtime record. */
  | "no_process_possible"
  /** The Pi session itself left this Membership (new, resume, fork). */
  | "session_left";

export type MembershipEvent =
  | { type: "relaunch"; launchId: string; at: number; prior?: PriorGeneration; carrier: CarrierLaunchKind }
  | { type: "record_target"; launchId: string; target: TerminalTarget }
  /** `refused` asserts that no process started for this launch: the carrier refused, or the launch failed before any carrier effect. */
  | { type: "complete_launch"; launchId: string; result: { state: Exclude<LaunchPhase, "requested">; fact: string }; at: number; target?: TerminalTarget }
  | { type: "bind_session"; sessionFile: string; launchId?: string; at: number; placement?: MemberPlacement }
  | { type: "relocate"; placement: MemberPlacement }
  | { type: "deactivate"; reason: DeactivationReason; at: number; authority: StopAuthority; carrier: CarrierLaunchKind };

/** Placement facts that Session admission may refresh. */
export type MemberPlacement = Pick<Partial<Member>, "terminalTarget" | "tmuxPaneId" | "windowId">;

export type MembershipRefusal =
  | "not_current"
  | "invalid_membership"
  | "superseded_launch"
  | "launch_in_flight"
  | "launch_capability_mismatch"
  | "launch_capability_consumed"
  | "session_conflict"
  | "process_may_exist";

/** Lifecycle fields only. `undefined` deletes a field. */
export type MembershipPatch = Partial<Pick<Member,
  "pendingLaunchId" | "launch" | "sessionFile" | "launchConsumedAt" | "terminalTarget" | "tmuxPaneId" | "windowId"
  | "isActive" | "deactivatedAt" | "deactivationReason">>;

export type MembershipTransition =
  | { kind: "applied"; state: MembershipState; patch: MembershipPatch }
  | { kind: "unchanged"; state: MembershipState }
  | { kind: "refused"; state: MembershipState; reason: MembershipRefusal };

/** A prepared launch without a recorded target is retryable after this age. */
export const UNSTARTED_LAUNCH_RETRY_MS = 15000;

function targetOf(member: Member): MembershipTarget | undefined {
  if (member.terminalTarget) return member.terminalTarget;
  return member.tmuxPaneId || member.windowId ? "legacy" : undefined;
}

function launchOf(member: Member): LaunchFence | undefined {
  const launch = member.launch;
  if (!launch) return undefined;
  return {
    launchId: launch.launchId, phase: launch.state, requestedAt: launch.requestedAt,
    ...(launch.observedAt !== undefined ? { observedAt: launch.observedAt } : {}),
    ...(launch.fact !== undefined ? { fact: launch.fact } : {}),
    ...(launch.priorGeneration ? { prior: launch.priorGeneration } : {}),
  };
}

function launchRecord(fence: LaunchFence): NonNullable<Member["launch"]> {
  return {
    launchId: fence.launchId, state: fence.phase, requestedAt: fence.requestedAt,
    ...(fence.observedAt !== undefined ? { observedAt: fence.observedAt } : {}),
    ...(fence.prior ? { priorGeneration: fence.prior } : {}),
    ...(fence.fact !== undefined ? { fact: fence.fact } : {}),
  };
}

/** Total over every persisted shape. An absent Member is not a state; callers handle it. */
export function parseMembership(member: Member): MembershipState {
  if (member.isActive === false) return { kind: "inactive", ...(member.deactivationReason ? { reason: member.deactivationReason } : {}) };
  if (!member.membershipId) return { kind: "invalid", reason: "missing_membership_id" };
  if (member.sessionFile && member.pendingLaunchId) return { kind: "invalid", reason: "both_session_and_pending_launch" };
  const launch = launchOf(member);
  const target = targetOf(member);
  if (member.sessionFile) return { kind: "bound", sessionFile: member.sessionFile, ...(launch ? { launch } : {}), ...(target ? { target } : {}) };
  if (member.pendingLaunchId) return { kind: "prepared", capability: member.pendingLaunchId, ...(launch ? { launch } : {}), ...(target ? { target } : {}) };
  return { kind: "invalid", reason: "missing_session_and_pending_launch" };
}

/** The recorded launch fence, if the state has one. */
export function launchFence(state: MembershipState): LaunchFence | undefined {
  return state.kind === "prepared" || state.kind === "bound" ? state.launch : undefined;
}

/** The current launch of an active Membership; old prepared records fall back to the capability. */
export function currentLaunchId(state: MembershipState): string | undefined {
  if (state.kind === "prepared") return state.launch?.launchId ?? state.capability;
  if (state.kind === "bound") return state.launch?.launchId;
  return undefined;
}

/**
 * Whether a process for this Membership can exist, judged from durable state.
 * A prepared launch refused without a target never reached a carrier effect.
 * A two-stage carrier records the target before it starts a process. That
 * ordering arrived with the `launch` record (14d4694), so a prepared record
 * without `launch` has unknown ordering and stays fail-closed.
 */
export function mayOwnProcess(state: MembershipState, carrier: CarrierLaunchKind): boolean {
  switch (state.kind) {
    case "inactive": return false;
    case "invalid": return true;
    case "prepared":
      if (state.target !== undefined || state.launch === undefined) return true;
      return state.launch.phase !== "refused" && carrier === "one_stage";
    case "bound": return true;
  }
}

/** A two-stage prepared launch that never recorded a target and is older than the retry window. */
export function unstartedLaunchExpired(state: MembershipState, now: number, carrier: CarrierLaunchKind): boolean {
  return carrier === "two_stage" && state.kind === "prepared" && state.target === undefined && state.launch !== undefined
    && (state.launch.phase === "requested" || state.launch.phase === "unknown")
    && now - state.launch.requestedAt >= UNSTARTED_LAUNCH_RETRY_MS;
}

function refuse(state: MembershipState, reason: MembershipRefusal): MembershipTransition {
  return { kind: "refused", state, reason };
}

function placementTarget(placement: MemberPlacement, prior: MembershipTarget | undefined): MembershipTarget | undefined {
  if (placement.terminalTarget) return placement.terminalTarget;
  if (placement.tmuxPaneId || placement.windowId) return prior && prior !== "legacy" ? prior : "legacy";
  return prior;
}

function placementPatch(placement: MemberPlacement | undefined): MembershipPatch {
  if (!placement) return {};
  return {
    ...(placement.terminalTarget ? { terminalTarget: placement.terminalTarget } : {}),
    ...(placement.tmuxPaneId ? { tmuxPaneId: placement.tmuxPaneId } : {}),
    ...(placement.windowId ? { windowId: placement.windowId } : {}),
  };
}

export function transitionMembership(state: MembershipState, event: MembershipEvent): MembershipTransition {
  if (state.kind === "inactive") return refuse(state, "not_current");
  if (state.kind === "invalid") {
    if (event.type === "deactivate" && event.authority !== "no_process_possible") return deactivate(state, event);
    return refuse(state, "invalid_membership");
  }
  switch (event.type) {
    case "relaunch": {
      const prior = event.prior ? { prior: event.prior } : {};
      const launch: LaunchFence = { launchId: event.launchId, phase: "requested", requestedAt: event.at, ...prior };
      if (state.kind === "prepared") {
        // A first-binding retry replaces a launch only when no process can own it.
        const phase = state.launch?.phase ?? "unknown";
        if (phase !== "refused" && !unstartedLaunchExpired(state, event.at, event.carrier)) return refuse(state, "launch_in_flight");
        return { kind: "applied", state: { ...state, capability: event.launchId, launch }, patch: { pendingLaunchId: event.launchId, launch: launchRecord(launch) } };
      }
      return { kind: "applied", state: { ...state, launch }, patch: { launch: launchRecord(launch) } };
    }
    case "record_target": {
      if (currentLaunchId(state) !== event.launchId) return refuse(state, "superseded_launch");
      return { kind: "applied", state: { ...state, target: event.target }, patch: { terminalTarget: event.target } };
    }
    case "complete_launch": {
      // A completion for any other launch is stale evidence; it never changes state.
      if (!state.launch || state.launch.launchId !== event.launchId) return { kind: "unchanged", state };
      const launch: LaunchFence = { ...state.launch, phase: event.result.state, fact: event.result.fact, observedAt: event.at };
      const target = event.target ?? state.target;
      return {
        kind: "applied",
        state: { ...state, launch, ...(target ? { target } : {}) },
        patch: { launch: launchRecord(launch), ...(event.target ? { terminalTarget: event.target } : {}) },
      };
    }
    case "bind_session": {
      const placement = placementPatch(event.placement);
      if (state.kind === "bound") {
        if (event.launchId) return refuse(state, "launch_capability_consumed");
        if (state.sessionFile !== event.sessionFile) return refuse(state, "session_conflict");
        const target = event.placement ? placementTarget(event.placement, state.target) : state.target;
        return { kind: "applied", state: { ...state, ...(target ? { target } : {}) }, patch: placement };
      }
      if (!event.launchId || event.launchId !== state.capability) return refuse(state, "launch_capability_mismatch");
      const target = event.placement ? placementTarget(event.placement, state.target) : state.target;
      return {
        kind: "applied",
        state: { kind: "bound", sessionFile: event.sessionFile, ...(state.launch ? { launch: state.launch } : {}), ...(target ? { target } : {}) },
        patch: { sessionFile: event.sessionFile, pendingLaunchId: undefined, launchConsumedAt: new Date(event.at).toISOString(), ...placement },
      };
    }
    case "relocate": {
      const target = placementTarget(event.placement, state.target);
      return { kind: "applied", state: { ...state, ...(target ? { target } : {}) }, patch: placementPatch(event.placement) };
    }
    case "deactivate":
      if (event.authority === "no_process_possible" && mayOwnProcess(state, event.carrier)) return refuse(state, "process_may_exist");
      return deactivate(state, event);
  }
}

function deactivate(_state: MembershipState, event: Extract<MembershipEvent, { type: "deactivate" }>): MembershipTransition {
  return {
    kind: "applied",
    state: { kind: "inactive", reason: event.reason },
    patch: { isActive: false, deactivatedAt: new Date(event.at).toISOString(), deactivationReason: event.reason },
  };
}

/** Apply a patch to a Member record. Exported for the shell and for round-trip tests. */
export function applyMembershipPatch(member: Member, patch: MembershipPatch): Member {
  const next: Member = { ...member };
  for (const [key, value] of Object.entries(patch) as Array<[keyof MembershipPatch, unknown]>) {
    if (value === undefined) delete (next as unknown as Record<string, unknown>)[key];
    else (next as unknown as Record<string, unknown>)[key] = value;
  }
  return next;
}
