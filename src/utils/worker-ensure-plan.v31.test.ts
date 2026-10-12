/**
 * Exhaustive v3.1 planWorkerEnsure table.
 *
 * Written from the spec, not from production code:
 *   - docs/journal/2026-10-12-state-ownership-and-liveness-proposal.md
 *     ("Carrier Observation" → "`planWorkerEnsure` reads `launch` and `process`")
 *   - docs/journal/2026-10-12-deterministic-simulation-verification.md
 *     (mutant gate: M1 shell-based isAlive drives reuse; M2 prepared + live shell
 *     refuses retry after a decisive refusal)
 *
 * Plan input: binding × launch × process × lastStop = 2 × 5 × 4 × 6 = 240 combinations.
 * Defined: 63 inputs, run with both shell probe values = 126 cases.
 * Undefined: 177 inputs, it.todo (gaps G1–G5).
 * Terminal (pane / shell) is not a plan input; the spec says planWorkerEnsure never
 * reads it. Today's function takes only a shell probe, so each defined combination
 * runs with both shell probe values (live, missing).
 * Disagreeing cases at first run: 105 (M1 104, M2 1); 21 agree.
 *
 * Adapter: today's planWorkerEnsure(carrier, observation) has no launch, process, or
 * lastStop input. The adapter maps `binding` to a prepared or bound carrier and passes
 * the shell probe as the observation. Disagreements are attributed as follows:
 *   - M2: prepared, launch refused, shell live. Today refuses (`unbound_live`); the
 *     spec retries after the decisive refusal.
 *   - M1: every other disagreement. Today's decision follows the shell probe, not
 *     the process verifier. M1 names reuse; the same defect also drives recover and
 *     refuse here.
 * A disagreeing row is it.fails: the row name and mutant id are in the test title.
 * When production agrees with the spec, the it.fails turns red, and the marker must
 * be removed.
 *
 * Expected actions use the spec's vocabulary: reuse, recover(mode), attention.
 * Today's refuse has no attention channel, so a row that expects attention and gets
 * refuse counts as a disagreement.
 *
 * Spec gaps. These rows are it.todo and invent no answer:
 *   G1  bound, lastStop ∈ {new, resume, fork}, any process. The ask-human row
 *       conflicts with the process rows: live → reuse, gone → recover into the same
 *       exact Session. The walkthrough says "binding is dead, ask human" for live.
 *   G2  bound, lastStop ∈ {quit, reload}, process live. Stop evidence implies
 *       `stopping` (rank 2), so live with stop evidence is not defined.
 *   G3  unbound, launch none. No row. No pending launch marker is defined.
 *   G4  unbound, launch refused, process live | stopping | unknown. The retry spawns,
 *       and the prepared row has no process qualifier. Rule 5 says unknown never
 *       authorizes a spawn. A live or stopping Worker process has no stated rule.
 *       Only process gone is defined (verified absence, rank 1).
 *   G5  unbound, lastStop ≠ none. The lastStop rows are bound-only.
 *   G6  Prepared row says "or Herdr unknown", but planWorkerEnsure never reads the
 *       terminal. Terminal input is treated as ignored, and the conflict is open.
 *   G7  The spec's attention and ask_human outcomes are not in today's
 *       WorkerEnsureAction vocabulary (create | reuse | recover | refuse).
 *   G8  No row for an absent carrier (create), or for today's invalid carriers
 *       (missing_membership_id, both_session_and_pending_launch, ...).
 *   G9  Bound rows ignore launch. The table's bound rows have no launch column.
 *       This is an inference from the table layout, not an explicit statement.
 *   G10 "Prior refusal evidence" maps to launch = refused. The spec has no separate
 *       evidence field, and "evidence kept" is not modeled.
 */
import { describe, expect, it } from "vitest";
import type { Member } from "./models";
import {
  normalizeWorkerCarrier,
  planWorkerEnsure,
  type WorkerEnsurePlan,
  type WorkerRecoveryMode,
} from "./worker-ensure-lifecycle";

const BINDINGS = ["unbound", "bound"] as const;
const LAUNCHES = ["none", "requested", "started", "refused", "unknown"] as const;
const PROCESSES = ["live", "stopping", "gone", "unknown"] as const;
const LAST_STOPS = ["none", "quit", "reload", "new", "resume", "fork"] as const;
const SHELLS = ["live", "missing"] as const;

type V31Binding = (typeof BINDINGS)[number];
type V31Launch = (typeof LAUNCHES)[number];
type V31Process = (typeof PROCESSES)[number];
type V31LastStop = (typeof LAST_STOPS)[number];
type ShellProbe = (typeof SHELLS)[number];

/** v3.1 plan input. `terminal` is deliberately absent (see header). */
export interface V31PlanInput {
  binding: V31Binding;
  launch: V31Launch;
  process: V31Process;
  lastStop: V31LastStop;
}

/** Expected action in the spec's vocabulary. */
export type V31Expected =
  | { kind: "reuse" }
  | { kind: "recover"; mode: WorkerRecoveryMode }
  | { kind: "attention" };

/** Today's output, mapped one-to-one from WorkerEnsurePlan. */
export type TodayAction =
  | { kind: "create" }
  | { kind: "reuse" }
  | { kind: "recover"; mode: WorkerRecoveryMode }
  | { kind: "refuse"; reason: string };

