import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import { TaskCardSchema } from "./task-domain";
import { taskVersionRef, type TaskVersionRef } from "../task-authority/task-version-ref";
import { DurableGraphTaskAuthority } from "../adapters/durable-graph-task-authority";
import { DurableTaskMutationPublication } from "../adapters/durable-task-mutation-publication";
import { DurableGraphTaskOrchestration } from "../task-authority/graph-orchestration";
import { projectTaskForAgent } from "../utils/task-delivery";
import * as teams from "../utils/teams";
import * as paths from "../utils/paths";

const names: string[] = [];
async function fixture() {
  const name = `canonical-graph-task-${process.pid}-${Date.now()}-${names.length}`;
  names.push(name);
  await teams.createTeam(name, `/tmp/${name}-lead.jsonl`, `lead@${name}`);
  const config = await teams.readConfig(name);
  config.logicalWorkers = [{ name: "worker", scope: "Complete the graph Task." }];
  teams.writeConfigAtomic(paths.configPath(name), config);
  await teams.addMember(name, { membershipId: teams.newMembershipId(), agentId: `worker@${name}`, name: "worker", agentType: "teammate", joinedAt: Date.now(), cwd: process.cwd(), subscriptions: [], sessionFile: `/tmp/${name}-worker.jsonl`, isActive: true });
  const publication = new DurableTaskMutationPublication();
  const authority = new DurableGraphTaskAuthority();
  return { name, authority, graph: new DurableGraphTaskOrchestration(authority, publication, publication, publication) };
}
afterEach(() => { for (const name of names.splice(0)) fs.rmSync(paths.teamDir(name), { recursive: true, force: true }); });

describe("canonical graph Task cutover acceptance", () => {
  it("projects one neutral Task card with an opaque graph revision", async () => {
    const { name, graph } = await fixture();
    const applied = await graph.applyGraph(name, {
      operationId: "apply-canonical-card", tasks: [{ key: "work", title: "Verify cutover", goal: "Run the focused acceptance check.", assignee: "worker" }],
    });
    expect(applied, JSON.stringify(applied)).toMatchObject({ kind: "applied" });
    if (applied.kind !== "applied") return;
    const card = applied.tasks[0];
    expect(Check(TaskCardSchema, card)).toBe(true);
    expect(card.version).toMatch(/^v_[0-9a-f]{16}$/);
    expect(card).not.toHaveProperty("provenance");
    expect(card).not.toHaveProperty("description");
    expect(projectTaskForAgent(card).version).toBe(card.version);
  });

  it("uses graph CAS versions and rejects stale transitions without changing Task state", async () => {
    const { name, graph, authority } = await fixture();
    const applied = await graph.applyGraph(name, {
      operationId: "apply-cas", tasks: [{ key: "work", title: "CAS", goal: "Reject stale revisions.", assignee: "worker" }],
    });
    if (applied.kind !== "applied") throw new Error(`Graph apply failed: ${JSON.stringify(applied)}`);
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

  it("preserves the graph Task card through delivery projection", async () => {
    const { name, graph } = await fixture();
    const applied = await graph.applyGraph(name, {
      operationId: "apply-delivery", tasks: [{ key: "work", title: "Delivery", goal: "Keep the published card canonical.", assignee: "worker" }],
    });
    if (applied.kind !== "applied") throw new Error(`Graph apply failed: ${JSON.stringify(applied)}`);
    const card = applied.tasks[0];
    expect(projectTaskForAgent(card)).toEqual(card);
    expect(taskVersionRef(card.version)).toMatch(/^v_[0-9a-f]{16}$/);
  });
});
