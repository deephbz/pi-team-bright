import { writeJsonFixture } from "./test-write-json";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DurableGraphTaskAuthority } from "../adapters/durable-graph-task-authority";
import { createTeam, addMember } from "./teams";
import * as paths from "./paths";
import { enqueueTaskChange, readTaskDeliveries, readTaskDeliveryTombstones, recordTaskDeliveryRecovery, TaskChangeDelivery, type TaskDeliveryRecord } from "./task-delivery";
import type { TaskVersionRef } from "../task-authority/task-version-ref";
import { withSemanticTrace } from "./trace";
const names: string[] = [];
async function fixture(count: number) {
  const name = `graph-spool-${process.pid}-${names.length}`; names.push(name);
  await createTeam(name, `/synthetic/${name}-lead`, "lead");
  await addMember(name, { membershipId: "worker-membership", agentId: "worker", name: "worker", agentType: "teammate", joinedAt: 1, cwd: "/synthetic", sessionFile: "/synthetic/worker", subscriptions: [] });
  const graph = new DurableGraphTaskAuthority();
  await graph.applyGraph(name, { operationId: "apply", tasks: Array.from({ length: count }, (_, i) => ({ key: `task-${i}`, title: `Task ${i}`, goal: "Retain pending evidence.", assignee: "worker" })) });
  const tasks = await graph.readTasks(name);
  const records: TaskDeliveryRecord[] = tasks.map((task, i) => ({ deliveryId: `delivery-${i}`, ref: { kind: "task", taskId: task.id, version: task.version as TaskVersionRef }, changeKind: i % 3 ? "status_changed" : "ownership_lost", teamName: name,
    recipient: "worker", recipientMembershipId: "worker-membership", recipientSessionFile: "/synthetic/worker", targetAgentRef: { kind: "session-trace", nativeId: "synthetic-worker" }, taskProjection: task, queuedAt: new Date(i * 1000).toISOString(), attemptCount: 0 }));
  return { name, graph, tasks, records };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const name of names.splice(0)) fs.rmSync(paths.teamDir(name), { recursive: true, force: true }); });

it("compacts only acknowledged spool history and retains every pending change and tombstone", async () => {
  const f = await fixture(151);
  f.records[0] = (await enqueueTaskChange(f.name, f.tasks[0], "assigned"))!;
  writeJsonFixture(paths.taskDeliveryPath(f.name, "worker"), f.records.slice(0, 150));
  const sink = { sendMessage: vi.fn(), appendEntry: vi.fn() };
  const delivery = new TaskChangeDelivery(sink, { teamName: f.name, recipient: "worker", sessionFile: "/synthetic/worker", membershipId: "worker-membership", graphAuthority: f.graph,
    membership: { currentRecipient: async () => ({ membershipId: "worker-membership" }), withCurrentRecipient: async (_input, action) => action() } });
  try {
    await delivery.start([]);
    const batch = sink.sendMessage.mock.calls[0][0];
    expect(batch.details.deliveryIds).toHaveLength(150);
    await enqueueTaskChange(f.name, f.tasks[150], "assigned");
    await delivery.observeContext([{ role: "custom", customType: batch.customType, details: batch.details }]);
    await delivery.commitPresentedAfterSuccessfulTurn("stop");
    const rows = await readTaskDeliveries(f.name, "worker");
    expect(rows.filter(row => row.successfulTurnAckAt)).toHaveLength(128);
    expect(rows.filter(row => !row.successfulTurnAckAt)).toEqual([expect.objectContaining({ ref: { kind: "task", taskId: f.tasks[150].id, version: f.tasks[150].version } })]);
    expect(await readTaskDeliveryTombstones(f.name, "worker")).toHaveLength(150);
    // Compaction must retain suppression even after the settled row disappears.
    expect(await enqueueTaskChange(f.name, f.tasks[0], "assigned")).toBeNull();
  } finally { delivery.stop(); }
});

it("retains more than 256 pending ownership and status changes without lossy backpressure", async () => {
  const f = await fixture(301);
  writeJsonFixture(paths.taskDeliveryPath(f.name, "worker"), f.records.slice(0, 300));
  await enqueueTaskChange(f.name, f.tasks[300], "assigned");
  expect(await readTaskDeliveries(f.name, "worker")).toHaveLength(301);
  expect((await readTaskDeliveries(f.name, "worker")).slice(0, 300)).toEqual(f.records.slice(0, 300));
});

it("retains more than 256 unresolved exact-target recovery markers", async () => {
  const f = await fixture(300);
  for (const task of f.tasks) await recordTaskDeliveryRecovery({ teamName: f.name, taskId: task.id, taskVersion: task.version as TaskVersionRef, recipients: ["worker"], changeKind: "task_changed", recordedAt: "2026-10-14T00:00:00Z", reason: "enqueue-failed", taskProjection: task });
  const records = JSON.parse(fs.readFileSync(paths.taskDeliveryRecoveryPath(f.name), "utf8"));
  expect(records).toHaveLength(300);
  expect(records.every((record: any) => record.targets[0].recipientMembershipId === "worker-membership" && !record.resolvedRecipients?.length)).toBe(true);
}, 30_000);

it("writes payload-free semantic trace outcomes and lock timing for graph operations", async () => {
  const f = await fixture(1), file = path.join(paths.teamDir(f.name), "trace.jsonl");
  vi.stubEnv("PI_TEAMS_TRACE_JSONL", file);
  const secret = "SYNTHETIC_CONTEXT_MUST_NOT_ENTER_TRACE";
  await withSemanticTrace("task_update", { teamName: f.name, taskId: f.tasks[0].id }, () => f.graph.transition(f.name, { taskId: f.tasks[0].id, expectedVersion: f.tasks[0].version as TaskVersionRef, operationId: "context", currentContext: secret }));
  await expect(withSemanticTrace("task_update", { teamName: f.name }, async () => { throw new Error(secret); })).rejects.toThrow(secret);
  const raw = fs.readFileSync(file, "utf8"), records = raw.trim().split("\n").map(line => JSON.parse(line));
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({ operation: "task_update", taskId: f.tasks[0].id, outcome: "ok", durationMs: expect.any(Number), lockWaitMs: expect.any(Number), bdCallCount: 0 });
  expect(records[1]).toMatchObject({ operation: "task_update", outcome: "error", error: { name: "Error" } });
  expect(raw).not.toContain(secret);
});