export type SpecRow =
  | { defined: true; expected: V31Expected; row: string }
  | { defined: false; gap: string };

const member = (overrides: Partial<Member> = {}): Member => ({
  membershipId: "membership-1",
  pendingLaunchId: "launch-1",
  agentId: "worker@team",
  name: "worker",
  agentType: "teammate",
  joinedAt: 1,
  cwd: "/workspace",
  subscriptions: [],
  isActive: true,
  ...overrides,
});

/** Spec table as a function of the v3.1 input. */
export function specRow(input: V31PlanInput): SpecRow {
  if (input.binding === "bound") {
    if (input.lastStop === "new" || input.lastStop === "resume" || input.lastStop === "fork") {
      return { defined: false, gap: "G1" };
    }
    if ((input.lastStop === "quit" || input.lastStop === "reload") && input.process === "live") {
      return { defined: false, gap: "G2" };
    }
    switch (input.process) {
      case "live":
        return { defined: true, expected: { kind: "reuse" }, row: "bound / process live" };
      case "gone":
        return {
          defined: true,
          expected: { kind: "recover", mode: "exact_session_resume" },
          row: "bound / process gone",
        };
      case "stopping":
      case "unknown":
        return { defined: true, expected: { kind: "attention" }, row: "bound / process stopping|unknown" };
    }
  }

  if (input.lastStop !== "none") return { defined: false, gap: "G5" };
  switch (input.launch) {
    case "none":
      return { defined: false, gap: "G3" };
    case "refused":
      if (input.process !== "gone") return { defined: false, gap: "G4" };
      return {
        defined: true,
        expected: { kind: "recover", mode: "first_binding_retry" },
        row: "prepared / launch refused",
      };
    case "requested":
    case "started":
    case "unknown":
      return { defined: true, expected: { kind: "attention" }, row: "prepared / launch requested|started|unknown" };
  }
}

/** Today's planWorkerEnsure, fed from the v3.1 binding and the shell probe only. */
export function runToday(input: V31PlanInput, shell: ShellProbe): TodayAction {
  const carrier =
    input.binding === "bound"
      ? normalizeWorkerCarrier(member({ sessionFile: "/sessions/worker.jsonl", pendingLaunchId: undefined }))
      : normalizeWorkerCarrier(member({ pendingLaunchId: "launch-1" }));
  return toTodayAction(planWorkerEnsure(carrier, shell));
}

function toTodayAction(plan: WorkerEnsurePlan): TodayAction {
  switch (plan.action) {
    case "create":
      return { kind: "create" };
    case "reuse":
      return { kind: "reuse" };
    case "recover":
      return { kind: "recover", mode: plan.recoveryMode };
    case "refuse":
      return { kind: "refuse", reason: plan.reason };
  }
}

/** Mutant attribution for a disagreeing row (see header). */
export function mutantFor(input: V31PlanInput, shell: ShellProbe): "M1" | "M2" {
  return input.binding === "unbound" && input.launch === "refused" && shell === "live" ? "M2" : "M1";
}

export function enumerateInputs(): V31PlanInput[] {
  const inputs: V31PlanInput[] = [];
  for (const binding of BINDINGS)
    for (const launch of LAUNCHES)
      for (const process of PROCESSES)
        for (const lastStop of LAST_STOPS) inputs.push({ binding, launch, process, lastStop });
  return inputs;
}

const label = (input: V31PlanInput) =>
  `binding=${input.binding} launch=${input.launch} process=${input.process} lastStop=${input.lastStop}`;

/**
 * Rows named by the product review. Each row's test title carries the scenario, so
 * the first expected failure reads as the incident.
 */
const OWNER_SCENARIO_ROWS: Record<string, string> = {
  // Scenario 2: Worker bound, Pi dead, shell still live. Today's plan reuses it.
  "binding=bound launch=started process=gone lastStop=none": "owner scenario 2",
  // Scenario 1: prepared, start never completed, shell reads live. Today refuses unbound_live.
  "binding=unbound launch=requested process=gone lastStop=none": "owner scenario 1",
};

describe("v3.1 planWorkerEnsure table (exhaustive)", () => {
  const inputs = enumerateInputs();

  it("enumerates every v3.1 plan input and classifies each one", () => {
    const defined = inputs.filter((input) => specRow(input).defined);
    expect(inputs).toHaveLength(240);
    expect(defined).toHaveLength(63);
  });

  for (const input of inputs) {
    const spec = specRow(input);
    if (!spec.defined) {
      it.todo(`${label(input)} — spec undefined (${spec.gap}); see file header`);
      continue;
    }
    for (const shell of SHELLS) {
      const scenario = OWNER_SCENARIO_ROWS[label(input)];
      const title = `${scenario ? `[${scenario}] ` : ""}${label(input)} shell=${shell} — spec row "${spec.row}"`;
      const check = () => expect(runToday(input, shell)).toEqual(spec.expected);
      // Disagreeing rows are it.fails and name their mutant in the title (see header).
      const agrees = (() => {
        try {
          check();
          return true;
        } catch {
          return false;
        }
      })();
      if (agrees) {
        it(title, check);
      } else {
        it.fails(`[${mutantFor(input, shell)}] ${title}`, check);
      }
    }
  }
});
