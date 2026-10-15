import { writeJsonFixture } from "./test-write-json";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableGraphTaskAuthority } from "../adapters/durable-graph-task-authority";
import { DurableTaskMutationPublication } from "../adapters/durable-task-mutation-publication";
import { DurableGraphTaskOrchestration } from "../task-authority/graph-orchestration";
import type { TaskVersionRef } from "../task-authority/task-version-ref";
import * as paths from "./paths";
import * as teams from "./teams";

const names: string[] = [];
async function fixture(suffix: string) {
  const name = `clean-cut-graph-${suffix}-${process.pid}-${Date.now()}-${names.length}`; names.push(name);
  await teams.createTeam(name, `/tmp/${name}-lead.jsonl`, `lead@${name}`);
  const config = await teams.readConfig(name);
  config.logicalWorkers = [{ name: "worker", scope: "Complete graph work." }];
  writeJsonFixture(paths.configPath(name), config);
  await teams.addMember(name, { membershipId: teams.newMembershipId(), agentId: `worker@${name}`, name: "worker", agentType: "teammate", joinedAt: Date.now(), sessionFile: `/tmp/${name}-worker.jsonl`, cwd: process.cwd(), subscriptions: [], isActive: true });
  const authority = new DurableGraphTaskAuthority();
  const publication = new DurableTaskMutationPublication();
  return { name, authority, graph: new DurableGraphTaskOrchestration(authority, publication, publication, publication) };
}
afterEach(() => { vi.restoreAllMocks(); for (const name of names.splice(0)) fs.rmSync(paths.teamDir(name), { recursive: true, force: true }); });

describe("graph Task mutation contracts", () => {
  it("commits a graph revision atomically and returns its canonical post-state", async () => {
    const { name, graph, authority } = await fixture("atomic");
    const applied = await graph.applyGraph(name, {
      operationId: "apply-atomic-contract", tasks: [{ key: "work", title: "Atomic graph", goal: "Publish one complete graph revision.", assignee: "worker" }],
    });
    expect(applied.kind).toBe("applied");
    if (applied.kind !== "applied") return;
    await expect(authority.readTasks(name)).resolves.toEqual(applied.tasks);
    expect(applied.readyTaskIds).toEqual([applied.tasks[0].id]);
  });

  it("rejects a stale Task version before changing the graph state", async () => {
    const { name, graph, authority } = await fixture("cas");
    const applied = await graph.applyGraph(name, {
      operationId: "apply-cas-contract", tasks: [{ key: "work", title: "CAS", goal: "Reject stale transitions.", assignee: "worker" }],
    });
    if (applied.kind !== "applied") throw new Error(JSON.stringify(applied));
    const task = applied.tasks[0];
    const claimed = await graph.transition(name, {
      taskId: task.id, operationId: "claim-current", expectedVersion: task.version as TaskVersionRef, transition: "claim", worker: "worker",
    }, "worker");
    expect(claimed.kind).toBe("updated");
    if (claimed.kind !== "updated") return;
    const stale = await graph.transition(name, {
      taskId: task.id, operationId: "claim-stale", expectedVersion: task.version as TaskVersionRef, transition: "goal_achieved", worker: "worker", evidence: "Stale evidence.",
    }, "worker");
    expect(stale).toMatchObject({ kind: "refused", reason: "version_conflict" });
    await expect(authority.readTasks(name)).resolves.toEqual([expect.objectContaining({ id: task.id, status: "in_progress", version: claimed.task.version })]);
  });
});
