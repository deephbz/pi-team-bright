import { actorRef, type HistoryEntry } from "../history";
import { lastAt, lastSequence, notApplicable, ofKind, pass, violation } from "./util";
import type { Verdict } from "./types";

/** E5 bound from the implementation plan: an `ensure_worker` receipt returns within 10 s of virtual time. */
export const E5_BOUND_MS = 10000;

/** E1 (eventually): a world exit reaches the carrier view within the freshness deadline. */
export function e1ExitReachesCarrierView(history: readonly HistoryEntry[], options: { deadlineMs?: number } = {}): Verdict {
  if (options.deadlineMs === undefined) return notApplicable("freshness deadline (not ruled)");
  const exits = ofKind(history, "process.death").filter(entry => actorRef(entry.process.actorKey).actor !== "lead");
  if (!exits.length) return notApplicable("worker process exits");
  const claims = ofKind(history, "journal.append").filter(entry => entry.event.raw.field === "process");
  for (const exit of exits) {
    const worker = actorRef(exit.process.actorKey).actor;
    const deadline = exit.at + options.deadlineMs;
    const reached = claims.some(claim => claim.sequence > exit.sequence && claim.event.worker === worker && claim.at <= deadline && claim.event.raw.to !== "live");
    if (!reached && lastAt(history) > deadline) return violation(exit.sequence, `exit of ${worker} did not reach the carrier view within ${options.deadlineMs} ms`);
  }
  return pass();
}

/** E2 (eventually): a converged journal event reaches the branch within the latency bound, from eligibility. */
export function e2EventReachesBranch(history: readonly HistoryEntry[], options: { latencyMs?: number } = {}): Verdict {
  if (options.latencyMs === undefined) return notApplicable("branch delivery latency bound (not ruled)");
  const events = ofKind(history, "journal.append").filter(entry => entry.event.seq !== undefined);
  if (!events.length) return notApplicable("journal seq fields");
  const stamps = ofKind(history, "lead.entry").filter(entry => entry.stamp !== undefined);
  for (const event of events) {
    const seq = event.event.seq!;
    const deadline = event.at + options.latencyMs;
    const delivered = stamps.some(stamp => stamp.sequence > event.sequence && stamp.stamp!.team === event.team && stamp.stamp!.from < seq && seq <= stamp.stamp!.through && stamp.at <= deadline);
    if (!delivered && lastAt(history) > deadline) return violation(event.sequence, `event ${seq} did not reach the branch within ${options.latencyMs} ms`);
  }
  return pass();
}

/** E3 (eventually): a healthy launch completes or reports unknown within the bound. */
export function e3LaunchCompletesOrReportsUnknown(history: readonly HistoryEntry[], options: { boundMs?: number } = {}): Verdict {
  if (options.boundMs === undefined) return notApplicable("launch completion bound (not ruled)");
  const launches = ofKind(history, "durable.launch").filter(entry => entry.record?.pendingLaunchId !== undefined && entry.record.launchConsumedAt === undefined);
  if (!launches.length) return notApplicable("durable launch records with pendingLaunchId");
  for (const start of launches) {
    const membershipId = start.record!.membershipId;
    const deadline = start.at + options.boundMs;
    const resolved = ofKind(history, "durable.launch").some(entry => entry.sequence > start.sequence && entry.record?.membershipId === membershipId && entry.record?.launchConsumedAt !== undefined && entry.at <= deadline)
      || ofKind(history, "journal.append").some(entry => entry.sequence > start.sequence && entry.event.raw.field === "launch" && entry.event.membershipId === membershipId && entry.at <= deadline);
    if (!resolved && lastAt(history) > deadline) return violation(start.sequence, `launch for ${membershipId ?? "?"} neither completed nor reported unknown within ${options.boundMs} ms`);
  }
  return pass();
}

/**
 * E4 (eventually): a blocked Worker that stays blocked past the threshold produces one attention per re-arm epoch.
 * The epoch re-arms on the next Worker Task event (journal `type: task`) or on leaving blocked.
 */
export function e4BlockedAttentionOncePerEpoch(history: readonly HistoryEntry[], options: { thresholdMs?: number } = {}): Verdict {
  if (options.thresholdMs === undefined) return notApplicable("blocked threshold (not ruled)");
  const rows = ofKind(history, "journal.append");
  const blockedArms = rows.filter(entry => entry.event.raw.field === "activity" && entry.event.raw.to === "blocked");
  if (!blockedArms.length) return notApplicable("journal activity: blocked transitions (C2)");
  for (const arm of blockedArms) {
    const worker = arm.event.worker;
    const epochEnd = rows.find(entry => entry.sequence > arm.sequence && entry.event.worker === worker && ((entry.event.raw.field === "activity" && entry.event.raw.to !== "blocked") || entry.event.type === "task"));
    const end = epochEnd?.sequence ?? Number.POSITIVE_INFINITY;
    const attentions = rows.filter(entry => entry.sequence > arm.sequence && entry.sequence < end && entry.event.worker === worker && entry.event.raw.field === "attention" && entry.event.raw.to === "blocked");
    if (attentions.length > 1) return violation(attentions[1]!.sequence, `${worker} produced ${attentions.length} blocked attentions in one epoch`);
    const persistedPast = (epochEnd?.at ?? lastAt(history)) - arm.at > options.thresholdMs;
    if (!attentions.length && persistedPast) return violation(arm.sequence, `${worker} blocked past ${options.thresholdMs} ms with no attention`);
  }
  return pass();
}

/** E5 (bounded): an `ensure_worker` receipt returns within the bound of virtual time. */
export function e5ReceiptWithinBound(history: readonly HistoryEntry[], options: { boundMs?: number } = {}): Verdict {
  const bound = options.boundMs ?? E5_BOUND_MS;
  const calls = ofKind(history, "tool.call").filter(entry => entry.name === "ensure_worker");
  if (!calls.length) return notApplicable("ensure_worker calls");
  const results = ofKind(history, "tool.result");
  for (const call of calls) {
    const result = results.find(entry => entry.callId === call.callId);
    if (result) {
      if (result.at - call.at > bound) return violation(result.sequence, `ensure_worker receipt took ${result.at - call.at} ms (bound ${bound})`);
    } else if (lastAt(history) - call.at > bound) {
      return violation(lastSequence(history), `ensure_worker ${call.callId} has no receipt after ${bound} ms`);
    }
  }
  return pass();
}
