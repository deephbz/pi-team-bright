import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecipientDeliveryLifecycle, type RecipientDeliveryBinding, type RecipientDeliveryPair } from "./recipient-delivery-lifecycle";
import { DirectMessageDelivery, DIRECT_MESSAGE_CUSTOM_TYPE } from "../alert-authority/direct-delivery";
import { sendAlert } from "../alert-authority/alerts";
import { DurableAlertMembership } from "../adapters/durable-alert-membership";
import { DurableCoordinationTeamRuntimeQuery } from "../adapters/durable-coordination-team-runtime";
import { TeamSessionLifecycleService } from "../team-authority/team-session-lifecycle-service";
import { CoordinationObservationService } from "../coordination/observation-service";
import { deriveCarrierView } from "../carrier-observation";
import { formatCarrierStatus } from "./team-status";
import { projectToolTuiMessage } from "../model-tool-contract/tui-projection";
import { snapshotEntry } from "../../test/support/branch-observation";
import { taskDeliveryMembership } from "../../test/support/task-delivery-membership";
import { enqueueTaskChange, TaskChangeDelivery, TASK_CHANGE_CUSTOM_TYPE } from "./task-delivery";
import { DurableGraphTaskAuthority } from "../adapters/durable-graph-task-authority";
import { DurableTaskMutationPublication } from "../adapters/durable-task-mutation-publication";
import { DurableGraphTaskOrchestration } from "../task-authority/graph-orchestration";
import { readRuntimeStatus, writeRuntimeStatus, ownBirthIdentity } from "./runtime";
import * as teams from "./teams";
import { teamDir, taskDir } from "./paths";

const team = "delivery-isolation-fixture";
const workerSession = "/sessions/worker.jsonl", leadSession = "/sessions/lead.jsonl";
const membership = new DurableAlertMembership();
const lifecycles: RecipientDeliveryLifecycle[] = [];
const sessionService = new TeamSessionLifecycleService({} as never);

async function fixture(failed: "alert" | "task") {
  const config = await teams.createTeam(team, leadSession, "lead-agent", "Test independent delivery");
  await teams.ensureLogicalWorker(team, { name: "worker", scope: "Delivery isolation fixture." });
  await teams.addMember(team, { membershipId: "membership-worker", agentId: "worker-agent", name: "worker", agentType: "teammate", joinedAt: 1, tmuxPaneId: "", sessionFile: workerSession, cwd: "/project", subscriptions: [] });
  const member = await teams.currentMembership(team, "worker");
  await writeRuntimeStatus(team, "worker", { pid: process.pid, ...ownBirthIdentity(), startedAt: 1, runState: "settled" }, member.membershipId);
  const accepted = await sendAlert({ teamName: team, from: "team-lead", to: "worker", kind: "clarification", text: "Clarify the evidence." }, membership, { appendAcceptedAlert: async () => ({ cursor: "0" }) });
  const publication = new DurableTaskMutationPublication();
  const graph = new DurableGraphTaskOrchestration(new DurableGraphTaskAuthority(), publication, publication, publication);
  const applied = await graph.applyGraph(team, { operationId: "apply-isolation", tasks: [{ key: "task-one", title: "Inspect", goal: "Inspect the artifact", assignee: "worker" }] });
  if (applied.kind !== "applied") throw new Error(`Graph fixture apply failed: ${JSON.stringify(applied)}`);
  const [card] = await graph.readTasks(team, ["task-one"]);
  const task = await enqueueTaskChange(team, card, "assigned");
  expect(task).not.toBeNull();
  const sink = { sendMessage: vi.fn(), appendEntry: vi.fn() };
  const binding: RecipientDeliveryBinding = { teamName: team, recipient: "worker", membershipId: member.membershipId!, sessionFile: workerSession };
  const direct = new DirectMessageDelivery(sink, { ...binding, membership, pollMs: 60000,
    ...(failed === "alert" ? { dependencies: { readUnread: async () => { throw new Error("Alert inbox unavailable"); } } } : {}) });
  const taskEngine = new TaskChangeDelivery(sink, { ...binding, membership: taskDeliveryMembership, pollMs: 60000,
    reconcile: async () => { if (failed === "task") throw new Error("Task authority unavailable"); return 0; } });
  const wrap = (engine: DirectMessageDelivery | TaskChangeDelivery): RecipientDeliveryPair["direct"] => ({ start: () => engine.start([]), stop: () => engine.stop(), observeContext: messages => engine.observeContext(messages as any), commitPresentedAfterSuccessfulTurn: reason => engine.commitPresentedAfterSuccessfulTurn(reason) });
  const lifecycle: RecipientDeliveryLifecycle = new RecipientDeliveryLifecycle({ makePair: () => ({ direct: wrap(direct), task: wrap(taskEngine) }),
    isCurrentBinding: value => membership.isCurrentSessionBinding(value),
    publishState: async (value, name, state) => { await sessionService.writeDeliveryState(value, name, state, () => lifecycle.binding === value); } });
  lifecycles.push(lifecycle);
  await lifecycle.activate(binding);
  return { member, binding, accepted, sink, lifecycle, config };
}
afterEach(() => {
  lifecycles.splice(0).forEach(lifecycle => lifecycle.deactivate());
  fs.rmSync(teamDir(team), { recursive: true, force: true });
  fs.rmSync(taskDir(team), { recursive: true, force: true });
});

