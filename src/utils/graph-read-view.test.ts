import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { DurableGraphTaskAuthority } from "../adapters/durable-graph-task-authority";
import { GraphTaskController } from "../task-authority/graph-control";
import { readGraphTaskCards, withGraphReadView } from "./graph-read-view";
import { graphTaskAuthorityPath, teamDir } from "./paths";
import { readCurrentGraphTaskCoordinatesLocked } from "./graph-revision-retirement";
import { writeJsonAtomic } from "./atomic-json";
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
  writeJsonAtomic(file, JSON.parse(fs.readFileSync(file, "utf8")));
}
it("shares one recovered projection between Task hydration and delivery evidence without exposing mutable cache state", async () => {
  const authority = await fixture();
  const recover = vi.spyOn(GraphTaskController, "recover");
  await withGraphReadView(async () => {
    const first = await authority.readTasks(team);
    first[0]!.title = "Changed caller copy";
    first[0]!.needs.push("invented");
    const second = await authority.readTasks(team);
    expect(second[0]!.title).toBe("Task");
    expect(second[0]!.needs).toEqual([]);
    expect(readCurrentGraphTaskCoordinatesLocked(team)).toEqual(new Set([`task\u0000${second[0]!.version}`]));
  });
  expect(recover).toHaveBeenCalledTimes(1);
  await withGraphReadView(() => authority.readTasks(team));
  expect(recover).toHaveBeenCalledTimes(2);
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
it("isolates overlapping operation scopes", async () => {
  await fixture();
  const recover = vi.spyOn(GraphTaskController, "recover");
  await Promise.all([1, 2].map(() => withGraphReadView(async () => {
    readGraphTaskCards(team);
    await Promise.resolve();
    readGraphTaskCards(team);
  })));
  expect(recover).toHaveBeenCalledTimes(2);
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
it("does not retain a view after a failed scope", async () => {
  await fixture();
  await expect(withGraphReadView(async () => { readGraphTaskCards(team); throw new Error("abort"); })).rejects.toThrow("abort");
  fs.writeFileSync(graphTaskAuthorityPath(team), "malformed");
  await expect(withGraphReadView(async () => readGraphTaskCards(team))).rejects.toThrow("cannot be decoded");
});
