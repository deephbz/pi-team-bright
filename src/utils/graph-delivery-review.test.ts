import { writeJsonFixture } from "./test-write-json";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { UNSUPPORTED_BEADS_TEAM } from "../task-authority/graph-authority-errors";
import { DurableGraphTaskAuthority } from "../adapters/durable-graph-task-authority";
import * as teams from "./teams";
import * as paths from "./paths";
import * as atomic from "./atomic-json";
import { hostEnv } from "../env/host-env";
import { enqueueTaskChange, reconcileTaskChanges, readTaskDeliveries, readCurrentTaskDeliveries, retireGraphRevisionDeliveries, TaskChangeDelivery } from "./task-delivery";
import { diagnoseTeam, formatTeamStatus } from "./team-status";
const names: string[] = [];
async function fixture() {
  const name = `graph-delivery-review-${process.pid}-${names.length}`; names.push(name);
  await teams.createTeam(name, `/synthetic/${name}-lead`, "lead");
  await teams.addMember(name, { membershipId: "old", agentId: "worker", name: "worker", agentType: "teammate", joinedAt: 1, cwd: "/synthetic", sessionFile: "/synthetic/old", subscriptions: [], isActive: true });
  const graph = new DurableGraphTaskAuthority();
  const mutation = await graph.applyGraph(name, { operationId: "apply", tasks: [{ key: "work", title: "Work", goal: "Complete work.", assignee: "worker" }] });
  const task = (await graph.readTasks(name))[0];
  function engine(membershipId = "old") {
    const sink = { sendMessage: vi.fn(), appendEntry: vi.fn() }, onError = vi.fn();
    const delivery = new TaskChangeDelivery(sink, { teamName: name, recipient: "worker", membershipId, sessionFile: `/synthetic/${membershipId}`, graphAuthority: graph, pollMs: 60000, onError,
      membership: { currentRecipient: async () => ({ membershipId }), withCurrentRecipient: async (_input, action) => action() } });
    return { sink, delivery, onError };
  }
  return { name, graph, task, engine, mutation };
}
afterEach(() => { vi.restoreAllMocks(); for (const name of names.splice(0)) fs.rmSync(paths.teamDir(name), { force: true, recursive: true }); });

it.each([false, true])("refuses live delivery after graph removal with derived fence=%s", async fence => {
  const f = await fixture(), { delivery, sink, onError } = f.engine();
  let tick!: () => void;
  const setInterval = hostEnv().clock.setInterval;
  vi.spyOn(hostEnv().clock, "setInterval").mockImplementation((callback, delay) => { tick = callback; return setInterval(callback, delay); });
  try {
    await delivery.start([]);
    await enqueueTaskChange(f.name, f.task, "assigned");
    if (fence) await retireGraphRevisionDeliveries({ teamName: f.name, graphVersion: f.mutation.graphVersion, graphSequence: f.mutation.graphSequence, authoritySequence: f.mutation.authoritySequence, operationId: "apply", currentTasks: [{ taskId: f.task.id, taskVersion: f.task.version as `v_${string}` }], retiredTasks: [] });
    fs.unlinkSync(paths.graphTaskAuthorityPath(f.name));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(delivery.scan()).rejects.toThrow("Restore its graph authority");
    tick();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("Restore its graph authority") })));
    expect(sink.sendMessage).not.toHaveBeenCalled();
    expect(await readTaskDeliveries(f.name, "worker")).toHaveLength(1);
  } finally { delivery.stop(); }
});

it("classifies graph removal between the delivery lease check and observation identity", async () => {
  const f = await fixture();
  await enqueueTaskChange(f.name, f.task, "assigned");
  const file = paths.graphTaskAuthorityPath(f.name);
  const stat = fs.statSync;
  let removed = false;
  vi.spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
    if (args[0] === file && !removed) {
      removed = true;
      fs.unlinkSync(file);
    }
    return stat(...args);
  }) as typeof fs.statSync);
  await expect(readCurrentTaskDeliveries(f.name, "worker")).rejects.toThrow("Restore its graph authority");
  expect(removed).toBe(true);
  expect(await readTaskDeliveries(f.name, "worker")).toHaveLength(1);
});

it("does not enqueue when the selected recovery target cannot persist", async () => {
  const f = await fixture(), recovery = paths.taskDeliveryRecoveryPath(f.name);
  writeJsonFixture(recovery, [{ teamName: f.name, taskId: f.task.id, taskVersion: f.task.version, recipients: ["worker"], changeKind: "assigned", recordedAt: "2026-10-14T00:00:00Z", reason: "enqueue-failed", taskProjection: f.task }]);
  const original = atomic.writeJsonAtomicAsync;
  vi.spyOn(atomic, "writeJsonAtomicAsync").mockImplementation(async (file, value) => {
    if (file === recovery) throw new Error("Target persistence failed");
    return original(file, value);
  });
  await expect(reconcileTaskChanges(f.name, "worker", f.graph)).rejects.toThrow("Target persistence failed");
  expect(await readTaskDeliveries(f.name, "worker")).toEqual([]);
  expect(JSON.parse(fs.readFileSync(recovery, "utf8"))[0]).not.toHaveProperty("targets");
});

