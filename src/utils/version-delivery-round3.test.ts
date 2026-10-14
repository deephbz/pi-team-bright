import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { DurableGraphTaskAuthority } from "../adapters/durable-graph-task-authority";
import { DurableTaskMutationPublication } from "../adapters/durable-task-mutation-publication";
import { DurableGraphTaskOrchestration } from "../task-authority/graph-orchestration";
import type { TaskVersionRef } from "../task-authority/task-version-ref";
import * as paths from "./paths";
import { enqueueTaskChangeForRecipient, readTaskDeliveries } from "./task-delivery";
import * as teams from "./teams";

const createdTeams: string[] = [];

async function configureDeliveryTeam(teamName: string, sessionFile: string): Promise<void> {
  createdTeams.push(teamName);
  await teams.createTeam(teamName, `/tmp/${teamName}-lead.jsonl`, `lead@${teamName}`, "Graph Task delivery fixture");
  await teams.ensureLogicalWorker(teamName, { name: "worker", scope: "Receive graph Task revisions." });
  await teams.addMember(teamName, {
    membershipId: teams.newMembershipId(), agentId: `worker@${teamName}`, name: "worker", agentType: "teammate",
    joinedAt: Date.now(), tmuxPaneId: "", sessionFile, cwd: process.cwd(), subscriptions: [], isActive: true,
  });
}

afterEach(() => {
  for (const team of createdTeams.splice(0)) {
    fs.rmSync(paths.teamDir(team), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(team), { recursive: true, force: true });
  }
});

describe("graph Task revision delivery dedupe", () => {
  it("enqueues A to B to later A as three distinct Task revisions", async () => {
    const team = `version-r3-${process.pid}-${Date.now()}`;
    await configureDeliveryTeam(team, `/tmp/${team}-worker.jsonl`);
    const publication = new DurableTaskMutationPublication();
    const graph = new DurableGraphTaskOrchestration(new DurableGraphTaskAuthority(), publication, publication, publication);
    const applied = await graph.applyGraph(team, { operationId: "apply-aba", tasks: [{ key: "task-aba", title: "A to B to A", goal: "A", assignee: "worker" }] });
    if (applied.kind !== "applied") throw new Error(`Graph apply failed: ${JSON.stringify(applied)}`);
    const firstA = (await graph.readTasks(team, ["task-aba"]))[0];
    const updateB = await graph.transition(team, { taskId: "task-aba", operationId: "update-b", expectedVersion: firstA.version as TaskVersionRef, currentContext: "B" }, "team-lead");
    if (updateB.kind !== "updated") throw new Error(`Graph B transition failed: ${JSON.stringify(updateB)}`);
    const middleB = updateB.task;
    const updateA = await graph.transition(team, { taskId: "task-aba", operationId: "update-a", expectedVersion: middleB.version as TaskVersionRef, currentContext: "A" }, "team-lead");
    if (updateA.kind !== "updated") throw new Error(`Graph A transition failed: ${JSON.stringify(updateA)}`);
    const secondA = updateA.task;
    expect(firstA.version).not.toBe(middleB.version);
    expect(middleB.version).not.toBe(secondA.version);

    const revisions = [firstA, middleB, secondA];
    const deliveries = [];
    for (const revision of revisions) deliveries.push(await enqueueTaskChangeForRecipient(team, revision, "worker", "status_changed"));

    expect(deliveries.slice(0, 2)).toEqual([null, null]);
    expect(deliveries[2]).toMatchObject({ ref: { version: secondA.version } });
    const persisted = await readTaskDeliveries(team, "worker");
    expect(persisted).toHaveLength(3);
    expect(persisted.map((delivery) => delivery.ref.version)).toEqual(expect.arrayContaining(revisions.map((revision) => revision.version)));
    expect(new Set(persisted.map((delivery) => delivery.deliveryId))).toHaveLength(3);
  });
});
