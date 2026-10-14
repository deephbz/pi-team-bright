/**
 * Exhaustive v3.1 planWorkerEnsure table, with the tightened lead rulings applied.
 *
 * Written from the spec, not from production code:
 *   - docs/journal/2026-10-12-state-ownership-and-liveness-proposal.md
 *     ("Carrier Observation" → "`planWorkerEnsure` reads `launch` and `process`")
 *   - docs/journal/2026-10-12-deterministic-simulation-verification.md
 *     (mutants M1: shell-based isAlive drives reuse; M2: prepared + live shell
 *     refuses retry after a decisive refusal)
 *   - docs/journal/2026-10-12-v31-implementation-plan.md
 *     ("Lead rulings on planWorkerEnsure gaps", tightened: G1, G2, G3, G4, G10)
 *
 * Plan input: binding × launch × process × lastStop = 240 combinations, plus
 * `readmitted` for lastStop `reload` (2 values, 40 base inputs): 280 inputs.
 * Terminal (pane / shell) is not a plan input; the spec says planWorkerEnsure never
 * reads it. Today's function takes only a shell probe, so each input runs with both
 * shell probe values (live, missing): 560 cases. Also: 5 G10 evidence cases and 4 G8
 * carriers, each × 2 shells.
 *
 * Rulings applied:
 *   G1  bound, lastStop new|resume|fork → attention, reason session_switched (no hint ruled)
 *   G2  bound, lastStop reload, process live, not re-admitted → attention, reason
 *       reload_pending, hint wait. Re-admitted → reuse.
 *   G2  bound, lastStop quit, process live → attention, reason stopping (no hint ruled)
 *   G3  unbound, launch none, process gone → create (no candidate).
 *       With a candidate: process live|stopping → candidate_live (G4 rule);
 *       process unknown → verifier_unknown (G4 rule).
 *   G4  unbound, launch refused, process live|stopping → attention, reason candidate_live,
 *       hint wait
 *   G4  unbound, launch refused, process unknown → attention, reason verifier_unknown,
 *       hint ask_human
 *   G5  unbound: lastStop ignored; the launch row decides
 *   G6  "Herdr unknown" in the prepared row is launch unknown; terminal never read
 *   G7  action vocabulary: attention (reason, nextActionHint); refuse (reason)
 *   G8  absent → create; invalid carrier → refuse with today's reason
 *   G9  bound: launch ignored
 *   G10 launch refused only from decisive refusal evidence for the current launch id.
 *       stale refusal, timeout and missing Herdr row give launch unknown.
 *
 * Adapter: today's planWorkerEnsure(carrier, observation) has no launch, process,
 * lastStop, or readmitted input. The adapter maps the binding to a bound carrier, or
 * to a prepared carrier when launch is not none. Launch none is an unbound carrier
 * with no pending launch, which today's code normalizes as invalid. The shell probe
 * is the observation.
 * Attribution of disagreeing cases:
 *   - M2: unbound, launch refused, shell live. Today refuses (`unbound_live`).
 *   - M1: other bound and prepared disagreements. Today's decision follows the shell
 *     probe, not the process verifier or re-admission.
 *   - unattributed: unbound, launch none. Today refuses; the G3 ruling says create or
 *     attention. Neither M1 nor M2 describes this, so it is labelled as such.
 * A disagreeing case is it.fails. The title names its mutant. When production agrees,
 * the it.fails turns red and the marker must be removed.
 *
 * Remaining gaps, not decided by any ruling. Only what is stated is asserted:
 *   R1  Hints for G1 and G2-quit attention, and for the attention rows without a
 *       ruling (bound stopping|unknown; prepared requested|started|unknown). Not asserted.
 *   R2  Reasons for those same attention rows. Not asserted.
 *   R3  readmitted applies only to bound + reload + live. Its effect on reload with
 *       gone, stopping or unknown is not ruled. Those rows use the process rules.
 *       "An older re-admission never clears a newer stop" needs a stop sequence, which
 *       the input does not carry; it is not modelled.
 *   R4  G3 says "process gone or none". v3.1 process has no `none`, so only gone is
 *       tested.
 *   R5  G10 classification is a spec function in this file. No production classifier
 *       exists for it to test against.
 */
