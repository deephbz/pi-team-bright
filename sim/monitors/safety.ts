import type { HistoryEntry } from "../history";
import { genKey, generationOf, lastAt, lastSequence, liveAt, notApplicable, ofKind, pass, violation, actorKey } from "./util";
import type { Verdict } from "./types";

/** P1 (always): at most one admitted, current process generation per Membership. */
export function p1SingleAdmittedGeneration(history: readonly HistoryEntry[]): Verdict {
  const records = ofKind(history, "durable.runtime").flatMap(entry => {
    const record = entry.record;
    if (!record || record.membershipId === undefined || record.pid === undefined || record.bootId === undefined || record.osBirthToken === undefined) return [];
    return [{ sequence: entry.sequence, membershipId: record.membershipId, generation: genKey({ pid: record.pid, bootId: record.bootId, osBirthToken: record.osBirthToken }) }];
  });
  if (!records.length) return notApplicable("durable runtime records with membershipId, pid, bootId and osBirthToken (C2)");
  for (const entry of history) {
    const live = liveAt(history, entry.sequence);
    const byMember = new Map<string, Set<string>>();
    for (const record of records) {
      if (record.sequence > entry.sequence || !live.has(record.generation)) continue;
      const generations = byMember.get(record.membershipId) ?? new Set<string>();
      generations.add(record.generation);
      byMember.set(record.membershipId, generations);
    }
    for (const [membershipId, generations] of byMember) {
      if (generations.size > 1) return violation(entry.sequence, `membership ${membershipId} has ${generations.size} live admitted generations`);
    }
  }
  return pass();
}

/** P2 (always): a `process: gone` claim at t ⇒ the claimed exact generation was dead at t. */
export function p2GoneMatchesWorldTruth(history: readonly HistoryEntry[]): Verdict {
  const claims = ofKind(history, "journal.append").filter(entry => entry.event.raw.field === "process" && entry.event.raw.to === "gone");
  if (!claims.length) return notApplicable("journal process: gone claims");
  for (const claim of claims) {
    const generation = generationOf(claim.event.generation);
    if (!generation) return notApplicable("process: gone claims without an exact generation (C2)");
    if (liveAt(history, claim.sequence).has(genKey(generation))) {
      return violation(claim.sequence, `process gone claimed for ${claim.event.worker ?? "?"} while its generation was alive`);
    }
  }
  return pass();
}

/** P3 (always): `process: live` is held only while its evidence is fresh. Needs the freshness deadline. */
export function p3LiveIsFresh(history: readonly HistoryEntry[], options: { freshnessMs?: number } = {}): Verdict {
  if (options.freshnessMs === undefined) return notApplicable("freshness deadline (not ruled)");
  const claims = ofKind(history, "journal.append").filter(entry => entry.event.raw.field === "process" && entry.event.worker !== undefined);
  if (!claims.length) return notApplicable("journal process claims");
  for (const claim of claims) {
    if (claim.event.raw.to !== "live") continue;
    const deadline = claim.at + options.freshnessMs;
    const next = claims.find(entry => entry.sequence > claim.sequence && entry.event.worker === claim.event.worker);
    if (next && next.at > deadline) return violation(next.sequence, `${claim.event.worker} held live past its freshness deadline`);
    if (!next && lastAt(history) > deadline) return violation(lastSequence(history), `${claim.event.worker} held live past its freshness deadline with no newer claim`);
  }
  return pass();
}