describe("delivery isolation with durable inboxes and runtime facts", () => {
  it("presents an accepted Alert when Task startup fails", async () => {
    const fx = await fixture("task");
    expect(fx.accepted.accepted.map(row => row.recipient)).toEqual(["worker"]);
    expect(fx.sink.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: DIRECT_MESSAGE_CUSTOM_TYPE, content: expect.stringContaining("Clarify the evidence.") }), expect.objectContaining({ triggerTurn: true }));
    expect(fx.sink.sendMessage.mock.calls.some(([message]) => message.customType === TASK_CHANGE_CUSTOM_TYPE)).toBe(false);
    expect((await readRuntimeStatus(team, "worker"))?.delivery?.engines).toMatchObject({ task: { state: "degraded", operation: "start" } });
  });

  it("presents a durable Task when Alert startup fails", async () => {
    const fx = await fixture("alert");
    expect(fx.sink.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: TASK_CHANGE_CUSTOM_TYPE, content: expect.stringContaining("Inspect the artifact") }), expect.objectContaining({ triggerTurn: true }));
    expect(fx.sink.sendMessage.mock.calls.some(([message]) => message.customType === DIRECT_MESSAGE_CUSTOM_TYPE)).toBe(false);
    expect((await readRuntimeStatus(team, "worker"))?.delivery?.engines).toMatchObject({ alert: { state: "degraded", operation: "start" } });
  });

  it("shows exact-generation degradation in team_sync snapshot, unsettled output and ptb status", async () => {
    const fx = await fixture("task");
    const runtimeQuery = new DurableCoordinationTeamRuntimeQuery();
    const lead = fx.config.members.find(member => member.name === "team-lead")!;
    const service = new CoordinationObservationService({
      teamRuntime: { readLeaderBinding: async () => ({ teamName: team, epochId: "epoch", sessionFile: leadSession, logicalWorkers: [{ name: "worker", scope: "Inspect" }], members: [lead, fx.member] }), readRuntime: (name, member) => runtimeQuery.readRuntime(name, member) },
      taskStateDelivery: { listTaskIds: async () => [], readTasks: async () => [], readDeliveryEvidence: async () => ({ known: true, pending: false }) },
      alertActuation: { readInboxEvidence: async () => ({ known: true, pending: false }) },
      receivedAlerts: { readRecentReceivedAlerts: async () => ({ alerts: [], omitted: 0 }) },
    }, { projectNonterminalTaskIds: () => [], projectTaskChanges: () => ({ kind: "projected", changes: [] }) }, {
      readEventCursor: () => "0", readEvents: () => ({ events: [], cursor: "0", headCursor: "0", truncated: false, remaining: 0 }),
    });
    const snapshot = await service.readSnapshot(leadSession);
    expect(snapshot).toMatchObject({ kind: "snapshot", workers: [{ deliveryDegraded: [{ engine: "task", operation: "start", message: "Task authority unavailable" }] }] });
    service.setBranchEntries(leadSession, [snapshotEntry("baseline", team, "epoch", lead.membershipId!, [])]);
    const result = await service.readTeamSync(leadSession, "updates", new AbortController().signal, "sync");
    expect(result).toMatchObject({ kind: "unsettled", workers: [{ name: "worker", reason: "delivery_degraded", delivery_degraded: [{ engine: "task" }] }] });
    service.clearPending(leadSession);
    const view = deriveCarrierView(fx.member, await readRuntimeStatus(team, "worker"));
    expect(formatCarrierStatus(view).line).toContain("task delivery degraded (start: Task authority unavailable");
    const message = projectToolTuiMessage({ tool: "team_sync", expanded: false, details: { kind: "unsettled", head: 0, epoch_id: "epoch", workers: result.kind === "unsettled" ? result.workers : [] } });
    expect(message.body?.join("\n")).toContain("Task authority unavailable");
  });

  it("does not publish a stale lifecycle or expose another Session, Membership or process generation", async () => {
    const fx = await fixture("task");
    const status = await readRuntimeStatus(team, "worker");
    await sessionService.writeDeliveryState(fx.binding, "task", { state: "running", observedAt: 10 }, () => false);
    expect(await readRuntimeStatus(team, "worker")).toEqual(status);
    const query = new DurableCoordinationTeamRuntimeQuery();
    expect((await query.readRuntime(team, { ...fx.member, membershipId: "replacement" }))?.deliveryDegraded).toBeUndefined();
    expect((await query.readRuntime(team, { ...fx.member, sessionFile: "/sessions/other.jsonl" }))?.deliveryDegraded).toBeUndefined();
    await writeRuntimeStatus(team, "worker", { osBirthToken: "other-generation" }, fx.member.membershipId);
    expect((await query.readRuntime(team, fx.member))?.deliveryDegraded).toBeUndefined();
  });
});