import { describe, expect, it } from "vitest";
import type { Member } from "../team-authority/contracts";
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
const REFUSAL_EVIDENCE = [
  "decisive_current_launch",
  "stale_other_launch",
  "timeout",
  "missing_herdr_row",
] as const;

type V31Binding = (typeof BINDINGS)[number];
type V31Launch = (typeof LAUNCHES)[number];
type V31Process = (typeof PROCESSES)[number];
type V31LastStop = (typeof LAST_STOPS)[number];
type ShellProbe = (typeof SHELLS)[number];
export type RefusalEvidence = (typeof REFUSAL_EVIDENCE)[number];

/**
 * v3.1 plan input. `terminal` is deliberately absent (see header).
 * `readmitted` is set only when lastStop is `reload`: whether the exact generation has
 * re-admitted after that stop.
 */
export interface V31PlanInput {
  binding: V31Binding;
  launch: V31Launch;
  process: V31Process;
  lastStop: V31LastStop;
  readmitted?: boolean;
  tokenless?: boolean;
}

/** Expected action in the v3.1 vocabulary (G7). */
export type V31Expected =
  | { kind: "create" }
  | { kind: "reuse" }
  | { kind: "recover"; mode: WorkerRecoveryMode }
  | { kind: "attention"; reason?: string; nextActionHint?: "ensure_worker" | "ask_human" | "wait" }
  | { kind: "refuse"; reason: string };

/** Today's output, mapped one-to-one from WorkerEnsurePlan. */
export type TodayAction =
  | { kind: "create" }
  | { kind: "attention"; reason: string; nextActionHint: string }
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

/** G10: launch refused only from decisive refusal evidence for the current launch id. */
export function classifyLaunchRefusal(evidence: RefusalEvidence): "refused" | "unknown" {
  return evidence === "decisive_current_launch" ? "refused" : "unknown";
}