it("persists the target before enqueue and reuses it after resolution failure and replacement", async () => {
  const f = await fixture(), recovery = paths.taskDeliveryRecoveryPath(f.name);
  const old = f.engine(); await old.delivery.start([]);
  writeJsonFixture(recovery, [{ teamName: f.name, taskId: f.task.id, taskVersion: f.task.version, recipients: ["worker"], changeKind: "assigned", recordedAt: "2026-10-14T00:00:00Z", reason: "enqueue-failed", taskProjection: f.task }]);
  const original = atomic.writeJsonAtomicAsync;
  const fault = vi.spyOn(atomic, "writeJsonAtomicAsync").mockImplementation(async (file, value) => {
    if (file === recovery && (value as any[])[0].resolvedRecipients?.length) throw new Error("Crash before recovery resolution");
    if (file === paths.taskDeliveryPath(f.name, "worker")) expect(JSON.parse(fs.readFileSync(recovery, "utf8"))[0].targets).toEqual([expect.objectContaining({ recipientMembershipId: "old" })]);
    return original(file, value);
  });
  try {
    await expect(reconcileTaskChanges(f.name, "worker", f.graph)).rejects.toThrow("Crash before recovery resolution");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await old.delivery.scan(); expect(old.sink.sendMessage).toHaveBeenCalledTimes(1);
  } finally { old.delivery.stop(); fault.mockRestore(); }
  const first = await readTaskDeliveries(f.name, "worker"); expect(first).toHaveLength(1);
  const member = await teams.currentMembership(f.name, "worker");
  await teams.withCurrentMembershipLease(f.name, "old", () => teams.deactivateMembership(f.name, "old", "replaced", { authority: "process_stopped", carrier: "two_stage" }));
  await teams.addMember(f.name, { ...member, membershipId: "new", sessionFile: "/synthetic/new", isActive: true });
  expect(await reconcileTaskChanges(f.name, "worker", f.graph)).toBe(0);
  const replacement = f.engine("new");
  try { await replacement.delivery.start([]); expect(replacement.sink.sendMessage).not.toHaveBeenCalled(); }
  finally { replacement.delivery.stop(); }
  expect((await readTaskDeliveries(f.name, "worker")).map(row => row.deliveryId)).toEqual(first.map(row => row.deliveryId));
});

it.each(["directory", "fence"])("diagnoses lost graph from %s despite obsolete Beads evidence", async marker => {
  const f = await fixture();
  fs.rmSync(path.dirname(paths.graphTaskAuthorityPath(f.name)), { recursive: true });
  if (marker === "directory") fs.mkdirSync(path.dirname(paths.graphTaskAuthorityPath(f.name)));
  else writeJsonFixture(paths.graphRevisionRetirementPath(f.name), {});
  const config = await teams.readConfig(f.name); Object.assign(config, { taskBackend: "beads" }); writeJsonFixture(paths.configPath(f.name), config);
  fs.mkdirSync(path.join(paths.teamDir(f.name), ".beads"));
  await expect(f.graph.readTasks(f.name)).rejects.toThrow("Restore its graph authority");
  const report = await diagnoseTeam(f.name, { role: "lead", sessionBinding: "current" });
  expect(report.taskAuthority).toMatchObject({ backend: "graph", health: "degraded", detail: expect.stringContaining("Restore its graph authority") });
});

it("status names unsupported Beads storage and the next action without a nonexistent graph path", async () => {
  const f = await fixture(); fs.rmSync(path.dirname(paths.graphTaskAuthorityPath(f.name)), { recursive: true });
  fs.mkdirSync(path.join(paths.teamDir(f.name), ".beads"));
  const status = formatTeamStatus(await diagnoseTeam(f.name, { role: "lead", sessionBinding: "current" }));
  expect(status).toContain("Task authority: unsupported_beads_store"); expect(status).toContain(UNSUPPORTED_BEADS_TEAM);
  expect(status).toContain("Finish this Team with its original PTB version or start a new Team.");
  expect(status).not.toContain("Task authority: graph"); expect(status).not.toContain("Task graph:");
  expect(fs.existsSync(path.dirname(paths.graphTaskAuthorityPath(f.name)))).toBe(false);
});
