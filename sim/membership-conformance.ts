import { isDeepStrictEqual } from "node:util";
import type { Member, TerminalTarget } from "../src/team-authority/contracts";
import {
  applyMembershipPatch, currentLaunchId, parseMembership, transitionMembership,
  type CarrierLaunchKind, type MembershipEvent, type MembershipState,
} from "../src/team-authority/membership-machine";
import type { HistoryEntry } from "./history";

/**
 * Checks a world history against the Membership machine.
 *
 * State conformance: group raw `durable.team` snapshots by Membership. Each
 * changed snapshot must equal the patch of one applied machine transition from
 * the previous snapshot. The checker builds candidate events from the two
 * snapshots; a match is an event witness, not an observed call. No match is a
 * violation. This is bounded reachability with one step per durable commit.
 *
 * Effect conformance: every `herdr agent start` must follow a snapshot whose
 * active Membership records that pane as its target with a requested launch.
 */

const LIFECYCLE = ["pendingLaunchId", "launch", "sessionFile", "launchConsumedAt", "terminalTarget", "tmuxPaneId", "windowId", "isActive", "deactivatedAt", "deactivationReason"] as const;

export interface TimelineStep { sequence: number; at: number; state: MembershipState; witness: MembershipEvent["type"] | "initial" }
export interface Violation { kind: "unwitnessed_change" | "invalid_first_state" | "unauthorized_start"; membershipId?: string; sequence: number; detail: string }
export interface Conformance { timelines: Map<string, TimelineStep[]>; violations: Violation[]; snapshots: number; changes: number; starts: number }

function lifecycle(member: Member): Record<string, unknown> {
  return Object.fromEntries(LIFECYCLE.filter(key => member[key] !== undefined).map(key => [key, member[key]]));
}

function candidates(prev: Member, next: Member, carrier: CarrierLaunchKind): MembershipEvent[] {
  const state = parseMembership(prev);
  const events: MembershipEvent[] = [];
  const launch = next.launch;
  if (launch) {
    events.push({ type: "relaunch", launchId: launch.launchId, at: launch.requestedAt, carrier, ...(launch.priorGeneration ? { prior: launch.priorGeneration } : {}) });
    if (launch.state !== "requested") {
      const result = { state: launch.state, fact: launch.fact ?? "" };
      const at = launch.observedAt ?? 0;
      events.push({ type: "complete_launch", launchId: launch.launchId, result, at });
      if (next.terminalTarget) events.push({ type: "complete_launch", launchId: launch.launchId, result, at, target: next.terminalTarget });
    }
  }
  const target: TerminalTarget | undefined = next.terminalTarget;
  const launchId = currentLaunchId(state);
  if (target && launchId) events.push({ type: "record_target", launchId, target });
  const placement = { ...(next.terminalTarget ? { terminalTarget: next.terminalTarget } : {}), ...(next.tmuxPaneId ? { tmuxPaneId: next.tmuxPaneId } : {}), ...(next.windowId ? { windowId: next.windowId } : {}) };
  if (next.sessionFile) {
    const at = next.launchConsumedAt ? Date.parse(next.launchConsumedAt) : 0;
    for (const id of [state.kind === "prepared" ? state.capability : undefined, undefined]) {
      events.push({ type: "bind_session", sessionFile: next.sessionFile, at, ...(id ? { launchId: id } : {}) });
      events.push({ type: "bind_session", sessionFile: next.sessionFile, at, ...(id ? { launchId: id } : {}), placement });
    }
  }
  events.push({ type: "relocate", placement });
  if (next.isActive === false && next.deactivationReason) {
    for (const authority of ["process_stopped", "no_process_possible", "session_left"] as const) {
      events.push({ type: "deactivate", reason: next.deactivationReason, at: next.deactivatedAt ? Date.parse(next.deactivatedAt) : 0, authority, carrier });
    }
  }
  return events;
}

/** The first event whose applied patch turns `prev` into `next` on every lifecycle field. */
export function witness(prev: Member, next: Member, carrier: CarrierLaunchKind): MembershipEvent | undefined {
  const state = parseMembership(prev);
  const want = lifecycle(next);
  for (const event of candidates(prev, next, carrier)) {
    const step = transitionMembership(state, event);
    if (step.kind === "applied" && isDeepStrictEqual(lifecycle(applyMembershipPatch(prev, step.patch)), want)) return event;
  }
  return undefined;
}

export function checkMembershipConformance(history: readonly HistoryEntry[], carrier: CarrierLaunchKind = "two_stage"): Conformance {
  const last = new Map<string, Member>();
  const result: Conformance = { timelines: new Map(), violations: [], snapshots: 0, changes: 0, starts: 0 };
  let latest: Member[] = [];
  for (const entry of history) {
    if (entry.kind === "exec.call" && entry.args[0] === "agent" && entry.args[1] === "start") {
      result.starts++;
      const flag = entry.args.indexOf("--pane");
      const pane = flag >= 0 ? entry.args[flag + 1] : entry.args[2];
      const owner = latest.find(m => m.isActive !== false && m.terminalTarget?.targetId === pane && m.launch?.state === "requested");
      if (!owner) result.violations.push({ kind: "unauthorized_start", sequence: entry.sequence, detail: `agent start on ${pane} without a requested launch that targets it` });
      continue;
    }
    if (entry.kind !== "durable.team" || !entry.record) continue;
    result.snapshots++;
    latest = ((entry.record as { members?: Member[] }).members ?? []);
    for (const member of latest) {
      const id = member.membershipId;
      if (!id) continue;
      const prev = last.get(id);
      last.set(id, member);
      const timeline = result.timelines.get(id) ?? [];
      result.timelines.set(id, timeline);
      const state = parseMembership(member);
      if (!prev) {
        if (state.kind !== "prepared" && state.kind !== "bound") result.violations.push({ kind: "invalid_first_state", membershipId: id, sequence: entry.sequence, detail: state.kind });
        timeline.push({ sequence: entry.sequence, at: entry.at, state, witness: "initial" });
        continue;
      }
      if (isDeepStrictEqual(lifecycle(prev), lifecycle(member))) continue;
      result.changes++;
      const event = witness(prev, member, carrier);
      if (!event) {
        result.violations.push({ kind: "unwitnessed_change", membershipId: id, sequence: entry.sequence, detail: `${JSON.stringify(lifecycle(prev))} -> ${JSON.stringify(lifecycle(member))}` });
        continue;
      }
      timeline.push({ sequence: entry.sequence, at: entry.at, state, witness: event.type });
    }
  }
  return result;
}

/** One line per step: time, witness event, and the resulting state kind with its launch phase. */
export function formatTimeline(steps: readonly TimelineStep[]): string[] {
  return steps.map(step => {
    const s = step.state;
    const launch = s.kind === "prepared" || s.kind === "bound" ? ` launch=${s.launch?.phase ?? "none"} target=${s.target ? "yes" : "no"}` : "";
    return `${String(step.at).padStart(6)}ms #${step.sequence} ${step.witness.padEnd(15)} -> ${s.kind}${launch}`;
  });
}
