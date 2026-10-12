import { actorRef, type HistoryEntry, type JournalFact } from "../history";
import { faultInWindow, genKey, generationOf, lastAt, notApplicable, ofKind, pass, violation } from "./util";
import type { Verdict } from "./types";

/** E5 bound from the implementation plan: an `ensure_worker` receipt returns within 10 s of virtual time. */
export const E5_BOUND_MS = 10000;

/** Window outcome order: a violation wins; then a fault window (assumption); then an unobserved window. */
function settle(underFault: boolean, unobserved: boolean): Verdict {
  if (underFault) return notApplicable("window contains a fault: N/A under assumption");
  if (unobserved) return notApplicable("window not observed before history end");
  return pass();
}

/** Names a generation as ended: `process: gone` for it, or a replacement that names it. */
const REPLACED_KEYS = ["previousGeneration", "replacedGeneration", "replaces"];
function namesEnded(event: JournalFact, key: string): boolean {
  const gone = generationOf(event.generation);
  if (event.raw.to === "gone" && gone && genKey(gone) === key) return true;
  return REPLACED_KEYS.some(name => {
    const named = generationOf(event.raw[name]);
    return named !== undefined && genKey(named) === key;
  });
}

/** E1 (eventually): a bound Worker generation that exits is named ended by a journal event within the deadline. */
export function e1ExitReachesCarrierView(history: readonly HistoryEntry[], options: { deadlineMs?: number } = {}): Verdict {
  if (options.deadlineMs === undefined) return notApplicable("freshness deadline (not ruled)");
  const deadlineMs = options.deadlineMs;
  const exits = ofKind(history, "process.death").filter(entry => entry.process.processKind === "worker_pi");
  if (!exits.length) return notApplicable("worker_pi process exits bound to a Membership (processKind)");
  const rows = ofKind(history, "journal.append").filter(entry => entry.event.raw.field === "process");
  let underFault = false;
  let unobserved = false;
  for (const exit of exits) {
    const worker = actorRef(exit.process.actorKey).actor;
    const key = genKey(exit.process.generation);
    const deadline = exit.at + deadlineMs;
    if (rows.some(row => row.sequence > exit.sequence && row.at <= deadline && namesEnded(row.event, key))) continue;
    if (lastAt(history) <= deadline) { unobserved = true; continue; }
    if (faultInWindow(history, exit.at, deadline)) { underFault = true; continue; }
    return violation(exit.sequence, `exit of ${worker} not named ended within ${deadlineMs} ms`);
  }
  return settle(underFault, unobserved);
}

/**
 * E2 (eventually): a journal event reaches a branch stamp within the latency bound.
 * The window starts when the lead first settles (idle and eligible) after the append.
 */
export function e2EventReachesBranch(history: readonly HistoryEntry[], options: { latencyMs?: number } = {}): Verdict {
  if (options.latencyMs === undefined) return notApplicable("branch delivery latency bound (not ruled)");
  const latencyMs = options.latencyMs;
  const events = ofKind(history, "journal.append").filter(entry => entry.event.seq !== undefined);
  if (!events.length) return notApplicable("journal seq fields");
  const stamps = ofKind(history, "lead.entry").filter(entry => entry.stamp !== undefined);
  const settled = ofKind(history, "world.input");
  let decided = false;
  let underFault = false;
  let unobserved = false;
  for (const event of events) {
    const seq = event.event.seq!;
    const idle = settled.find(entry => entry.sequence > event.sequence && entry.step.kind === "agent.settled" && entry.step.who.team === event.team && entry.step.who.actor === "lead");
    if (!idle) continue;
    decided = true;
    const deadline = idle.at + latencyMs;
    if (stamps.some(stamp => stamp.sequence > event.sequence && stamp.stamp!.team === event.team && stamp.stamp!.from < seq && seq <= stamp.stamp!.through && stamp.at <= deadline)) continue;
    if (lastAt(history) <= deadline) { unobserved = true; continue; }
    if (faultInWindow(history, idle.at, deadline)) { underFault = true; continue; }
    return violation(event.sequence, `event ${seq} did not reach the branch within ${latencyMs} ms of lead idle`);
  }
  if (!decided) return notApplicable("lead never idle and eligible after the append in the window");
  return settle(underFault, unobserved);
}

