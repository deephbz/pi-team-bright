import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import type { Member, TerminalTarget } from "./contracts";
import {
  applyMembershipPatch, currentLaunchId, launchFence, mayOwnProcess, parseMembership, transitionMembership,
  type CarrierLaunchKind, type MembershipEvent, type MembershipState,
} from "./membership-machine";

/**
 * Exhaustive breadth-first exploration of the Membership machine. Nodes are
 * on-disk Member records, so every step also checks that the field patch and
 * the parsed next state agree.
 */

const T1: TerminalTarget = { backend: "herdr", kind: "pane", targetId: "p1" };
const T2: TerminalTarget = { backend: "herdr", kind: "pane", targetId: "p2" };
const MAX_LAUNCHES = 3;
const base = (): Member => ({ membershipId: "m1", agentId: "w@t", name: "w", agentType: "teammate", joinedAt: 0, cwd: "/", subscriptions: [], isActive: true });

/** Current writers and every older shape still on disk. */
const initialRecords: Record<string, Member> = {
  prepared: { ...base(), pendingLaunchId: "L1", launch: { launchId: "L1", state: "requested", requestedAt: 0 } },
  legacyPreparedNoLaunch: { ...base(), pendingLaunchId: "L1" },
  legacyBoundNoLaunch: { ...base(), sessionFile: "S1", tmuxPaneId: "%1" },
  boundWithTarget: { ...base(), sessionFile: "S1", terminalTarget: T1, launch: { launchId: "L1", state: "started", requestedAt: 0, observedAt: 1 } },
  invalidBoth: { ...base(), sessionFile: "S1", pendingLaunchId: "L1" },
  invalidNoId: { ...base(), membershipId: undefined, sessionFile: "S1" },
};

function launchesUsed(member: Member): number {
  return Number((member.launch?.launchId ?? member.pendingLaunchId ?? "L0").slice(1));
}

function alphabet(member: Member, carrier: CarrierLaunchKind): MembershipEvent[] {
  const state = parseMembership(member);
  const current = currentLaunchId(state) ?? "L1";
  const used = launchesUsed(member);
  const stale = `L${Math.max(0, used - 1)}`;
  const t = (member.launch?.requestedAt ?? 0);
  const times = [t + 1, t + 15000];
  const events: MembershipEvent[] = [];
  if (used < MAX_LAUNCHES) for (const at of times) {
    events.push({ type: "relaunch", launchId: `L${used + 1}`, at, carrier });
    events.push({ type: "relaunch", launchId: `L${used + 1}`, at, carrier, prior: { pid: 7, osBirthToken: "b", bootId: "k" } });
  }
  for (const launchId of new Set([current, stale])) {
    events.push({ type: "record_target", launchId, target: T1 });
    for (const state of ["started", "refused", "unknown"] as const) {
      events.push({ type: "complete_launch", launchId, result: { state, fact: state }, at: t + 2 });
      events.push({ type: "complete_launch", launchId, result: { state, fact: state }, at: t + 2, target: T2 });
    }
  }
  for (const sessionFile of ["S1", "S2"]) for (const launchId of [undefined, current, stale]) {
    events.push({ type: "bind_session", sessionFile, launchId, at: t + 3 });
    events.push({ type: "bind_session", sessionFile, launchId, at: t + 3, placement: { terminalTarget: T2 } });
  }
  events.push({ type: "relocate", placement: { terminalTarget: T2 } });
  for (const authority of ["process_stopped", "no_process_possible", "session_left"] as const) {
    events.push({ type: "deactivate", reason: "process_shutdown", at: t + 4, authority, carrier });
  }
  return events;
}

function key(member: Member): string {
  return JSON.stringify(Object.fromEntries(Object.entries(member).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))));
}

type Violation = { invariant: string; from: Member; event: MembershipEvent; to?: Member };
interface Exploration { states: number; transitions: number; applied: number; violations: Violation[]; humanOnly: MembershipState[]; invalid: MembershipState[] }

/**
 * Stop needs no process (A), a target to kill (B), or a bound Session with
 * runtime exit evidence (C). The rc.4 stop path had only B and C.
 */
type StopRules = "machine" | "rc4";
function stoppable(state: MembershipState, carrier: CarrierLaunchKind, rules: StopRules): boolean {
  if (state.kind === "inactive") return true;
  if (rules === "machine" && !mayOwnProcess(state, carrier)) return true;
  if (state.kind === "prepared" || state.kind === "bound") return state.target !== undefined || state.kind === "bound";
  return false;
}

