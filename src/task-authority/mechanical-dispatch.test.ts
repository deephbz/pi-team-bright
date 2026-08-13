import { describe, expect, it } from "vitest";
import { MechanicalTaskAuthority, TaskClaimRefused, type PresentationPort } from "./mechanical-dispatch";
import type { TaskGraphCreateInput } from "./dag";

class Recorder implements PresentationPort {
  readonly calls: Array<{ worker: string; taskId: string; deliveryId: string }> = [];
  fail = false;
  async present(input: { worker: string; task: { id: string }; delivery_id: string }): Promise<void> {
    if (this.fail) throw new Error("session absent");
    this.calls.push({ worker: input.worker, taskId: input.task.id, deliveryId: input.delivery_id });
  }
}

const graph: TaskGraphCreateInput = {
  operation_id: "release-dag-1",
  tasks: [
    { key: "plan", title: "Plan", goal: "Approve the plan.", assignee: "maker" },
    { key: "impl", title: "Implement", goal: "Implement the plan.", assignee: "maker" },
    { key: "review", title: "Review", goal: "Review the change.", assignee: "reviewer" },
    { key: "verify", title: "Verify", goal: "Verify the reviewed change.", assignee: "reviewer" },
  ],
  dependencies: [
    { task: { key: "impl" }, needs: [{ key: "plan" }] },
    { task: { key: "review" }, needs: [{ key: "impl" }] },
    { task: { key: "verify" }, needs: [{ key: "impl" }] },
  ],
};

function ids(receipt: Awaited<ReturnType<MechanicalTaskAuthority["createGraph"]>>) {
  return Object.fromEntries(Object.entries(receipt.tasks_by_key).map(([key, task]) => [key, task.id])) as Record<"plan" | "impl" | "review" | "verify", string>;
}

describe("mechanical Task DAG dispatch", () => {
  it("commits one DAG, presents only its ready front, and advances without a leader turn", async () => {
    const recorder = new Recorder();
    const authority = new MechanicalTaskAuthority(recorder);
    const receipt = await authority.createGraph(graph, new Set(["maker", "reviewer"]));
    const taskIds = ids(receipt);

    expect(Object.keys(receipt.tasks_by_key)).toEqual(["plan", "impl", "review", "verify"]);
    expect(recorder.calls.map((call) => call.taskId)).toEqual([taskIds.plan]);
    expect(() => authority.claim(taskIds.impl, "maker")).toThrowError(TaskClaimRefused);
    try { authority.claim(taskIds.impl, "maker"); } catch (error) {
      expect((error as TaskClaimRefused).blockerIds).toEqual([taskIds.plan]);
    }

    authority.claim(taskIds.plan, "maker");
    await authority.transition(taskIds.plan, "closed");
    expect(recorder.calls.map((call) => call.taskId)).toEqual([taskIds.plan, taskIds.impl]);

    authority.claim(taskIds.impl, "maker");
    await authority.transition(taskIds.impl, "closed");
    expect(recorder.calls.slice(-1).map((call) => [call.worker, call.taskId])).toEqual([
      ["reviewer", taskIds.review],
    ]);
    expect(authority.deliveryState().map((delivery) => delivery.taskId)).toEqual([taskIds.review]);

    authority.claim(taskIds.review, "reviewer");
    await authority.transition(taskIds.review, "blocked");
    expect(authority.deliveryState().map((delivery) => delivery.taskId)).toEqual([taskIds.verify]);
  });

  it("replays exactly, refuses changed replay, and creates no duplicate Tasks", async () => {
    const authority = new MechanicalTaskAuthority(new Recorder());
    const first = await authority.createGraph(graph, new Set(["maker", "reviewer"]));
    const replay = await authority.createGraph(graph, new Set(["maker", "reviewer"]));
    expect(replay.replayed).toBe(true);
    expect(ids(replay)).toEqual(ids(first));
    expect(authority.list()).toHaveLength(4);
    await expect(authority.createGraph({ ...graph, tasks: graph.tasks.map((task, index) => index ? task : { ...task, title: "Changed" }) }, new Set(["maker", "reviewer"]))).rejects.toThrow(/different graph semantics/);
    expect(authority.list()).toHaveLength(4);
  });

  it("recovers graph commit and pending delivery after a crash", async () => {
    const failing = new Recorder();
    failing.fail = true;
    const first = new MechanicalTaskAuthority(failing);
    const receipt = await first.createGraph(graph, new Set(["maker", "reviewer"]));
    expect(receipt.delivery_warnings).toHaveLength(1);
    expect(first.deliveryState()[0].state).toBe("pending");

    const recoveredPresentation = new Recorder();
    const recovered = new MechanicalTaskAuthority(recoveredPresentation, first.snapshot());
    const replay = await recovered.createGraph(graph, new Set(["maker", "reviewer"]));
    expect(replay.replayed).toBe(true);
    expect(recoveredPresentation.calls.map((call) => call.taskId)).toEqual([ids(receipt).plan]);
    expect(recovered.deliveryState()[0].state).toBe("presented");
  });

  it("does not mutate authority when graph validation fails", async () => {
    const authority = new MechanicalTaskAuthority(new Recorder());
    await expect(authority.createGraph({
      ...graph,
      dependencies: [...graph.dependencies!, { task: { key: "plan" }, needs: [{ key: "verify" }] }],
    }, new Set(["maker", "reviewer"]))).rejects.toThrow(/cycle/);
    expect(authority.list()).toEqual([]);
    expect(authority.deliveryState()).toEqual([]);
  });
});
