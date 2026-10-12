/**
 * Exhaustive v3.1 planWorkerEnsure table, with the lead rulings applied.
 *
 * Written from the spec, not from production code:
 *   - docs/journal/2026-10-12-state-ownership-and-liveness-proposal.md
 *     ("Carrier Observation" → "`planWorkerEnsure` reads `launch` and `process`")
 *   - docs/journal/2026-10-12-deterministic-simulation-verification.md
 *     (mutants M1: shell-based isAlive drives reuse; M2: prepared + live shell
 *     refuses retry after a decisive refusal)
 *   - docs/journal/2026-10-12-v31-implementation-plan.md
 *     ("Lead rulings on planWorkerEnsure gaps", G1–G10)
 *
 * Plan input: binding × launch × process × lastStop = 2 × 5 × 4 × 6 = 240 combinations.
 * Every combination is now defined. Terminal (pane / shell) is not a plan input;
 * the spec says planWorkerEnsure never reads it. Today's function takes only a shell
 * probe, so each combination runs with both shell probe values (live, missing): 480
 * cases. The absent and invalid carrier cases (G8) are separate: 4 carriers × 2 shells.
 *
 * Rulings applied (G-number → rows):
 *   G1  bound, lastStop new|resume|fork → attention, reason session_switched (all process, launch)
 *   G2  bound, lastStop reload, process live → reuse
 *   G2  bound, lastStop quit, process live → attention, reason stopping
 *   G3  unbound, launch none → create (all process, lastStop)
 *   G4  unbound, launch refused, process live|stopping|unknown → attention
 *   G5  unbound: lastStop ignored; the launch row decides
 *   G6  "Herdr unknown" in the prepared row is launch unknown; terminal never read
 *   G7  action vocabulary adds attention (reason, nextActionHint) and refuse(reason)
 *   G8  absent → create; invalid carrier → refuse with today's reason
 *   G9  bound: launch ignored
 *   G10 prior refusal evidence = launch refused
 *
 * Adapter: today's planWorkerEnsure(carrier, observation) has no launch, process, or
 * lastStop input. The adapter maps the binding to a bound carrier, or to a prepared
 * carrier when launch is not none. Launch none is an unbound carrier with no pending
 * launch, which today's code normalizes as invalid. The shell probe is the observation.
 * Attribution of disagreeing cases:
 *   - M2: unbound, launch refused, shell live. Today refuses (`unbound_live`); the
 *     spec retries when process is gone and attends otherwise.
 *   - M1: other bound and prepared disagreements. Today's decision follows the shell
 *     probe, not the process verifier.
 *   - unattributed: unbound, launch none. Today refuses; the G3 ruling says create.
 *     Neither M1 nor M2 describes this, so it is labelled as such. The lead decides.
 * A disagreeing case is it.fails. The title names its mutant. When production agrees,
 * the it.fails turns red and the marker must be removed.
 *
 * Remaining gaps. No ruling decides these, so they are asserted only where stated:
 *   R1  nextActionHint is in the attention vocabulary (G7), but no ruling says which
 *       hint each attention row carries. Hints are not asserted.
 *   R2  attention reason: G1 and G2 rulings give reasons. The other attention rows
 *       (bound stopping|unknown, G4, prepared requested|started|unknown) have no
 *       ruled reason. Only kind is asserted for them.
 *   R3  G3 "create" with process live|stopping|unknown conflicts with rule 5
 *       ("unknown never authorizes a spawn"). Encoded as ruled; flagged for the lead.
 *   R4  G3 with launch none: today refuses (`missing_session_and_pending_launch`).
 *       Whether the ruling means "no membership at all" is not stated.
 */
