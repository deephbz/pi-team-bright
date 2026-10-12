import type { HistoryEntry } from "../history";
import type { WitnessVerdict } from "./types";
import { absent, ofKind, witnessed, witnessNotApplicable } from "./util";

/** S1 (sometimes): a dead process generation's pid is reused with a new birth token in the same boot. */
export function s1PidReuseWitness(history: readonly HistoryEntry[]): WitnessVerdict {
  const births = ofKind(history, "process.birth");
  if (!births.length) return witnessNotApplicable("process births");
  for (const death of ofKind(history, "process.death")) {
    const dead = death.process.generation;
    const reborn = births.find(
      birth => birth.sequence > death.sequence && birth.process.generation.pid === dead.pid
        && birth.process.generation.bootId === dead.bootId && birth.process.generation.osBirthToken !== dead.osBirthToken,
    );
    if (reborn) return witnessed(reborn.sequence, `pid ${dead.pid} reused with a new birth token`);
  }
  return absent();
}

/** S2 (sometimes): two `ensure_worker` calls overlap, so the second starts before the first receives its result. */
export function s2OverlappingEnsureWitness(history: readonly HistoryEntry[]): WitnessVerdict {
  const calls = ofKind(history, "tool.call").filter(entry => entry.name === "ensure_worker");
  if (!calls.length) return witnessNotApplicable("ensure_worker calls");
  const results = ofKind(history, "tool.result");
  for (const later of calls) {
    const overlap = calls.find(earlier => {
      if (earlier.sequence >= later.sequence) return false;
      const result = results.find(entry => entry.callId === earlier.callId);
      return !result || result.sequence > later.sequence;
    });
    if (overlap) return witnessed(later.sequence, `ensure_worker ${later.callId} started before ${overlap.callId} returned`);
  }
  return absent();
}

/** S3 (sometimes): a pane's shell dies before any durable runtime or launch record is written for it. */
export function s3CrashBeforeRecordWitness(history: readonly HistoryEntry[]): WitnessVerdict {
  const panes = ofKind(history, "pane.create");
  if (!panes.length) return witnessNotApplicable("pane creations");
  const records = history.filter(entry => entry.kind === "durable.runtime" || entry.kind === "durable.launch");
  for (const pane of panes) {
    const death = ofKind(history, "process.death").find(
      entry => entry.sequence > pane.sequence && entry.process.generation.pid === pane.pane.shellPid,
    );
    if (!death) continue;
    if (!records.some(entry => entry.sequence > pane.sequence && entry.sequence < death.sequence)) {
      return witnessed(death.sequence, `shell ${pane.pane.shellPid} of ${pane.pane.paneId} died before any record`);
    }
  }
  return absent();
}

/** S4 (sometimes): a Herdr fault is active while an `ensure_worker` call is outstanding. */
export function s4HerdrLossInLaunchWitness(history: readonly HistoryEntry[]): WitnessVerdict {
  const calls = ofKind(history, "tool.call").filter(entry => entry.name === "ensure_worker");
  if (!calls.length) return witnessNotApplicable("ensure_worker calls");
  const results = ofKind(history, "tool.result");
  const faults = ofKind(history, "fault.set").filter(entry => entry.fault.source === "herdr");
  for (const fault of faults) {
    const call = calls.find(entry => {
      if (entry.sequence >= fault.sequence) return false;
      const result = results.find(item => item.callId === entry.callId);
      return !result || result.sequence > fault.sequence;
    });
    if (call) return witnessed(fault.sequence, `herdr fault during ensure_worker ${call.callId}`);
  }
  return absent();
}

/** S5 (sometimes): a Pi compaction follows a Team-update branch entry. */
export function s5CompactionAfterUpdateWitness(history: readonly HistoryEntry[]): WitnessVerdict {
  const updates = ofKind(history, "lead.entry").filter(entry => entry.entry.customType === "ptb.team-update");
  if (!updates.length) return witnessNotApplicable("ptb.team-update branch entries");
  const compactions = ofKind(history, "world.input").filter(entry => entry.step.kind === "pi.compact");
  for (const update of updates) {
    const after = compactions.find(entry => entry.sequence > update.sequence);
    if (after) return witnessed(after.sequence, "Pi compacted after a Team-update branch entry");
  }
  return absent();
}

/** S6 (sometimes): a journal row marks a suspected human stop. */
export function s6SuspectedHumanStopWitness(history: readonly HistoryEntry[]): WitnessVerdict {
  const rows = ofKind(history, "journal.append").filter(entry => entry.event.suspectedHumanStop !== undefined);
  if (!rows.length) return witnessNotApplicable("journal suspectedHumanStop fields (P10)");
  const row = rows.find(entry => entry.event.suspectedHumanStop === true);
  return row ? witnessed(row.sequence, "suspectedHumanStop true") : absent();
}
