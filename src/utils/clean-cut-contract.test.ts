import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableGraphTaskAuthority } from "../adapters/durable-graph-task-authority";
import { DurableTaskMutationPublication } from "../adapters/durable-task-mutation-publication";
import { DurableGraphTaskOrchestration } from "../task-authority/graph-orchestration";
import type { TaskVersionRef } from "../task-authority/task-version-ref";
import { taskDeliveryMembership } from "../../test/support/task-delivery-membership";
import * as paths from "./paths";
import * as teams from "./teams";
import { enqueueTaskChange, readTaskDeliveries, TASK_CHANGE_CUSTOM_TYPE, TASK_CHANGE_ACK_ENTRY_TYPE, TaskChangeDelivery } from "./task-delivery";
import * as messaging from "./messaging";

const names: string[] = [];
async function fixture(suffix: string) {
  const name = `clean-cut-graph-${suffix}-${process.pid}-${Date.now()}-${names.length}`; names.push(name);
  const leadSession = `/tmp/${name}-lead.jsonl`;
  const workerSession = `/tmp/${name}-worker.jsonl`;
  await teams.createTeam(name, leadSession, `lead@${name}`);
  const config = await teams.readConfig(name);
  config.logicalWorkers = [{ name: "worker", scope: "Complete the Task criterion." }];
  teams.writeConfigAtomic(paths.configPath(name), config);
  const worker = { membershipId: teams.newMembershipId(), agentId: `worker@${name}`, name: "worker", agentType: "teammate" as const, joinedAt: Date.now(), sessionFile: workerSession, cwd: process.cwd(), subscriptions: [], isActive: true };
  await teams.addMember(name, worker);
  const authority = new DurableGraphTaskAuthority();
  const publication = new DurableTaskMutationPublication();
  const graph = new DurableGraphTaskOrchestration(authority, publication, publication, publication);
  const applied = await graph.applyGraph(name, { operationId: `apply-${suffix}`, tasks: [{ key: "work", title: "Graph Task", goal: "Complete the acceptance criterion.", assignee: "worker" }] });
  if (applied.kind !== "applied") throw new Error(JSON.stringify(applied));
  return { name, leadSession, workerSession, worker, authority, graph, task: applied.tasks[0] };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const name of names.splice(0)) fs.rmSync(paths.teamDir(name), { recursive: true, force: true }); });

describe("graph-only public contracts", () => {
  it("preserves direct Message acceptance without changing Task authority", async () => {
    const { name } = await fixture("messages");
    const accepted = await messaging.sendPlainMessage(name, "team-lead", "worker", "The Task remains authoritative.", "inspect");
    expect(accepted.text).toBe("The Task remains authoritative.");
    expect(await messaging.readInbox(name, "worker", false, false)).toEqual([expect.objectContaining({ id: accepted.id })]);
  });

  it("retries Task delivery until a successful-turn ACK settles its stable delivery ID", async () => {
    const { name, workerSession } = await fixture("ack");
    const queued = (await readTaskDeliveries(name, "worker"))[0];
    expect(queued).toBeDefined();
    const firstSend = vi.fn();
    const first = new TaskChangeDelivery({ sendMessage: firstSend, appendEntry: vi.fn() }, {
      teamName: name, recipient: "worker", sessionFile: workerSession, membership: taskDeliveryMembership, graphAuthority: new DurableGraphTaskAuthority(),
    });
    await first.start([]);
    expect(firstSend).toHaveBeenCalledTimes(1);
    first.stop();

    const retrySend = vi.fn();
    const retry = new TaskChangeDelivery({ sendMessage: retrySend, appendEntry: vi.fn() }, {
      teamName: name, recipient: "worker", sessionFile: workerSession, membership: taskDeliveryMembership, graphAuthority: new DurableGraphTaskAuthority(),
    });
    await retry.start([]);
    expect(retrySend).toHaveBeenCalledTimes(1);
    expect(retrySend.mock.calls[0][0].details.deliveryIds).toEqual([queued!.deliveryId]);
    const details = retrySend.mock.calls[0][0].details;
    retry.stop();

    const presented = { type: "custom_message", id: "presented", parentId: null, timestamp: new Date().toISOString(), customType: TASK_CHANGE_CUSTOM_TYPE, content: "Task change", display: true, details } as any;
    const observed = { type: "custom", id: "ack", parentId: "presented", timestamp: new Date().toISOString(), customType: TASK_CHANGE_ACK_ENTRY_TYPE, data: details } as any;
    const settled = new TaskChangeDelivery({ sendMessage: vi.fn(), appendEntry: vi.fn() }, {
      teamName: name, recipient: "worker", sessionFile: workerSession, membership: taskDeliveryMembership, graphAuthority: new DurableGraphTaskAuthority(),
    });
    await settled.start([presented, observed]);
    expect(await readTaskDeliveries(name, "worker")).toEqual([expect.objectContaining({ deliveryId: queued!.deliveryId, successfulTurnAckAt: expect.any(String) })]);
    settled.stop();
  });

  it("does not send a pending Task change to a replacement Membership", async () => {
    const { name, worker, workerSession, authority } = await fixture("membership-fence");
    await teams.deactivateMember(name, "worker", "replaced");
    const replacementSession = `/tmp/${name}-replacement.jsonl`;
    await teams.addMember(name, { membershipId: teams.newMembershipId(), agentId: `worker-next@${name}`, name: "worker", agentType: "teammate", joinedAt: Date.now(), sessionFile: replacementSession, cwd: process.cwd(), subscriptions: [], isActive: true });
    const send = vi.fn();
    const stale = new TaskChangeDelivery({ sendMessage: send, appendEntry: vi.fn() }, {
      teamName: name, recipient: "worker", membershipId: worker.membershipId, sessionFile: workerSession,
      membership: taskDeliveryMembership, graphAuthority: authority,
    });
    await stale.start([]);
    await stale.scan();
    stale.stop();
    expect(send).not.toHaveBeenCalled();
    expect(await readTaskDeliveries(name, "worker")).toEqual([expect.objectContaining({ recipientMembershipId: worker.membershipId, recipientSessionFile: workerSession })]);
  });

  it("preserves the existing Task spool when atomic replacement fails", async () => {
    const { name, task } = await fixture("atomic-spool");
    const file = paths.taskDeliveryPath(name, "worker");
    fs.rmSync(file, { force: true });
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "absent";
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (target === file) throw new Error("simulated rename failure");
      return rename(source, target);
    });
    await expect(enqueueTaskChange(name, task, "task_changed", "team-lead"))
      .rejects.toThrow("simulated rename failure");
    expect(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "absent").toBe(before);
  });

  it("commits goal success and its evidence in one graph transition", async () => {
    const { name, graph, task, workerSession } = await fixture("terminal");
    const claimed = await graph.transition(name, {
      taskId: task.id, operationId: "claim-terminal", expectedVersion: task.version as TaskVersionRef, transition: "claim", worker: "worker",
    }, "worker");
    expect(claimed.kind).toBe("updated");
    if (claimed.kind !== "updated") return;
    const achieved = await graph.transition(name, {
      taskId: task.id, operationId: "achieve-terminal", expectedVersion: claimed.task.version as TaskVersionRef,
      transition: "goal_achieved", worker: "worker", currentContext: "Acceptance criteria verified.", evidence: "External acceptance check passed.",
    }, "worker");
    expect(achieved).toMatchObject({ kind: "updated", transition: "goal_achieved", task: { status: "goal_achieved", current_context: "Acceptance criteria verified." } });
    expect(workerSession).toContain(name);
  });
});
