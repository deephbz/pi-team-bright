import type { Member } from "../team-authority/contracts";

/** The only persisted carrier shapes a current teammate Membership may represent. */
export type WorkerCarrierState =
  | { kind: "absent" }
  | { kind: "prepared"; member: Member; membershipId: string; pendingLaunchId: string }
  | { kind: "bound"; member: Member; membershipId: string; sessionFile: string }
  | { kind: "invalid"; member: Member; reason: WorkerCarrierInvalidReason };

export type WorkerCarrierInvalidReason =
  | "missing_membership_id"
  | "both_session_and_pending_launch"
  | "missing_session_and_pending_launch";

/** Team-owned terminal adapter evidence for the recorded carrier target. */
export type WorkerCarrierObservation = "live" | "missing";

export type WorkerEnsureAction = "create" | "reuse" | "recover" | "refuse";
export type WorkerRecoveryMode = "first_binding_retry" | "exact_session_resume";
export type PreparedWorkerCarrier = Extract<WorkerCarrierState, { kind: "prepared" }>;
export type BoundWorkerCarrier = Extract<WorkerCarrierState, { kind: "bound" }>;
export type WorkerUsableCarrier = PreparedWorkerCarrier | BoundWorkerCarrier;

export type WorkerEnsurePlan =
  | { action: "create" }
  | { action: "reuse"; carrier: WorkerUsableCarrier }
  | { action: "recover"; carrier: PreparedWorkerCarrier; recoveryMode: "first_binding_retry" }
  | { action: "recover"; carrier: BoundWorkerCarrier; recoveryMode: "exact_session_resume" }
  | { action: "refuse"; carrier: Extract<WorkerCarrierState, { kind: "invalid" }> };

/**
 * Converts persistence optionals into the lifecycle state machine without
 * changing the on-disk TeamConfig schema. An inactive or unmatched member is
 * represented by `undefined` at this boundary and normalizes to absent.
 */
export function normalizeWorkerCarrier(member: Member | undefined): WorkerCarrierState {
  if (!member) return { kind: "absent" };
  if (!member.membershipId) return { kind: "invalid", member, reason: "missing_membership_id" };
  if (member.sessionFile && member.pendingLaunchId) {
    return { kind: "invalid", member, reason: "both_session_and_pending_launch" };
  }
  if (member.sessionFile) {
    return { kind: "bound", member, membershipId: member.membershipId, sessionFile: member.sessionFile };
  }
  if (member.pendingLaunchId) {
    return { kind: "prepared", member, membershipId: member.membershipId, pendingLaunchId: member.pendingLaunchId };
  }
  return { kind: "invalid", member, reason: "missing_session_and_pending_launch" };
}

/** Pure exhaustive Worker lifecycle decision; effects execute outside this module. */
export function planWorkerEnsure(carrier: WorkerCarrierState, observation: WorkerCarrierObservation): WorkerEnsurePlan {
  switch (carrier.kind) {
    case "absent":
      return { action: "create" };
    case "invalid":
      return { action: "refuse", carrier };
    case "prepared":
      if (observation === "live") return { action: "reuse", carrier };
      return { action: "recover", carrier, recoveryMode: "first_binding_retry" };
    case "bound":
      if (observation === "live") return { action: "reuse", carrier };
      return { action: "recover", carrier, recoveryMode: "exact_session_resume" };
    default:
      return assertNever(carrier);
  }
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled Worker lifecycle value: ${JSON.stringify(value)}`);
}
