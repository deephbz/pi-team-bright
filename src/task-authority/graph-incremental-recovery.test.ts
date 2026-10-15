import { afterEach, expect, it, vi } from "vitest";
import { GraphTaskController, GraphSnapshotValidator, type GraphControlSnapshot } from "./graph-control";

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const controller = new GraphTaskController();
  const tasks = [
    { key: "a", title: "A", goal: "Complete A", assignee: "worker", needs: [] },
    { key: "b", title: "B", goal: "Complete B", assignee: "other", needs: ["a"] },
  ];
  controller.applyGraph({ operationId: "first", tasks });
  controller.transition({ operationId: "claim", taskId: "a", expectedVersion: controller.readTask("a").version, transition: "claim", worker: "worker" });
  controller.transition({ operationId: "complete", taskId: "a", expectedVersion: controller.readTask("a").version, transition: "goal_achieved", worker: "worker", evidence: "Result verified" });
  controller.applyGraph({ operationId: "second", expectedGraphVersion: controller.currentGraphVersion(), tasks });
  const snapshot = controller.snapshot();
  const validator = new GraphSnapshotValidator(true);
  const validate = vi.spyOn(GraphSnapshotValidator.prototype as any, "validateRevision");
  const recover = (input: GraphControlSnapshot = snapshot) => GraphTaskController.recover(input, undefined, validator);
  return { controller, tasks, snapshot, validator, validate, recover };
}
it("validates a cold prefix fully, then reuses only digest-verified revision validation", () => {
  const fx = fixture();
  fx.recover();
  expect(fx.validate).toHaveBeenCalledTimes(2);
  fx.validate.mockClear();
  fx.controller.transition({ operationId: "context", taskId: "a", expectedVersion: fx.controller.readTask("a").version, currentContext: "New verified context" });
  const changed = fx.controller.snapshot();
  const reused = fx.recover(changed);
  expect(fx.validate).not.toHaveBeenCalled();
  expect(reused.trace()).toEqual(GraphTaskController.recover(changed).trace());
  expect(reused.readTask("a").currentContext).toBe("New verified context");
});
it("validates only appended revisions after checking every old revision fingerprint", () => {
  const fx = fixture(); fx.recover(); fx.validate.mockClear();
  fx.controller.applyGraph({ operationId: "third", expectedGraphVersion: fx.controller.currentGraphVersion(), tasks: [...fx.tasks, { key: "c", title: "C", goal: "Complete C", assignee: "third", needs: ["b"] }] });
  const changed = fx.controller.snapshot();
  const reused = fx.recover(changed);
  expect(fx.validate).toHaveBeenCalledTimes(1);
  expect(reused.trace()).toEqual(GraphTaskController.recover(changed).trace());
});
it.each([0, 1])("falls back to full validation when revision %i changes", index => {
  const fx = fixture(); fx.recover(); fx.validate.mockClear();
  const changed = structuredClone(fx.snapshot);
  changed.graphRevisions[index]!.recorded_at = "2026-01-01T00:00:00.000Z";
  fx.recover(changed);
  expect(fx.validate).toHaveBeenCalledTimes(2);
});
it("refuses corruption in a previously validated retained revision", () => {
  const fx = fixture(); fx.recover();
  const changed = structuredClone(fx.snapshot);
  changed.graphRevisions[0]!.tasks[0]!.goal = "Corrupt historical goal";
  expect(() => fx.recover(changed)).toThrow("invalid lineage");
});
it("refuses current-revision corruption and invalidates the validation memo", () => {
  const fx = fixture(); fx.recover(); fx.validate.mockClear();
  const changed = structuredClone(fx.snapshot);
  changed.graphRevisions[1]!.tasks[0]!.goal = "Corrupt current goal";
  expect(() => fx.recover(changed)).toThrow("invalid lineage");
  expect(fx.validate).toHaveBeenCalledTimes(2);
  fx.validate.mockClear(); fx.recover();
  expect(fx.validate).toHaveBeenCalledTimes(2);
});
it("validates a truncated history fully", () => {
  const fx = fixture(); fx.recover(); fx.validate.mockClear();
  const changed = structuredClone(fx.snapshot);
  changed.graphRevisions.pop();
  const reused = fx.recover(changed);
  expect(fx.validate).toHaveBeenCalledTimes(1);
  expect(reused.trace()).toEqual(GraphTaskController.recover(changed).trace());
});
it.each(["sequence", "event", "receipt"])("rechecks %s evidence despite an unchanged revision prefix", part => {
  const fx = fixture(); fx.recover();
  const changed = structuredClone(fx.snapshot);
  if (part === "sequence") changed.events[0]!.sequence = changed.graphRevisions[0]!.sequence;
  if (part === "event") (changed.events[0] as any).taskLineage = "corrupt";
  if (part === "receipt") changed.receipts[0]!.fingerprint = "corrupt";
  expect(() => fx.recover(changed)).toThrow();
  fx.validate.mockClear(); fx.recover();
  expect(fx.validate).toHaveBeenCalledTimes(2);
});
it("falls back to full validation after a fingerprint failure", () => {
  const fx = fixture(); fx.recover(); fx.validate.mockClear();
  const fingerprint = vi.spyOn(fx.validator as any, "revisionFingerprint").mockImplementationOnce(() => { throw new Error("digest unavailable"); });
  const recovered = fx.recover();
  expect(fx.validate).toHaveBeenCalledTimes(2);
  expect(recovered.readTask("a").state.kind).toBe("goal_achieved");
  fingerprint.mockRestore();
  fx.validate.mockClear(); fx.recover();
  expect(fx.validate).toHaveBeenCalledTimes(2);
});
it("keeps ordinary recovery fully validating despite a warm read validator", () => {
  const fx = fixture(); fx.recover(); fx.validate.mockClear();
  GraphTaskController.recover(fx.snapshot);
  GraphTaskController.recover(fx.snapshot);
  expect(fx.validate).toHaveBeenCalledTimes(4);
});
