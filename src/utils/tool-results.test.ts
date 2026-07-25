import { describe, expect, it } from "vitest";
import type { WorkerEnsureAction, WorkerEnsurePostState, WorkerEnsureRecoveryMode } from "./tool-results";

describe("Worker ensure public result types", () => {
  it("keeps actions and recovery combinations literal", () => {
    const created: WorkerEnsurePostState = {
      name: "worker", action: "created", membership: "current", carrier: "prepared",
      terminalLaunched: true, runtime: "not_observed", assignedTasks: [],
    };
    const recovered: WorkerEnsurePostState = {
      name: "worker", action: "recovered", recoveryMode: "exact_session_resume",
      membership: "current", carrier: "session_bound", terminalLaunched: true,
      runtime: "not_observed", taskStateChanged: false,
    };
    const action: WorkerEnsureAction = recovered.action;
    const recoveryMode: WorkerEnsureRecoveryMode = recovered.recoveryMode;

    // @ts-expect-error public actions are a closed literal union
    const misspelled: WorkerEnsureAction = "recovery";
    const invalidCreated: WorkerEnsurePostState = {
      // @ts-expect-error recovery mode is required only by the recovered variant
      name: "worker", action: "created", recoveryMode: "first_binding_retry", membership: "current",
      carrier: "prepared", terminalLaunched: true, runtime: "not_observed", assignedTasks: [],
    };
    // @ts-expect-error recovered output must state which exact recovery occurred
    const missingRecoveryMode: WorkerEnsurePostState = {
      name: "worker", action: "recovered", membership: "current", carrier: "prepared",
      terminalLaunched: true, runtime: "not_observed", taskStateChanged: false,
    };

    expect([action, recoveryMode, misspelled, invalidCreated, missingRecoveryMode]).toHaveLength(5);
  });
});
