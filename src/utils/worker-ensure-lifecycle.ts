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
export type WorkerCarrierObservation = "live" | "missing" | {
  launch: import("../coordination/carrier-observation").LaunchState;
  process: import("../coordination/carrier-observation").ProcessState;
  lastStop?: { piReason: "quit" | "reload" | "new" | "resume" | "fork" } | "none" | "quit" | "reload" | "new" | "resume" | "fork";
};

export type WorkerEnsureAction = "create" | "reuse" | "recover" | "refuse" | "attention";
export type WorkerRecoveryMode = "first_binding_retry" | "exact_session_resume";
export type PreparedWorkerCarrier = Extract<WorkerCarrierState, { kind: "prepared" }>;
export type BoundWorkerCarrier = Extract<WorkerCarrierState, { kind: "bound" }>;
/** Only an exact Session-bound carrier is reusable work capacity. */
export type WorkerUsableCarrier = BoundWorkerCarrier;

export type WorkerEnsurePlan =
  | { action: "create" }
  | { action: "attention"; carrier: PreparedWorkerCarrier | BoundWorkerCarrier; reason: string; nextActionHint: "wait" | "ask_human" }
  | { action: "reuse"; carrier: WorkerUsableCarrier }
  | { action: "recover"; carrier: PreparedWorkerCarrier; recoveryMode: "first_binding_retry" }
  | { action: "recover"; carrier: BoundWorkerCarrier; recoveryMode: "exact_session_resume" }
  | {
    action: "refuse";
    carrier: Extract<WorkerCarrierState, { kind: "invalid" }> | PreparedWorkerCarrier;
    reason: WorkerCarrierInvalidReason | "unbound_live";
  };

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
export function planWorkerEnsure(carrier: WorkerCarrierState, observation: WorkerCarrierObservation | "live" | "missing"): WorkerEnsurePlan {
  // Historical shell-only callers cannot establish generation identity.
  const evidence: Exclude<WorkerCarrierObservation, string> = typeof observation === "string" ? { launch: "unknown", process: "unknown" } : observation;
  const lastStop = typeof evidence.lastStop === "object" ? evidence.lastStop.piReason : evidence.lastStop;
  const attention = (carrier: PreparedWorkerCarrier | BoundWorkerCarrier, reason: string, nextActionHint: "wait" | "ask_human" = "wait"): WorkerEnsurePlan => ({ action: "attention", carrier, reason, nextActionHint });
  switch (carrier.kind) {
    case "absent":
      return { action: "create" };
    case "invalid":
      return { action: "refuse", carrier, reason: carrier.reason };
    case "prepared":
      if (evidence.launch === "none") return { action: "create" };
      if (evidence.launch === "refused" && evidence.process === "gone") return { action: "recover", carrier, recoveryMode: "first_binding_retry" };
      return attention(carrier, evidence.launch === "refused" ? evidence.process : `launch_${evidence.launch}`);
    case "bound":
      if (lastStop === "new" || lastStop === "resume" || lastStop === "fork") return attention(carrier, "session_switched", "ask_human");
      if (evidence.process === "gone") return { action: "recover", carrier, recoveryMode: "exact_session_resume" };
      if (evidence.process === "live" && lastStop !== "quit") return { action: "reuse", carrier };
      return attention(carrier, evidence.process === "live" ? "stopping" : evidence.process, evidence.process === "stopping" || lastStop === "quit" ? "ask_human" : "wait");
    default:
      return assertNever(carrier);
  }
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled Worker lifecycle value: ${JSON.stringify(value)}`);
}
