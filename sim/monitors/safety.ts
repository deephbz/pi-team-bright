import type { HistoryEntry, Json, JournalFact, JsonObject } from "../history";
import { genKey, generationOf, liveAt, notApplicable, ofKind, pass, violation, actorKey } from "./util";
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

/** Ruled grace: a served live claim is a violation once its generation has been dead this long (virtual ms). */
export const LIVE_GRACE_MS = 10000;

/** P3 (always): a served `process: live` claim never names a generation world truth held dead for more than 10 s. */
export function p3LiveIsFresh(history: readonly HistoryEntry[]): Verdict {
  const claims = [
    ...ofKind(history, "journal.append").filter(entry => entry.event.raw.field === "process" && entry.event.raw.to === "live")
      .map(entry => ({ sequence: entry.sequence, at: entry.at, generation: entry.event.generation })),
    ...ofKind(history, "tool.result").filter(entry => entry.result.details?.process === "live")
      .map(entry => ({ sequence: entry.sequence, at: entry.at, generation: entry.result.details?.generation })),
  ];
  if (!claims.length) return notApplicable("served process: live claims");
  for (const claim of claims.sort((a, b) => a.sequence - b.sequence)) {
    const generation = generationOf(claim.generation);
    if (!generation) return notApplicable("process: live claims without an exact generation (C2)");
    const death = history.find(entry => entry.kind === "process.death" && entry.sequence < claim.sequence && genKey(entry.process.generation) === genKey(generation));
    if (death && claim.at - death.at > LIVE_GRACE_MS) return violation(claim.sequence, `live claim for a generation dead since ${death.at} ms`);
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

/** P5 (always): every PTB-origin pane close cites a PTB stop request. OS, human, setup and observer closes are not PTB acts. */
export function p5ClosesCited(history: readonly HistoryEntry[]): Verdict {
  const closes = ofKind(history, "pane.close");
  if (!closes.length) return notApplicable("pane closures");
  const teams = ofKind(history, "durable.team");
  const stops = ofKind(history, "tool.call").filter(call => STOP_TOOLS.has(call.name));
  let undecided: string | undefined;
  for (const close of closes) {
    const origin = close.origin;
    if (origin.kind !== "ptb") continue;
    const sameActor = (call: { sequence: number; actor: { team: string; actor: string } }) => call.sequence < close.sequence && actorKey(call.actor) === actorKey(origin.actor);
    if (stops.some(call => sameActor(call) && call.name === "team_shutdown")) continue;
    const workerStops = stops.filter(call => sameActor(call) && call.name === "worker_stop");
    if (!workerStops.length) return violation(close.sequence, `pane ${close.pane.paneId} closed without a stop request`);
    // A Worker stop authorizes only the Worker's current Membership target, read from the latest durable Team record.
    const config = teams.filter(entry => entry.sequence < close.sequence).at(-1)?.record;
    const targets = workerStops.map(call => (typeof call.args.worker === "string" ? currentTargetPane(config, call.args.worker) : undefined));
    if (targets.includes(close.pane.paneId)) continue;
    if (targets.includes(undefined)) {
      undecided ??= `pane ${close.pane.paneId}: no current target evidence for the stopped Worker in durable Team records`;
      continue;
    }
    return violation(close.sequence, `pane ${close.pane.paneId} closed by a stop of another Worker's target`);
  }
  return undecided ? notApplicable(undecided) : pass();
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

/** The observation JSON that follows the first line of a page's text content (production `parseObservationContent` shape). */
function observationPayload(content: unknown): JsonObject | undefined {
  const text = typeof content === "string" ? content : Array.isArray(content) ? (content.find(part => part?.type === "text")?.text as string | undefined) : undefined;
  if (typeof text !== "string") return undefined;
  try {
    const parsed = JSON.parse(text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : undefined;
  } catch { return undefined; }
}

/** Names from rows of observation lists. Each row yields the first of `keys` that holds a string. */
function namesIn(lists: Array<Json | undefined>, keys: string[]): Set<string> {
  const names = new Set<string>();
  for (const rows of lists) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
      const name = keys.map(key => row[key]).find(value => typeof value === "string");
      if (typeof name === "string") names.add(name);
    }
  }
  return names;
}

/** Workers and Tasks a branch page names (snapshot `workers`/`tasks`, update `worker_changes`/`task_changes` rows). */
function pageNames(entry: JsonObject): { workers: Set<string>; tasks: Set<string> } {
  const payload = observationPayload((entry.message as JsonObject | undefined)?.content ?? entry.content);
  return {
    workers: namesIn([payload?.workers, payload?.worker_changes], ["name", "worker"]),
    tasks: namesIn([payload?.tasks, payload?.task_changes], ["id", "task_id"]),
  };
}

/** The Task and version a journal event names (`type: task`, `ref.taskId`, `ref.version`). */
function taskRef(event: JournalFact): { taskId: string; version?: string } | undefined {
  const ref = event.raw.ref as JsonObject | undefined;
  if (event.type !== "task" || typeof ref?.taskId !== "string") return undefined;
  return { taskId: ref.taskId, version: typeof ref.version === "string" ? ref.version : undefined };
}

/** The Task cards (id and version) a branch page or an authority read carries: snapshot `tasks`, update `task_changes[].current`, or a task tool's `task`. */
function taskCards(payload: JsonObject | undefined): Array<[string, string]> {
  const cards: Array<[string, string]> = [];
  const take = (card: Json | undefined) => {
    if (card === null || typeof card !== "object" || Array.isArray(card)) return;
    if (typeof card.id === "string" && typeof card.version === "string") cards.push([card.id, card.version]);
  };
  take(payload?.task);
  if (Array.isArray(payload?.tasks)) payload.tasks.forEach(take);
  if (Array.isArray(payload?.task_changes)) {
    payload.task_changes.forEach(change => take(change !== null && typeof change === "object" && !Array.isArray(change) ? change.current : undefined));
  }
  return cards;
}

/** The latest Task version the branch or an authority read showed at or before a sequence (the page's own cards included). */
function observedTaskVersions(history: readonly HistoryEntry[], before: number): Map<string, string> {
  const versions = new Map<string, string>();
  for (const entry of history) {
    if (entry.sequence > before) continue;
    if (entry.kind === "lead.entry") {
      const payload = observationPayload((entry.entry.message as JsonObject | undefined)?.content ?? entry.entry.content);
      for (const [id, version] of taskCards(payload)) versions.set(id, version);
    } else if (entry.kind === "tool.result") {
      for (const [id, version] of taskCards(entry.result.details)) versions.set(id, version);
    }
  }
  return versions;
}

/** The Membership target pane of a Worker in the durable Team record, or undefined when the record does not prove it. */
function currentTargetPane(record: JsonObject | null | undefined, worker: string): string | undefined {
  const members = record?.members;
  if (!Array.isArray(members)) return undefined;
  for (const member of members) {
    if (member === null || typeof member !== "object" || Array.isArray(member)) continue;
    if (member.name !== worker || member.isActive === false) continue;
    const target = member.terminalTarget;
    return target !== null && typeof target === "object" && !Array.isArray(target) && typeof target.targetId === "string" ? target.targetId : undefined;
  }
  return undefined;
}

/** P8 (always): an eligible journal event below a stamp's cursor is represented by the branch or a snapshot. A page's own range must name each event it covers. */
export function p8CoverageLedger(history: readonly HistoryEntry[]): Verdict {
  const stamps = ofKind(history, "lead.entry").filter(entry => entry.stamp !== undefined);
  if (!stamps.length) return notApplicable("lead observation stamps");
  const events = ofKind(history, "journal.append").filter(entry => entry.event.seq !== undefined);
  if (!events.length) return notApplicable("journal seq fields");
  for (const stamp of stamps) {
    const { team, from, through } = stamp.stamp!;
    const page = pageNames(stamp.entry);
    const observed = observedTaskVersions(history, stamp.sequence);
    for (const event of events) {
      const seq = event.event.seq!;
      if (event.team !== team || seq <= 0 || seq > through || event.sequence > stamp.sequence) continue;
      // A Task version that the branch or an authority read already superseded is not eligible for the page.
      const ref = taskRef(event.event);
      if (ref?.version !== undefined && observed.has(ref.taskId) && observed.get(ref.taskId) !== ref.version) continue;
      if (seq > from) {
        const worker = event.event.worker;
        if (worker !== undefined && !page.workers.has(worker)) {
          return violation(stamp.sequence, `page through ${through} omits event ${seq} (${worker}); M6 class`);
        }
        if (ref !== undefined && !page.tasks.has(ref.taskId)) {
          return violation(stamp.sequence, `page through ${through} omits task event ${seq} (${ref.taskId}); M6 class`);
        }
        continue;
      }
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
