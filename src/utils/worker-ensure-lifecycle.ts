import type { Member } from "../team-authority/contracts";
import { parseMembership, type InvalidMembershipReason } from "../team-authority/membership-machine";

/** The only persisted carrier shapes a current teammate Membership may represent. */
export type WorkerCarrierState =
  | { kind: "absent" }
  | { kind: "unbound"; member: Member; membershipId: string }
  | { kind: "prepared"; member: Member; membershipId: string; pendingLaunchId: string }
  | { kind: "bound"; member: Member; membershipId: string; sessionFile: string }
  | { kind: "invalid"; member: Member; reason: WorkerCarrierInvalidReason };

export type WorkerCarrierInvalidReason = InvalidMembershipReason;

/** Team-owned terminal adapter evidence for the recorded carrier target. */
export type WorkerCarrierObservation = "live" | "missing" | {
  launch: import("../carrier-observation").LaunchState;
  process: import("../carrier-observation").ProcessState;
  readmitted?: boolean;
  generation?: { osBirthToken?: string };
  evidence?: ReadonlyArray<{ source: string; fact: string }>;
  lastStop?: { piReason: "quit" | "reload" | "new" | "resume" | "fork" } | "none" | "quit" | "reload" | "new" | "resume" | "fork";
  /** `outstanding`: a recorded launch may still bind. `expired_unstarted`: the Membership machine permits a first-binding retry. */
  pending?: "outstanding" | "expired_unstarted";
};

export type WorkerEnsureAction = "create" | "reuse" | "recover" | "refuse" | "attention";
export type WorkerRecoveryMode = "first_binding_retry" | "exact_session_resume";
export type PreparedWorkerCarrier = Extract<WorkerCarrierState, { kind: "prepared" }>;
export type UnboundWorkerCarrier = Extract<WorkerCarrierState, { kind: "unbound" }>;
export type BoundWorkerCarrier = Extract<WorkerCarrierState, { kind: "bound" }>;
/** Only an exact Session-bound carrier is reusable work capacity. */
export type WorkerUsableCarrier = BoundWorkerCarrier;

export type WorkerEnsurePlan =
  | { action: "create" }
  | { action: "attention"; carrier: PreparedWorkerCarrier | BoundWorkerCarrier | UnboundWorkerCarrier; reason: string; nextActionHint: "wait" | "ask_human" }
  | { action: "reuse"; carrier: WorkerUsableCarrier }
  | { action: "recover"; carrier: PreparedWorkerCarrier; recoveryMode: "first_binding_retry" }
  | { action: "recover"; carrier: BoundWorkerCarrier; recoveryMode: "exact_session_resume" }
  | {
    action: "refuse";
    carrier: Extract<WorkerCarrierState, { kind: "invalid" }> | PreparedWorkerCarrier;
    reason: WorkerCarrierInvalidReason | "unbound_live";
  };

/**
 * Projects the Membership machine state onto the ensure planner without
 * changing the on-disk TeamConfig schema. An inactive or unmatched member is
 * represented by `undefined` at this boundary and normalizes to absent.
 */
export function normalizeWorkerCarrier(member: Member | undefined): WorkerCarrierState {
  if (!member) return { kind: "absent" };
  const state = parseMembership(member);
  switch (state.kind) {
    case "inactive": return { kind: "absent" };
    case "invalid": return { kind: "invalid", member, reason: state.reason };
    case "bound": return { kind: "bound", member, membershipId: member.membershipId!, sessionFile: state.sessionFile };
    case "prepared": return { kind: "prepared", member, membershipId: member.membershipId!, pendingLaunchId: state.capability };
  }
}

/** Pure exhaustive Worker lifecycle decision; effects execute outside this module. */
export function planWorkerEnsure(carrier: WorkerCarrierState, observation: WorkerCarrierObservation | "live" | "missing"): WorkerEnsurePlan {
  // Historical shell-only callers cannot establish generation identity.
  const evidence: Exclude<WorkerCarrierObservation, string> = typeof observation === "string" ? { launch: "unknown", process: "unknown" } : observation;
  const lastStop = typeof evidence.lastStop === "object" ? evidence.lastStop.piReason : evidence.lastStop;
  const attention = (carrier: PreparedWorkerCarrier | BoundWorkerCarrier | UnboundWorkerCarrier, reason: string, nextActionHint: "wait" | "ask_human" = "wait"): WorkerEnsurePlan => ({ action: "attention", carrier, reason, nextActionHint });
  if (carrier.kind !== "absent" && carrier.kind !== "invalid" && evidence.process === "unknown"
    && evidence.evidence?.some(item => item.source === "process_generation" && item.fact === "generation_helper_missing")) {
    return attention(carrier, "generation_helper_missing", "ask_human");
  }
  if (carrier.kind === "prepared" && evidence.pending === "expired_unstarted") return { action: "recover", carrier, recoveryMode: "first_binding_retry" };
  const plan = planFromCarrier(carrier, evidence, lastStop, attention);
  // Even a bound dead prior generation cannot bypass an in-flight recovery.
  if (evidence.pending === "outstanding" && (carrier.kind === "prepared" || carrier.kind === "bound" || carrier.kind === "unbound")
    && plan.action !== "reuse" && !(plan.action === "attention" && (plan.reason === "legacy_unverified" || plan.reason === "generation_helper_missing"))) {
    return attention(carrier, "launch_pending");
  }
  return plan;
}

function planFromCarrier(
  carrier: WorkerCarrierState,
  evidence: Exclude<WorkerCarrierObservation, string>,
  lastStop: string | undefined,
  attention: (carrier: PreparedWorkerCarrier | BoundWorkerCarrier | UnboundWorkerCarrier, reason: string, nextActionHint?: "wait" | "ask_human") => WorkerEnsurePlan,
): WorkerEnsurePlan {
  switch (carrier.kind) {
    case "absent":
      return { action: "create" };
    case "invalid":
      return { action: "refuse", carrier, reason: carrier.reason };
    case "unbound":
      if (evidence.launch === "none" && (evidence.process === "gone" || evidence.process === "none")) return { action: "create" };
      return attention(carrier, evidence.process === "unknown" ? "verifier_unknown" : "candidate_live", evidence.process === "unknown" ? "ask_human" : "wait");
    case "prepared":
      if (evidence.launch === "refused" && (evidence.process === "gone" || evidence.process === "none")) return { action: "recover", carrier, recoveryMode: "first_binding_retry" };
      if (evidence.launch === "refused") return attention(carrier, evidence.process === "unknown" ? "verifier_unknown" : "candidate_live", evidence.process === "unknown" ? "ask_human" : "wait");
      return attention(carrier, `launch_${evidence.launch}`);
    case "bound":
      if (evidence.generation && !evidence.generation.osBirthToken) return attention(carrier, "legacy_unverified", "ask_human");
      if (lastStop === "new" || lastStop === "resume" || lastStop === "fork") return attention(carrier, "session_switched", "ask_human");
      if (evidence.process === "gone") return { action: "recover", carrier, recoveryMode: "exact_session_resume" };
      if (evidence.process === "live" && lastStop === "reload" && !evidence.readmitted) return attention(carrier, "reload_pending");
      if (evidence.process === "live" && lastStop !== "quit") return { action: "reuse", carrier };
      return attention(carrier, evidence.process === "live" ? "stopping" : evidence.process, evidence.process === "stopping" || lastStop === "quit" ? "ask_human" : "wait");
    default:
      return assertNever(carrier);
  }
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled Worker lifecycle value: ${JSON.stringify(value)}`);
}
