import { writeJsonFixture } from "./test-write-json";
import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { DurableGraphTaskAuthority } from "../adapters/durable-graph-task-authority";
import { GraphTaskController, GraphObservationRecovery } from "../task-authority/graph-control";
import type { TaskVersionRef } from "../task-authority/task-version-ref";
import { readGraphTaskCards, readGraphTaskCoordinates, observeGraphTaskCoordinates, withGraphReadView } from "./graph-read-view";
import { graphTaskAuthorityPath, teamDir } from "./paths";
import { DurableGraphTaskStateDeliveryQuery } from "../adapters/durable-graph-task-read";
import type { GraphTaskOrchestrationPort } from "../task-authority/graph-orchestration";
import { CoordinationObservationService } from "../coordination/observation-service";
import { projectNonterminalTaskIds, projectTaskChanges } from "../coordination/task-change-projection";

const team = "graph-view-test";
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(teamDir(team), { recursive: true, force: true }); });
async function fixture() {
  const authority = new DurableGraphTaskAuthority();
  await authority.initializeEmpty(team);
  await authority.applyGraph(team, { operationId: "initial", tasks: [{ key: "task", title: "Task", goal: "Complete work", assignee: "worker", needs: [] }] });
  return authority;
}
function replaceFile() {
  const file = graphTaskAuthorityPath(team);
  writeJsonFixture(file, JSON.parse(fs.readFileSync(file, "utf8")));
}
it("shares one recovered projection between Task hydration and delivery evidence without exposing mutable cache state", async () => {
  const authority = await fixture();
  const recover = vi.spyOn(GraphObservationRecovery.prototype, "recover");
  await withGraphReadView(async () => {
    const first = await authority.readTasks(team);
    first[0]!.title = "Changed caller copy";
    first[0]!.needs.push("invented");
    const second = await authority.readTasks(team);
    expect(second[0]!.title).toBe("Task");
    expect(second[0]!.needs).toEqual([]);
    expect(observeGraphTaskCoordinates(team)).toEqual(new Set([`task\u0000${second[0]!.version}`]));
  });
  expect(recover).toHaveBeenCalledTimes(1);
  await withGraphReadView(() => authority.readTasks(team));
  expect(recover).toHaveBeenCalledTimes(1);
});
it.each(["reuse", "completion"])("refuses replaced authority at %s even when bytes are identical", async phase => {
  await fixture();
  await expect(withGraphReadView(async () => {
    readGraphTaskCards(team);
    replaceFile();
    if (phase === "reuse") readGraphTaskCards(team);
  })).rejects.toThrow("Graph authority changed");
});
it("refuses deleted authority instead of serving the cached projection", async () => {
  await fixture();
  await expect(withGraphReadView(async () => {
    readGraphTaskCards(team);
    fs.unlinkSync(graphTaskAuthorityPath(team));
    readGraphTaskCards(team);
  })).rejects.toThrow();
});
it("shares immutable projections across overlapping operation scopes", async () => {
  await fixture();
  const recover = vi.spyOn(GraphObservationRecovery.prototype, "recover");
  await Promise.all([1, 2].map(() => withGraphReadView(async () => {
    readGraphTaskCards(team);
    await Promise.resolve();
    readGraphTaskCards(team);
  })));
  expect(recover).toHaveBeenCalledTimes(1);
});
it("discards the native observation reservation when authority changes after hydration", async () => {
  const authority = await fixture();
  const file = "/sessions/lead.jsonl";
  let replace = true;
  const service = new CoordinationObservationService({
    taskStateDelivery: new DurableGraphTaskStateDeliveryQuery(authority as unknown as GraphTaskOrchestrationPort),
    teamRuntime: {
      readLeaderBinding: async () => ({ teamName: team, sessionFile: file, epochId: "epoch", logicalWorkers: [{ name: "worker", scope: "work" }], members: [
        { name: "team-lead", agentType: "lead", membershipId: "lead", sessionFile: file, isActive: true },
        { name: "worker", membershipId: "worker", sessionFile: "/sessions/worker.jsonl", isActive: true },
      ] }),
      readRuntime: async () => { if (replace) { replaceFile(); replace = false; } return null; },
    },
    alertActuation: { readInboxEvidence: async () => ({ known: true, pending: false }) },
    receivedAlerts: { readRecentReceivedAlerts: async () => ({ alerts: [], omitted: 0 }) },
  }, { projectNonterminalTaskIds, projectTaskChanges }, {
    readEventCursor: () => "0",
    readEvents: () => ({ events: [], cursor: "0", headCursor: "0", truncated: false, remaining: 0 }),
  });
  await expect(service.readTeamSync(file, "snapshot", new AbortController().signal, "stale")).rejects.toThrow("Graph authority changed");
  expect(service.pending(file)).toBeUndefined();
  expect(await service.readTeamSync(file, "snapshot", new AbortController().signal, "fresh")).toMatchObject({ kind: "snapshot" });
  service.clearPending(file);
});
it("does not serve a failed scope after its source becomes corrupt", async () => {
  await fixture();
  await expect(withGraphReadView(async () => { readGraphTaskCards(team); throw new Error("abort"); })).rejects.toThrow("abort");
  fs.writeFileSync(graphTaskAuthorityPath(team), "malformed");
  await expect(withGraphReadView(async () => readGraphTaskCards(team))).rejects.toThrow("cannot be decoded");
});
it("shares Task, ready-front and observation-coordinate reads across operations", async () => {
  const authority = await fixture();
  const recover = vi.spyOn(GraphObservationRecovery.prototype, "recover");
  const first = await authority.readTasks(team);
  expect(await authority.readyFrontier(team, "worker")).toEqual(first);
  observeGraphTaskCoordinates(team);
  await withGraphReadView(() => authority.readTasks(team));
  expect(recover).toHaveBeenCalledTimes(1);
});
it("keeps mutation and commit checks fresh even with a warm read memo", async () => {
  const authority = await fixture();
  const before = (await authority.readTasks(team))[0]!;
  const recover = vi.spyOn(GraphTaskController, "recover");
  readGraphTaskCoordinates(team);
  await withGraphReadView(async () => { readGraphTaskCoordinates(team); });
  expect(recover).toHaveBeenCalledTimes(2);
  await authority.transition(team, { operationId: "claim", taskId: before.id, expectedVersion: before.version as TaskVersionRef, transition: "claim", worker: "worker" });
  expect(recover).toHaveBeenCalledTimes(3);
  const after = (await authority.readTasks(team))[0]!;
  expect(recover).toHaveBeenCalledTimes(3);
  expect(after.status).toBe("in_progress");
  expect(after.version).not.toBe(before.version);
  expect(await authority.readyFrontier(team)).toEqual([]);
  expect((await authority.readTasks(team))[0]).toEqual(after);
  expect(recover).toHaveBeenCalledTimes(3);
  await expect(authority.transition(team, { operationId: "stale", taskId: before.id, expectedVersion: before.version as TaskVersionRef, transition: "claim", worker: "worker" })).rejects.toThrow("changed");
  expect(recover).toHaveBeenCalledTimes(4);
});
it("reuses revision validation only for reads while writes and commit checks stay full", async () => {
  const authority = await fixture();
  const task = (await authority.readTasks(team))[0]!;
  const validate = vi.spyOn(GraphObservationRecovery.prototype as any, "validateRevision");
  const fresh = vi.spyOn(GraphTaskController, "recover");
  await authority.transition(team, { operationId: "context", taskId: task.id, expectedVersion: task.version as TaskVersionRef, currentContext: "New context" });
  expect(fresh).toHaveBeenCalledTimes(1);
  await authority.readTasks(team);
  expect(validate).not.toHaveBeenCalled();
  readGraphTaskCoordinates(team);
  expect(fresh).toHaveBeenCalledTimes(2);
});
it("refuses corruption at commit even if metadata appears unchanged", async () => {
  const authority = await fixture();
  const file = graphTaskAuthorityPath(team);
  await authority.readTasks(team);
  const identity = fs.statSync(file, { bigint: true });
  const corrupt = JSON.parse(fs.readFileSync(file, "utf8"));
  corrupt.graphRevisions[0].tasks[0].goal = "Corrupt goal";
  fs.writeFileSync(file, JSON.stringify(corrupt));
  // A commit validates bytes even when an observation's metadata fence is fooled.
  vi.spyOn(fs, "statSync").mockReturnValue(identity as any);
  expect((await authority.readTasks(team))[0]!.goal).toBe("Complete work");
  expect(() => readGraphTaskCoordinates(team)).toThrow("invalid lineage");
});
it("revalidates identical-byte atomic replacements between operations", async () => {
  const authority = await fixture();
  const first = await authority.readTasks(team);
  const recover = vi.spyOn(GraphObservationRecovery.prototype, "recover");
  const validate = vi.spyOn(GraphObservationRecovery.prototype as any, "validateRevision");
  replaceFile();
  expect(await authority.readTasks(team)).toEqual(first);
  expect(recover).toHaveBeenCalledTimes(1);
  expect(validate).not.toHaveBeenCalled();
  await authority.readTasks(team);
  expect(recover).toHaveBeenCalledTimes(1);
});
it("refuses same-size in-place corruption even when mtime is restored", async () => {
  const authority = await fixture();
  const file = graphTaskAuthorityPath(team);
  const valid = fs.readFileSync(file, "utf8");
  await authority.readTasks(team);
  const stat = fs.statSync(file);
  const corrupt = valid.replace('"title": "Task"', '"title": "Tusk"');
  expect(corrupt).not.toBe(valid);
  expect(corrupt.length).toBe(valid.length);
  fs.writeFileSync(file, corrupt);
  fs.utimesSync(file, stat.atime, stat.mtime);
  await expect(authority.readTasks(team)).rejects.toThrow("cannot be recovered");
  await expect(authority.readyFrontier(team)).rejects.toThrow("cannot be recovered");
  fs.writeFileSync(file, valid);
  expect((await authority.readTasks(team))[0]!.title).toBe("Task");
});
it("invalidates the memo after uncertain file identity", async () => {
  const authority = await fixture();
  await authority.readTasks(team);
  const recover = vi.spyOn(GraphObservationRecovery.prototype, "recover");
  const validate = vi.spyOn(GraphObservationRecovery.prototype as any, "validateRevision");
  const stat = vi.spyOn(fs, "statSync").mockImplementationOnce(() => { throw new Error("injected stat failure"); });
  expect(() => readGraphTaskCards(team)).toThrow("injected stat failure");
  stat.mockRestore();
  await authority.readTasks(team);
  expect(recover).toHaveBeenCalledTimes(1);
  expect(validate).toHaveBeenCalledTimes(1);
});
it("never installs a projection if authority changes during validation", async () => {
  const authority = await fixture();
  const original = GraphObservationRecovery.prototype.recover;
  const recover = vi.spyOn(GraphObservationRecovery.prototype, "recover").mockImplementationOnce(function(this: GraphObservationRecovery, snapshot) {
    const state = original.call(this, snapshot);
    replaceFile();
    return state;
  });
  await expect(authority.readTasks(team)).rejects.toThrow("Graph authority changed");
  await authority.readTasks(team);
  expect(recover).toHaveBeenCalledTimes(2);
});
it("bounds the idle memo to one authority file", async () => {
  const authority = await fixture();
  const other = "other-graph-view";
  try {
    await authority.initializeEmpty(other);
    await authority.applyGraph(other, { operationId: "other-initial", tasks: [{ key: "other", title: "Other", goal: "Other work", assignee: "worker", needs: [] }] });
    const recover = vi.spyOn(GraphObservationRecovery.prototype, "recover");
    const validate = vi.spyOn(GraphObservationRecovery.prototype as any, "validateRevision");
    expect((await authority.readTasks(team))[0]!.id).toBe("task");
    expect((await authority.readTasks(other))[0]!.id).toBe("other");
    expect((await authority.readTasks(team))[0]!.id).toBe("task");
    expect(recover).toHaveBeenCalledTimes(3);
    expect(validate).toHaveBeenCalledTimes(3);
  } finally { fs.rmSync(teamDir(other), { recursive: true, force: true }); }
});
