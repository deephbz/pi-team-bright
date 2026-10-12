import type { SimProcess } from "../process-table";

/** One entry as `SimWorld.record` writes it. `value` is untyped in the simulator. */
export interface HistoryEntry {
  at: number;
  actor: string;
  kind: string;
  value?: unknown;
}

/** World truth available from a replay: the process table history and the history log. */
export interface WorldTruth {
  history: readonly HistoryEntry[];
  processes: readonly SimProcess[];
}

/** A coverage witness for a `sometimes` property (S1–S6). Absence fails the campaign. */
export type Witness<T> = { present: true; evidence: T } | { present: false };
