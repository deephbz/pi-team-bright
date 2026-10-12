export type { HistoryEntry } from "../history";

/**
 * Verdict for a `always` or `eventually` property. `not_applicable` names the
 * missing input. It is never a pass.
 */
export type Verdict =
  | { status: "pass" }
  | { status: "violation"; sequence: number; detail: string }
  | { status: "not_applicable"; missing: string };

/** Verdict for a `sometimes` witness (S1–S6). `absent` fails the campaign. */
export type WitnessVerdict =
  | { status: "witnessed"; sequence: number; detail: string }
  | { status: "absent" }
  | { status: "not_applicable"; missing: string };