/** P4 (always): a reuse or spawn act is not contradicted by world truth at the call. */
export function p4ActMatchesWorldTruth(history: readonly HistoryEntry[]): Verdict {
  const calls = new Map(ofKind(history, "tool.call").filter(entry => entry.name === "ensure_worker").map(entry => [entry.callId, entry]));
  const results = ofKind(history, "tool.result").filter(entry => entry.name === "ensure_worker");
  if (!results.length) return notApplicable("ensure_worker results");
  for (const result of results) {
    const call = calls.get(result.callId);
    const name = call?.args.name;
    if (!call || typeof name !== "string") return notApplicable("ensure_worker call without a worker name");
    const key = `${result.actor.team}/${name}`;
    const live = [...liveAt(history, call.sequence).values()].some(process => process.actorKey === key);
    const effect = result.result.details?.effect;
    if (effect === "reused" && !live) return violation(result.sequence, `reuse of ${key} with no live world process`);
    if ((effect === "created" || effect === "recovered") && live) return violation(result.sequence, `spawn of ${key} while world truth had a live process`);
  }
  return pass();
}

const STOP_TOOLS = new Set(["worker_stop", "team_shutdown"]);

/** P5 (always): every pane close cites a PTB stop request or a human action. */
export function p5ClosesCited(history: readonly HistoryEntry[]): Verdict {
  const closes = ofKind(history, "pane.close");
  if (!closes.length) return notApplicable("pane closures");
  for (const close of closes) {
    const origin = close.origin;
    if (origin.kind === "human") continue;
    if (origin.kind !== "ptb") return violation(close.sequence, `pane ${close.pane.paneId} closed by ${origin.kind} origin`);
    const cited = ofKind(history, "tool.call").some(
      call => call.sequence < close.sequence && STOP_TOOLS.has(call.name) && actorKey(call.actor) === actorKey(origin.actor),
    );
    if (!cited) return violation(close.sequence, `pane ${close.pane.paneId} closed without a PTB stop request`);
  }
  return pass();
}

/** P6 (always): at most one outstanding launch reservation per Membership. */
export function p6OneOutstandingReservation(history: readonly HistoryEntry[]): Verdict {
  if (!ofKind(history, "durable.launch").some(entry => entry.record?.pendingLaunchId !== undefined)) {
    return notApplicable("durable launch records with pendingLaunchId (C2)");
  }
  const latest = new Map<string, { membershipId: string; pending?: string }>();
  for (const entry of history) {
    if (entry.kind !== "durable.launch") continue;
    const key = `${entry.team}|${entry.path}`;
    const record = entry.record;
    if (!record || record.membershipId === undefined) {
      latest.delete(key);
      continue;
    }
    const outstanding = record.pendingLaunchId !== undefined && record.launchConsumedAt === undefined;
    latest.set(key, { membershipId: record.membershipId, pending: outstanding ? record.pendingLaunchId : undefined });
    const pending = new Set<string>();
    for (const value of latest.values()) if (value.membershipId === record.membershipId && value.pending) pending.add(value.pending);
    if (pending.size > 1) return violation(entry.sequence, `membership ${record.membershipId} has ${pending.size} outstanding reservations`);
  }
  return pass();
}

const TASK_WRITES = new Set(["create", "update", "close", "reopen", "dep", "delete"]);

/** P7 (always): carrier publication never writes Task authority (same PTB operation). */
export function p7PublicationNeverWritesTasks(history: readonly HistoryEntry[]): Verdict {
  const published = new Set<string>();
  for (const entry of ofKind(history, "journal.append")) {
    if (entry.origin.kind === "ptb" && entry.origin.toolCallId !== undefined) published.add(entry.origin.toolCallId);
  }
  if (!published.size) return notApplicable("journal appends with PTB tool call ids");
  for (const exec of ofKind(history, "exec.call")) {
    if (exec.command !== "bd" || !TASK_WRITES.has(String(exec.args[0]))) continue;
    const origin = exec.origin;
    if (origin.kind === "ptb" && origin.toolCallId !== undefined && published.has(origin.toolCallId)) {
      return violation(exec.sequence, `bd ${String(exec.args[0])} in the publication operation ${origin.toolCallId}`);
    }
  }
  return pass();
}