/** E3 (eventually): a healthy launch completes or reports unknown within the bound. */
export function e3LaunchCompletesOrReportsUnknown(history: readonly HistoryEntry[], options: { boundMs?: number } = {}): Verdict {
  if (options.boundMs === undefined) return notApplicable("launch completion bound (not ruled)");
  const boundMs = options.boundMs;
  const launches = ofKind(history, "durable.launch").filter(entry => entry.record?.pendingLaunchId !== undefined && entry.record.launchConsumedAt === undefined);
  if (!launches.length) return notApplicable("durable launch records with pendingLaunchId");
  let underFault = false;
  let unobserved = false;
  for (const start of launches) {
    const membershipId = start.record!.membershipId;
    const deadline = start.at + boundMs;
    const resolved = ofKind(history, "durable.launch").some(entry => entry.sequence > start.sequence && entry.record?.membershipId === membershipId && entry.record?.launchConsumedAt !== undefined && entry.at <= deadline)
      || ofKind(history, "journal.append").some(entry => entry.sequence > start.sequence && entry.event.raw.field === "launch" && entry.event.membershipId === membershipId && entry.at <= deadline);
    if (resolved) continue;
    if (lastAt(history) <= deadline) { unobserved = true; continue; }
    if (faultInWindow(history, start.at, deadline)) { underFault = true; continue; }
    return violation(start.sequence, `launch for ${membershipId ?? "?"} neither completed nor reported unknown within ${boundMs} ms`);
  }
  return settle(underFault, unobserved);
}

/**
 * E4 (eventually): a blocked Worker that stays blocked past the threshold produces one attention per re-arm epoch.
 * The epoch re-arms on the next Worker Task event (journal `type: task`) or on leaving blocked.
 */
export function e4BlockedAttentionOncePerEpoch(history: readonly HistoryEntry[], options: { thresholdMs?: number } = {}): Verdict {
  if (options.thresholdMs === undefined) return notApplicable("blocked threshold (not ruled)");
  const threshold = options.thresholdMs;
  const rows = ofKind(history, "journal.append");
  const blockedArms = rows.filter(entry => entry.event.raw.field === "activity" && entry.event.raw.to === "blocked");
  if (!blockedArms.length) return notApplicable("journal activity: blocked transitions (C2)");
  let underFault = false;
  for (const arm of blockedArms) {
    const worker = arm.event.worker;
    const epochEnd = rows.find(entry => entry.sequence > arm.sequence && entry.event.worker === worker && ((entry.event.raw.field === "activity" && entry.event.raw.to !== "blocked") || entry.event.type === "task"));
    const end = epochEnd?.sequence ?? Number.POSITIVE_INFINITY;
    const attentions = rows.filter(entry => entry.sequence > arm.sequence && entry.sequence < end && entry.event.worker === worker && entry.event.raw.field === "attention" && entry.event.raw.to === "blocked");
    if (attentions.length > 1) return violation(attentions[1]!.sequence, `${worker} produced ${attentions.length} blocked attentions in one epoch`);
    const persistedPast = (epochEnd?.at ?? lastAt(history)) - arm.at > threshold;
    if (attentions.length || !persistedPast) continue;
    if (faultInWindow(history, arm.at, arm.at + threshold)) { underFault = true; continue; }
    return violation(arm.sequence, `${worker} blocked past ${threshold} ms with no attention`);
  }
  return settle(underFault, false);
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
      return violation(history.at(-1)!.sequence, `ensure_worker ${call.callId} has no receipt after ${bound} ms`);
    }
  }
  return pass();
}
