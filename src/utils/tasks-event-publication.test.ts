import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as eventJournal from "../coordination/event-journal";
import * as teamEvents from "../coordination/event-journal";
import * as teams from "./teams";
import * as paths from "./paths";
import { DurableTaskMutationPublication } from "../adapters/durable-task-mutation-publication";
import { DurableGraphTaskAuthority } from "../adapters/durable-graph-task-authority";
import { DurableGraphTaskOrchestration } from "../task-authority/graph-orchestration";
import type { GraphTaskCard } from "../task-authority/graph-control-schemas";
import { taskVersionRef, type TaskVersionRef } from "../task-authority/task-version-ref";

const created: string[] = [];
async function fixture() {
  const name = `graph-task-event-${process.pid}-${Date.now()}-${created.length}`;
  created.push(name);
  await teams.createTeam(name, `/tmp/${name}-lead.jsonl`, `lead@${name}`);
  const config = await teams.readConfig(name);
  config.logicalWorkers = [{ name: "worker", scope: "Complete the graph Task." }];
  teams.writeConfigAtomic(paths.configPath(name), config);
  await teams.addMember(name, { membershipId: teams.newMembershipId(), agentId: `worker@${name}`, name: "worker", agentType: "teammate", joinedAt: Date.now(), cwd: process.cwd(), subscriptions: [], sessionFile: `/tmp/${name}-worker.jsonl`, isActive: true });
  const publication = new DurableTaskMutationPublication();
  const authority = new DurableGraphTaskAuthority();
  return { name, authority, graph: new DurableGraphTaskOrchestration(authority, publication, publication, publication) };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of created.splice(0)) fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
});

describe("graph Task-event publication", () => {
  it("writes typed evidence for graph Task transitions", async () => {
    const { name, graph } = await fixture();
    const applied = await graph.applyGraph(name, {
      operationId: "apply-publication", tasks: [{ key: "work", title: "Verify publication", goal: "Verify typed Task-event publication.", assignee: "worker" }],
    });
    if (applied.kind !== "applied") throw new Error(`Graph apply failed: ${JSON.stringify(applied)}`);
    const before = applied.tasks[0] as GraphTaskCard;
    const after = await graph.transition(name, {
      taskId: before.id, operationId: "claim-publication", expectedVersion: before.version as TaskVersionRef, transition: "claim", worker: "worker",
    }, "worker");
    expect(after.kind).toBe("updated");
    const events = teamEvents.readTeamEvents(name, { afterCursor: "0" }).events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.map(teamEvents.projectTaskEventEvidence)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "status", text: "Task transition claim produced in_progress.", actor: "worker" }),
    ]));
  });

  it("records payload-light hints when graph Task event publication fails", async () => {
    const { name, graph } = await fixture();
    const applied = await graph.applyGraph(name, {
      operationId: "apply-failure-hints", tasks: [{ key: "work", title: "Failure hints", goal: "Record event failure evidence.", assignee: "worker" }],
    });
    if (applied.kind !== "applied") throw new Error(`Graph apply failed: ${JSON.stringify(applied)}`);
    vi.spyOn(eventJournal, "appendTaskEvidenceEvents").mockRejectedValue(new Error("event journal unavailable"));
    const result = await graph.transition(name, {
      taskId: applied.tasks[0].id, operationId: "claim-failure-hints", expectedVersion: applied.tasks[0].version as TaskVersionRef, transition: "claim", worker: "worker",
    }, "worker");
    expect(result.kind).toBe("updated");
    if (result.kind !== "updated") return;
    expect(result.deliveryWarnings).toEqual(expect.arrayContaining([expect.stringContaining("Team event was not recorded")]));
  });
});