import { describe, expect, it } from "vitest";
import type { Member } from "./models";
import {
  normalizeWorkerCarrier,
  planWorkerEnsure,
  type WorkerCarrierState,
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

/** Expected action in the v3.1 vocabulary (G7). `attention` and `refuse` carry a reason. */
export type V31Expected =
  | { kind: "create" }
  | { kind: "reuse" }
  | { kind: "recover"; mode: WorkerRecoveryMode }
  | { kind: "attention"; reason?: string; nextActionHint?: "ensure_worker" | "ask_human" | "wait" }
  | { kind: "refuse"; reason: string };

/** Today's output, mapped one-to-one from WorkerEnsurePlan. */
export type TodayAction =
  | { kind: "create" }
  | { kind: "reuse" }
  | { kind: "recover"; mode: WorkerRecoveryMode }
  | { kind: "refuse"; reason: string };

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

/** Spec table with the lead rulings applied. Every v3.1 input has exactly one expected action. */
export function specRow(input: V31PlanInput): { expected: V31Expected; row: string } {
  if (input.binding === "bound") {
    // G1: the process left this Worker Session. No reuse, no spawn.
    if (input.lastStop === "new" || input.lastStop === "resume" || input.lastStop === "fork") {
      return { expected: { kind: "attention", reason: "session_switched" }, row: "bound / lastStop new|resume|fork (G1)" };
    }
    // G2: reload keeps the generation; quit never spawns while the generation lives.
    if (input.process === "live" && input.lastStop === "reload") {
      return { expected: { kind: "reuse" }, row: "bound / live / lastStop reload (G2)" };
    }
    if (input.process === "live" && input.lastStop === "quit") {
      return { expected: { kind: "attention", reason: "stopping" }, row: "bound / live / lastStop quit (G2)" };
    }
    switch (input.process) {
      case "live":
        return { expected: { kind: "reuse" }, row: "bound / process live" };
      case "gone":
        return {
          expected: { kind: "recover", mode: "exact_session_resume" },
          row: "bound / process gone",
        };
      case "stopping":
      case "unknown":
        return { expected: { kind: "attention" }, row: "bound / process stopping|unknown" };
    }
  }

  // G5: lastStop is ignored for unbound carriers. G9: launch is ignored for bound ones.
  switch (input.launch) {
    case "none":
      // G3
      return { expected: { kind: "create" }, row: "unbound / launch none (G3)" };
    case "refused":
      if (input.process === "gone") {
        return {
          expected: { kind: "recover", mode: "first_binding_retry" },
          row: "prepared / launch refused / process gone",
        };
      }
      // G4
      return { expected: { kind: "attention" }, row: "prepared / launch refused / process live|stopping|unknown (G4)" };
    case "requested":
    case "started":
    case "unknown":
      return { expected: { kind: "attention" }, row: "prepared / launch requested|started|unknown" };
  }
}

/** G8: absent and invalid carriers, as today's normalizer defines them. */
const CARRIER_CASES: ReadonlyArray<{ name: string; persisted: Member | undefined; expected: V31Expected }> = [
  { name: "absent", persisted: undefined, expected: { kind: "create" } },
  {
    name: "invalid missing_membership_id",
    persisted: member({ membershipId: undefined }),
    expected: { kind: "refuse", reason: "missing_membership_id" },
  },
  {
    name: "invalid both_session_and_pending_launch",
    persisted: member({ sessionFile: "/sessions/worker.jsonl" }),
    expected: { kind: "refuse", reason: "both_session_and_pending_launch" },
  },
  {
    name: "invalid missing_session_and_pending_launch",
    persisted: member({ pendingLaunchId: undefined }),
    expected: { kind: "refuse", reason: "missing_session_and_pending_launch" },
  },
];

/** The adapter's carrier for a v3.1 input. See header for the launch-none case. */
function carrierFor(input: V31PlanInput): WorkerCarrierState {
  if (input.binding === "bound") {
    return normalizeWorkerCarrier(member({ sessionFile: "/sessions/worker.jsonl", pendingLaunchId: undefined }));
  }
  if (input.launch === "none") return normalizeWorkerCarrier(member({ pendingLaunchId: undefined }));
  return normalizeWorkerCarrier(member({ pendingLaunchId: "launch-1" }));
}

/** Today's planWorkerEnsure, fed from the v3.1 binding and the shell probe only. */
export function runToday(input: V31PlanInput, shell: ShellProbe): TodayAction {
  return toTodayAction(planWorkerEnsure(carrierFor(input), shell));
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

/** Mutant attribution for a disagreeing case (see header). */
export function mutantFor(input: V31PlanInput, shell: ShellProbe): "M1" | "M2" | "unattributed" {
  if (input.binding === "unbound" && input.launch === "none") return "unattributed";
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

/** Each disagreeing case is checked with it.fails. Agreeing cases use it. */
function registerCase(title: string, mutant: string | undefined, check: () => void) {
  const agrees = (() => {
    try {
      check();
      return true;
    } catch {
      return false;
    }
  })();
  if (agrees) it(title, check);
  else it.fails(`[${mutant ?? "unattributed"}] ${title}`, check);
}

describe("v3.1 planWorkerEnsure table (exhaustive)", () => {
  const inputs = enumerateInputs();

  it("enumerates every v3.1 plan input, each with one expected action", () => {
    expect(inputs).toHaveLength(240);
    expect(inputs.map((input) => specRow(input).expected)).toHaveLength(240);
  });

  for (const input of inputs) {
    const spec = specRow(input);
    for (const shell of SHELLS) {
      const scenario = OWNER_SCENARIO_ROWS[label(input)];
      const title = `${scenario ? `[${scenario}] ` : ""}${label(input)} shell=${shell} — spec row "${spec.row}"`;
      registerCase(title, mutantFor(input, shell), () =>
        expect(runToday(input, shell)).toMatchObject(spec.expected),
      );
    }
  }

  describe("G8 absent and invalid carriers", () => {
    for (const carrier of CARRIER_CASES) {
      for (const shell of SHELLS) {
        registerCase(`${carrier.name} shell=${shell}`, undefined, () =>
          expect(toTodayAction(planWorkerEnsure(normalizeWorkerCarrier(carrier.persisted), shell))).toMatchObject(
            carrier.expected,
          ),
        );
      }
    }
  });
});