/** Spec table with the tightened lead rulings applied. Every v3.1 input has one expected action. */
export function specRow(input: V31PlanInput): { expected: V31Expected; row: string } {
  if (input.binding === "bound") {
    if (input.tokenless) return { expected: { kind: "attention", reason: "legacy_unverified", nextActionHint: "ask_human" }, row: "bound / token-less legacy generation (G11)" };
    // G1: the process left this Worker Session. No reuse, no spawn.
    if (input.lastStop === "new" || input.lastStop === "resume" || input.lastStop === "fork") {
      return { expected: { kind: "attention", reason: "session_switched" }, row: "bound / lastStop new|resume|fork (G1)" };
    }
    // G2: reload is held until re-admission. Only then does the bound + live row reuse.
    if (input.process === "live" && input.lastStop === "reload") {
      if (input.readmitted) return { expected: { kind: "reuse" }, row: "bound / live / reload, re-admitted (G2)" };
      return {
        expected: { kind: "attention", reason: "reload_pending", nextActionHint: "wait" },
        row: "bound / live / reload, before re-admission (G2)",
      };
    }
    if (input.process === "live" && input.lastStop === "quit") {
      return { expected: { kind: "attention", reason: "stopping" }, row: "bound / live / lastStop quit (G2)" };
    }
    switch (input.process) {
      case "live":
        return { expected: { kind: "reuse" }, row: "bound / process live" };
      case "gone":
        return { expected: { kind: "recover", mode: "exact_session_resume" }, row: "bound / process gone" };
      case "stopping":
      case "unknown":
        return { expected: { kind: "attention" }, row: "bound / process stopping|unknown" };
    }
  }

  // G5: lastStop is ignored for unbound carriers. G9: launch is ignored for bound ones.
  switch (input.launch) {
    case "none":
      // G3: create only with no candidate. Otherwise the G4 rows apply.
      if (input.process === "gone") return { expected: { kind: "create" }, row: "unbound / launch none / gone (G3)" };
      if (input.process === "unknown") {
        return {
          expected: { kind: "attention", reason: "verifier_unknown", nextActionHint: "ask_human" },
          row: "unbound / launch none / candidate, verifier unknown (G3 → G4)",
        };
      }
      return {
        expected: { kind: "attention", reason: "candidate_live", nextActionHint: "wait" },
        row: "unbound / launch none / candidate live or stopping (G3 → G4)",
      };
    case "refused":
      if (input.process === "gone") {
        return {
          expected: { kind: "recover", mode: "first_binding_retry" },
          row: "prepared / launch refused / process gone",
        };
      }
      if (input.process === "unknown") {
        return {
          expected: { kind: "attention", reason: "verifier_unknown", nextActionHint: "ask_human" },
          row: "prepared / launch refused / process unknown (G4)",
        };
      }
      return {
        expected: { kind: "attention", reason: "candidate_live", nextActionHint: "wait" },
        row: "prepared / launch refused / process live|stopping (G4)",
      };
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
  if (input.launch === "none") return { kind: "unbound", member: member({ pendingLaunchId: undefined }), membershipId: "membership-1" };
  return normalizeWorkerCarrier(member({ pendingLaunchId: "launch-1" }));
}

/** Today's planWorkerEnsure, fed from the v3.1 binding and the shell probe only. */
export function runToday(input: V31PlanInput, shell: ShellProbe): TodayAction {
  return toTodayAction(planWorkerEnsure(carrierFor(input), { ...input, generation: input.tokenless ? {} : { osBirthToken: "birth" } }));
}

function toTodayAction(plan: WorkerEnsurePlan): TodayAction {
  switch (plan.action) {
    case "attention": return { kind: "attention", reason: plan.reason, nextActionHint: plan.nextActionHint };
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
        for (const lastStop of LAST_STOPS) {
          if (lastStop === "reload") {
            inputs.push({ binding, launch, process, lastStop, readmitted: false });
            inputs.push({ binding, launch, process, lastStop, readmitted: true });
          } else {
            inputs.push({ binding, launch, process, lastStop });
          }
        }
  // A token-less generation cannot be verified live/gone. G11 adds only its
  // reachable bound/unknown rows; all previously specified rows stay unchanged.
  inputs.push(...inputs.filter(input => input.binding === "bound" && input.process === "unknown").map(input => ({ ...input, tokenless: true })));
  return inputs;
}

const label = (input: V31PlanInput) =>
  `binding=${input.binding} launch=${input.launch} process=${input.process} lastStop=${input.lastStop}` +
  (input.readmitted === undefined ? "" : ` readmitted=${input.readmitted}`) + (input.tokenless ? " tokenless=true" : "");

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
  else it(`[${mutant ?? "unattributed"}] ${title}`, check);
}

describe("v3.1 planWorkerEnsure table (exhaustive)", () => {
  const inputs = enumerateInputs();

  it("enumerates every v3.1 plan input, each with one expected action", () => {
    expect(inputs).toHaveLength(315);
    expect(inputs.map((input) => specRow(input).expected)).toHaveLength(315);
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

  describe("G10 refusal evidence", () => {
    for (const evidence of REFUSAL_EVIDENCE) {
      const launch = classifyLaunchRefusal(evidence);
      const input: V31PlanInput = { binding: "unbound", launch, process: "gone", lastStop: "none" };
      for (const shell of SHELLS) {
        registerCase(
          `[G10 ${evidence}] launch=${launch} process=gone shell=${shell} — spec row "${specRow(input).row}"`,
          mutantFor(input, shell),
          () => expect(runToday(input, shell)).toMatchObject(specRow(input).expected),
        );
      }
    }
  });

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