function explore(carrier: CarrierLaunchKind, rules: StopRules = "machine"): Exploration {
  const seen = new Map<string, Member>();
  const queue: Member[] = [];
  for (const record of Object.values(initialRecords)) { seen.set(key(record), record); queue.push(record); }
  const result: Exploration = { states: 0, transitions: 0, applied: 0, violations: [], humanOnly: [], invalid: [] };
  const fail = (invariant: string, from: Member, event: MembershipEvent, to?: Member) => result.violations.push({ invariant, from, event, to });
  while (queue.length) {
    const member = queue.shift()!;
    const state = parseMembership(member);
    result.states++;
    // Invalid records are human-only by design: the machine refuses to interpret them.
    if (state.kind === "invalid") result.invalid.push(state);
    else if (!stoppable(state, carrier, rules)) result.humanOnly.push(state);
    for (const event of alphabet(member, carrier)) {
      result.transitions++;
      const step = transitionMembership(state, event);
      if (state.kind === "inactive" && step.kind !== "refused") fail("inactive_absorbing", member, event);
      if (event.type === "complete_launch" && event.launchId !== launchFence(state)?.launchId && step.kind !== "unchanged" && state.kind !== "inactive" && state.kind !== "invalid") fail("stale_completion_inert", member, event);
      if (step.kind !== "applied") continue;
      result.applied++;
      const next = applyMembershipPatch(member, step.patch);
      const parsed = parseMembership(next);
      if (!isDeepStrictEqual(parsed, step.state)) fail("projection_sound", member, event, next);
      if (parsed.kind === "prepared" && parsed.launch && member.launch?.launchId === member.pendingLaunchId && parsed.launch.launchId !== parsed.capability) fail("capability_matches_launch", member, event, next);
      if (state.kind === "bound" && parsed.kind !== "inactive" && (parsed.kind !== "bound" || parsed.sessionFile !== state.sessionFile)) fail("session_immutable", member, event, next);
      // Only a refusal, which asserts that no process started for this launch, may clear the possibility.
      const noProcessEvidence = event.type === "complete_launch" && event.launchId === launchFence(state)?.launchId && event.result.state === "refused";
      if (mayOwnProcess(state, carrier) && parsed.kind !== "inactive" && !mayOwnProcess(parsed, carrier) && !noProcessEvidence) fail("process_not_forgotten", member, event, next);
      if (event.type === "deactivate" && event.authority === "no_process_possible" && mayOwnProcess(state, carrier)) fail("no_process_authority", member, event, next);
      const k = key(next);
      if (!seen.has(k)) { seen.set(k, next); queue.push(next); }
    }
  }
  return result;
}

describe("Membership machine exhaustive exploration", () => {
  for (const carrier of ["two_stage", "one_stage"] as const) {
    it(`holds every invariant for ${carrier} carriers`, () => {
      const result = explore(carrier);
      expect(result.violations.slice(0, 3)).toEqual([]);
      expect(result.states).toBeGreaterThan(100);
      console.info(`[membership-machine] ${carrier}: ${result.states} states, ${result.transitions} transitions, ${result.applied} applied, ${result.humanOnly.length} human-only`);
    });
  }

  it("limits two-stage human-only states to pre-rc.1 prepared records", () => {
    // A prepared record without `launch` predates target-before-start ordering, so its process ownership is unknown.
    expect(explore("two_stage").humanOnly).toEqual([{ kind: "prepared", capability: "L1" }]);
  });

  it("reproduces the rc.4 wedge: target-less prepared Memberships could not be stopped", () => {
    const humanOnly = explore("two_stage", "rc4").humanOnly;
    expect(humanOnly.length).toBeGreaterThan(0);
    expect(humanOnly.every(state => state.kind === "prepared" && state.target === undefined)).toBe(true);
    expect(humanOnly.some(state => state.kind === "prepared" && state.launch?.phase === "refused")).toBe(true);
    console.info(`[membership-machine] rc.4 stop rules on two_stage: ${humanOnly.length} human-only states`);
  });

  it("limits one-stage human-only states to unrecorded process starts", () => {
    const humanOnly = explore("one_stage").humanOnly;
    expect(humanOnly.length).toBeGreaterThan(0);
    for (const state of humanOnly) {
      expect(state.kind).toBe("prepared");
      if (state.kind !== "prepared") continue;
      expect(state.target).toBeUndefined();
      expect(state.launch?.phase).not.toBe("refused");
    }
  });
});
