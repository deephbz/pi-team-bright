import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BeadsTaskStore, initializeBeadsWorkspace } from "../utils/beads";
import { teamDir } from "../utils/paths";
import { BeadsTaskGraphAdapter } from "./beads-graph-adapter";
import type { TaskGraphCreateInput } from "./dag";

const roots: string[] = [];
const teams: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  for (const team of teams.splice(0)) fs.rmSync(teamDir(team), { recursive: true, force: true });
});

async function fixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ptb-dag-beads-"));
  roots.push(workspace);
  const teamName = `dag_test_${process.pid}_${Date.now()}`;
  teams.push(teamName);
  const fingerprint = await initializeBeadsWorkspace(workspace);
  const store = new BeadsTaskStore({ teamName, workspace, authorityFingerprint: fingerprint });
  const adapter = new BeadsTaskGraphAdapter(teamName, store, async () => new Set(["maker", "reviewer"]));
  return { store, adapter };
}

const graph: TaskGraphCreateInput = {
  operation_id: "release-dag-native-1",
  tasks: [
    { key: "plan", title: "Plan", goal: "Approve a concrete implementation plan.", assignee: "maker" },
    { key: "impl", title: "Implement", goal: "Implement the approved plan.", assignee: "maker" },
    { key: "review", title: "Review", goal: "Review the implementation.", assignee: "reviewer" },
    { key: "verify", title: "Verify", goal: "Verify the reviewed result empirically.", assignee: "reviewer" },
  ],
  dependencies: [
    { task: { key: "impl" }, needs: [{ key: "plan" }] },
    { task: { key: "review" }, needs: [{ key: "impl" }] },
    { task: { key: "verify" }, needs: [{ key: "review" }] },
  ],
};

describe("real Beads DAG adapter", () => {
  it("atomically creates, projects, and exactly replays a four-Task DAG", async () => {
    const { store, adapter } = await fixture();
    const first = await adapter.create(graph);
    if (first.kind !== "created") throw new Error(JSON.stringify(first));
    expect(Object.keys(first.tasksByKey)).toEqual(["plan", "impl", "review", "verify"]);
    expect(first.readyTaskIds).toEqual([first.tasksByKey.plan.id]);
    expect(first.tasksByKey.impl.relations).toContainEqual({ relation: "blocked_by", target_task_id: first.tasksByKey.plan.id });
    expect(first.tasksByKey.impl.dependency_state).toEqual({ kind: "waiting", active_blocker_ids: [first.tasksByKey.plan.id] });

    const replay = await adapter.create(graph);
    expect(replay.kind).toBe("created");
    if (replay.kind !== "created") return;
    expect(replay.replayed).toBe(true);
    expect(Object.fromEntries(Object.entries(replay.tasksByKey).map(([key, task]) => [key, task.id])))
      .toEqual(Object.fromEntries(Object.entries(first.tasksByKey).map(([key, task]) => [key, task.id])));
    expect(await store.list()).toHaveLength(4);

    const changed = await adapter.create({ ...graph, tasks: graph.tasks.map((task, index) => index ? task : { ...task, title: "Changed plan" }) });
    expect(changed).toMatchObject({ kind: "refused", reason: "operation_conflict" });
    expect(await store.list()).toHaveLength(4);
  }, 60_000);

  it("expands an existing dependent and replays after that Task version changes", async () => {
    const { store, adapter } = await fixture();
    const initial = await adapter.create(graph);
    if (initial.kind !== "created") throw new Error(initial.message);
    const review = initial.tasksByKey.review;
    const expansion: TaskGraphCreateInput = {
      operation_id: "review-remediation-1",
      tasks: [{ key: "remediation", title: "Remediate", goal: "Resolve the review defect.", assignee: "maker" }],
      dependencies: [{
        task: { task_id: review.id, expected_version: review.version as `v_${string}` },
        needs: [{ key: "remediation" }],
      }],
    };
    const first = await adapter.create(expansion);
    if (first.kind !== "created") throw new Error(first.message);
    const changedReview = await adapter.create(expansion);
    expect(changedReview).toMatchObject({ kind: "created", replayed: true });
    if (changedReview.kind !== "created") return;
    expect(changedReview.tasksByKey.remediation.id).toBe(first.tasksByKey.remediation.id);
    expect((await store.read(review.id)).relations).toContainEqual({ relation: "blocked_by", targetId: first.tasksByKey.remediation.id });
    expect(await store.list()).toHaveLength(5);
  }, 60_000);

  it("lets Beads refuse a cycle without partial creation", async () => {
    const { store, adapter } = await fixture();
    const result = await adapter.create({
      ...graph,
      dependencies: [
        ...graph.dependencies!,
        { task: { key: "plan" }, needs: [{ key: "verify" }] },
      ],
    });
    expect(result).toMatchObject({ kind: "refused", reason: "graph_conflict" });
    expect(await store.list()).toHaveLength(0);
  }, 60_000);
});
