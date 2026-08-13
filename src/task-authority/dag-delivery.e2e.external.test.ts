import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BeadsTaskStore, initializeBeadsWorkspace } from "../utils/beads";
import { configPath, teamDir } from "../utils/paths";
import { writeConfigAtomic, newTeamEpochId } from "../utils/teams";
import type { TeamConfig } from "../utils/models";
import type { TaskVersionRef } from "../model-tool-contract/task-version-ref";
import { createPublishingBeadsTaskAdapterFactory, type BeadsTaskAdapter } from "../model-tool-contract/beads-task-adapter";
import { DurableTaskMutationPublication } from "../adapters/durable-task-mutation-publication";
import { DurableTaskOrchestration } from "../adapters/durable-task-orchestration";
import { DurableTaskAuthorityTeam } from "../adapters/durable-task-authority-team";
import { DurableTaskAuthorityRead } from "../adapters/durable-task-authority-read";
import { DurableTaskAuthorityReadTeam } from "../adapters/durable-task-authority-read-team";
import { readTeamEvents } from "../utils/team-events";
import { readTaskDeliveries } from "../utils/task-delivery";
import { BeadsTaskGraphAdapter } from "./beads-graph-adapter";
import type { TaskGraphCreateInput } from "./dag";

const roots: string[] = [];
const teams: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  for (const team of teams.splice(0)) fs.rmSync(teamDir(team), { recursive: true, force: true });
});

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ptb-dag-delivery-"));
  roots.push(root);
  const teamName = `dag_delivery_${process.pid}_${Date.now()}`;
  teams.push(teamName);
  const fingerprint = await initializeBeadsWorkspace(root);
  const member = (name: string, agentType: "lead" | "teammate") => ({
    membershipId: `membership_${name}_${teamName}`,
    agentId: `${name}@${teamName}`,
    name,
    agentType,
    joinedAt: Date.now(),
    cwd: process.cwd(),
    subscriptions: [],
    sessionFile: `/tmp/${teamName}-${name}-${crypto.randomUUID()}.jsonl`,
    isActive: true,
  });
  const config: TeamConfig = {
    name: teamName,
    description: "DAG delivery E2E",
    createdAt: Date.now(),
    epochId: newTeamEpochId(),
    leadAgentId: `team-lead@${teamName}`,
    leadSessionId: `/tmp/${teamName}-team-lead.jsonl`,
    taskBackend: "beads",
    taskWorkspace: root,
    taskAuthorityId: `task_authority_${crypto.randomUUID()}`,
    taskAuthorityFingerprint: fingerprint,
    logicalWorkers: [
      { name: "maker", scope: "Own implementation work." },
      { name: "reviewer", scope: "Own independent review work." },
    ],
    members: [member("team-lead", "lead"), member("maker", "teammate"), member("reviewer", "teammate")],
  };
  fs.mkdirSync(teamDir(teamName), { recursive: true });
  writeConfigAtomic(configPath(teamName), config);
  const store = new BeadsTaskStore({ teamName, workspace: root, authorityFingerprint: fingerprint, requireExpectedVersion: true });
  const publication = new DurableTaskMutationPublication();
  const taskRead = new DurableTaskAuthorityRead(new DurableTaskAuthorityReadTeam());
  const orchestration = new DurableTaskOrchestration(publication, publication);
  const taskFactory = createPublishingBeadsTaskAdapterFactory(publication, new DurableTaskAuthorityTeam(), taskRead, orchestration);
  return {
    teamName,
    store,
    publication,
    graph: new BeadsTaskGraphAdapter(teamName, store, async () => new Set(["maker", "reviewer"])),
    orchestration,
    task: taskFactory(teamName, "team-lead"),
    maker: taskFactory(teamName, "maker"),
    reviewer: taskFactory(teamName, "reviewer"),
  };
}

const graph: TaskGraphCreateInput = {
  operation_id: "mechanical-delivery-1",
  tasks: [
    { key: "plan", title: "Plan", goal: "Approve the plan.", assignee: "maker" },
    { key: "impl", title: "Implement", goal: "Implement the plan.", assignee: "maker" },
    { key: "review", title: "Review", goal: "Review the implementation.", assignee: "reviewer" },
    { key: "verify", title: "Verify", goal: "Verify the implementation empirically.", assignee: "reviewer" },
    { key: "package", title: "Package", goal: "Package the implementation.", assignee: "maker" },
    { key: "final", title: "Finalize", goal: "Finalize all accepted outputs.", assignee: "maker" },
  ],
  dependencies: [
    { task: { key: "impl" }, needs: [{ key: "plan" }] },
    { task: { key: "review" }, needs: [{ key: "impl" }] },
    { task: { key: "verify" }, needs: [{ key: "impl" }] },
    { task: { key: "package" }, needs: [{ key: "impl" }] },
    { task: { key: "final" }, needs: [{ key: "review" }, { key: "verify" }, { key: "package" }] },
  ],
};