/** P8 (always): an eligible journal event below a stamp's cursor is represented by the branch or a snapshot. */
export function p8CoverageLedger(history: readonly HistoryEntry[]): Verdict {
  const stamps = ofKind(history, "lead.entry").filter(entry => entry.stamp !== undefined);
  if (!stamps.length) return notApplicable("lead observation stamps");
  const events = ofKind(history, "journal.append").filter(entry => entry.event.seq !== undefined);
  if (!events.length) return notApplicable("journal seq fields");
  for (const stamp of stamps) {
    const { team, from, through } = stamp.stamp!;
    for (const event of events) {
      const seq = event.event.seq!;
      if (event.team !== team || seq <= 0 || seq > through || event.sequence > stamp.sequence) continue;
      if (seq > from) continue;
      const earlier = stamps.some(other => other.sequence < stamp.sequence && other.stamp!.team === team && other.stamp!.from < seq && seq <= other.stamp!.through);
      const snapshot = ofKind(history, "lead.entry").some(
        other => other.sequence < stamp.sequence && other.entry.customType === "ptb.snapshot" && other.stamp?.team === team && other.stamp.through >= seq,
      );
      if (!earlier && !snapshot) return violation(stamp.sequence, `event ${seq} at or below through ${through} is not represented on the branch`);
    }
  }
  return pass();
}

/** P9 (always): no page appears twice on one branch in healthy operation. */
export function p9NoDuplicatePage(history: readonly HistoryEntry[]): Verdict {
  const stamps = ofKind(history, "lead.entry").filter(entry => entry.stamp !== undefined);
  if (!stamps.length) return notApplicable("lead observation stamps");
  for (let i = 0; i < stamps.length; i++) {
    for (let j = i + 1; j < stamps.length; j++) {
      const a = stamps[i]!.stamp!;
      const b = stamps[j]!.stamp!;
      if (a.team !== b.team || a.epoch !== b.epoch || a.binding !== b.binding) continue;
      if (a.through <= a.from || b.through <= b.from) continue;
      if (a.from < b.through && b.from < a.through) return violation(stamps[j]!.sequence, `page (${b.from}, ${b.through}] overlaps an earlier page`);
    }
  }
  return pass();
}

/** P10 (always): each journaled carrier event's cause, pane and generation match world truth. */
export function p10JournalMatchesWorldTruth(history: readonly HistoryEntry[]): Verdict {
  const rows = ofKind(history, "journal.append").filter(entry => entry.event.paneId !== undefined || entry.event.generation !== undefined || entry.event.suspectedHumanStop !== undefined || entry.event.cause !== undefined);
  if (!rows.length) return notApplicable("journal carrier events with paneId, generation, cause or suspectedHumanStop");
  for (const row of rows) {
    const { paneId, generation: raw, cause, suspectedHumanStop } = row.event;
    if (paneId !== undefined && !ofKind(history, "pane.create").some(entry => entry.sequence < row.sequence && entry.pane.paneId === paneId)) {
      return violation(row.sequence, `journal paneId ${paneId} has no prior pane creation`);
    }
    if (raw !== undefined) {
      const generation = generationOf(raw);
      if (!generation) return notApplicable("journal generation without exact fields (C2)");
      const born = ofKind(history, "process.birth").some(entry => entry.sequence < row.sequence && genKey(entry.process.generation) === genKey(generation));
      if (!born) return violation(row.sequence, `journal generation ${genKey(generation)} matches no world process birth`);
    }
    if (cause === "human") {
      const human = history.some(entry => entry.sequence < row.sequence && ((entry.kind === "world.input" && entry.step.kind.startsWith("human.")) || (entry.kind === "pane.close" && entry.origin.kind === "human")));
      if (!human) return violation(row.sequence, "journal cause human with no world human input");
    }
    if (suspectedHumanStop === true && paneId !== undefined) {
      const ptbClosed = ofKind(history, "pane.close").some(entry => entry.sequence < row.sequence && entry.pane.paneId === paneId && entry.origin.kind === "ptb");
      if (ptbClosed) return violation(row.sequence, `suspectedHumanStop true for pane ${paneId} closed by PTB`);
    }
  }
  return pass();
}
