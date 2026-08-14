import { describe, expect, it } from "vitest";
import type { Member } from "./models";
import {
  normalizeWorkerCarrier,
  planWorkerEnsure,
  type WorkerCarrierObservation,
} from "./worker-ensure-lifecycle";

function member(overrides: Partial<Member> = {}): Member {
  return {
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
  };
}

describe("Worker ensure lifecycle planner", () => {
  it.each([
    [undefined, "missing", { action: "create" }],
    [member(), "live", { action: "refuse", reason: "unbound_live", carrier: { kind: "prepared" } }],
    [member(), "missing", { action: "recover", recoveryMode: "first_binding_retry", carrier: { kind: "prepared" } }],
    [member({ sessionFile: "/sessions/worker.jsonl", pendingLaunchId: undefined }), "live", { action: "reuse", carrier: { kind: "bound" } }],
    [member({ sessionFile: "/sessions/worker.jsonl", pendingLaunchId: undefined }), "missing", { action: "recover", recoveryMode: "exact_session_resume", carrier: { kind: "bound" } }],
    [member({ membershipId: undefined }), "missing", { action: "refuse", carrier: { kind: "invalid", reason: "missing_membership_id" } }],
    [member({ sessionFile: "/sessions/worker.jsonl" }), "missing", { action: "refuse", carrier: { kind: "invalid", reason: "both_session_and_pending_launch" } }],
    [member({ pendingLaunchId: undefined }), "missing", { action: "refuse", carrier: { kind: "invalid", reason: "missing_session_and_pending_launch" } }],
  ] as const)("plans %o with %s observation", (persisted, observation, expected) => {
    const plan = planWorkerEnsure(normalizeWorkerCarrier(persisted), observation as WorkerCarrierObservation);
    expect(plan).toMatchObject(expected);
  });

});