async function idsDelivered(teamName: string, worker: string): Promise<string[]> {
  return (await readTaskDeliveries(teamName, worker)).map((record) => record.ref.taskId);
}

async function claimAndSet(adapter: BeadsTaskAdapter, taskId: string, status: "closed" | "blocked") {
  const read = await adapter.read(taskId);
  if (read.kind !== "found") throw new Error("Task read failed.");
  const claimed = await adapter.claim({ taskId, operationId: `claim-${taskId}`, expectedVersion: read.task.version as TaskVersionRef });
  if (claimed.kind !== "updated") throw new Error(`Task claim failed: ${claimed.message}`);
  return adapter.update({
    taskId,
    operationId: `${status}-${taskId}`,
    expectedVersion: claimed.task.version as TaskVersionRef,
    status,
    journalEntries: [{ kind: status === "closed" ? "result" : "blocker", text: status === "closed" ? "External verification passed." : "Adversarial review found a blocking defect." }],
  });
}

describe("real Beads mechanical DAG delivery", () => {
  it("recovers publication and ready delivery after a graph-only commit", async () => {
    const { teamName, graph: graphAdapter, orchestration } = await fixture();
    const recoveryGraph: TaskGraphCreateInput = {
      operation_id: "graph-commit-crash-1",
      tasks: [
        { key: "plan", title: "Plan", goal: "Approve the plan.", assignee: "maker" },
        { key: "impl", title: "Implement", goal: "Implement the plan.", assignee: "maker" },
      ],
      dependencies: [{ task: { key: "impl" }, needs: [{ key: "plan" }] }],
    };
    const committed = await graphAdapter.create(recoveryGraph);
    if (committed.kind !== "created") throw new Error(committed.message);
    expect(readTeamEvents(teamName).headCursor).toBe("0");
    expect(await idsDelivered(teamName, "maker")).toEqual([]);

    const recovered = await orchestration.createGraph(teamName, recoveryGraph);
    expect(recovered).toMatchObject({ kind: "created", replayed: true });
    expect(Number(readTeamEvents(teamName).headCursor)).toBe(2);
    expect(await idsDelivered(teamName, "maker")).toEqual([committed.tasksByKey.plan.id]);

    const recoveredCursor = readTeamEvents(teamName).headCursor;
    await orchestration.createGraph(teamName, recoveryGraph);
    expect(readTeamEvents(teamName).headCursor).toBe(recoveredCursor);
  }, 300_000);

  it("advances ready fronts without leader scheduling turns", async () => {
    const { teamName, orchestration, task, maker, reviewer } = await fixture();
    const created = await orchestration.createGraph(teamName, graph);
    if (created.kind !== "created") throw new Error(created.message);
    const cards = created.tasksByKey;

    expect(await idsDelivered(teamName, "maker")).toEqual([cards.plan.id]);
    expect(await idsDelivered(teamName, "reviewer")).toEqual([]);

    const blockedClaim = await maker.claim({ taskId: cards.impl.id, operationId: "early-impl", expectedVersion: cards.impl.version as TaskVersionRef });
    expect(blockedClaim).toMatchObject({ kind: "refused", reason: "active_blockers", blockerIds: [cards.plan.id] });

    expect(await claimAndSet(maker, cards.plan.id, "closed")).toMatchObject({ kind: "updated" });
    expect(await idsDelivered(teamName, "maker")).toContain(cards.impl.id);

    expect(await claimAndSet(maker, cards.impl.id, "closed")).toMatchObject({ kind: "updated" });
    const makerAfterSplit = await idsDelivered(teamName, "maker");
    const reviewerAfterSplit = await idsDelivered(teamName, "reviewer");
    expect(makerAfterSplit).toContain(cards.package.id);
    const reviewerFront = reviewerAfterSplit.filter((id) => id === cards.review.id || id === cards.verify.id);
    expect(reviewerFront).toHaveLength(1);
    const selected = reviewerFront[0];
    const queued = selected === cards.review.id ? cards.verify.id : cards.review.id;
    expect(reviewerAfterSplit).not.toContain(queued);

    expect(await claimAndSet(reviewer, selected, "blocked")).toMatchObject({ kind: "updated" });
    expect(await idsDelivered(teamName, "reviewer")).toContain(queued);
    expect(await idsDelivered(teamName, "maker")).not.toContain(cards.final.id);

    const beforeReplay = readTeamEvents(teamName).headCursor;
    const replay = await orchestration.createGraph(teamName, graph);
    expect(replay).toMatchObject({ kind: "created", replayed: true });
    expect(readTeamEvents(teamName).headCursor).toBe(beforeReplay);
  }, 300_000);
});
