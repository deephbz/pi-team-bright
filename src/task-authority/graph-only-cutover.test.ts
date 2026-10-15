import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableGraphTaskAuthority } from "../adapters/durable-graph-task-authority";
import { UNSUPPORTED_BEADS_TEAM } from "./graph-authority-errors";
import { DurableTeamLifecyclePublication } from "../adapters/durable-team-lifecycle-publication";
import { TeamLifecycleService } from "../team-authority/team-lifecycle-service";
import { DurableGraphAssignedWorkGuard } from "../adapters/durable-graph-assigned-work";
import { DurableGraphTaskStateDeliveryQuery } from "../adapters/durable-graph-task-read";
import { DurableTaskMutationPublication } from "../adapters/durable-task-mutation-publication";
import { DurableGraphTaskOrchestration } from "./graph-orchestration";
import { createTeam, readConfig, writeConfigAtomic } from "../utils/teams";
import { configPath, graphTaskAuthorityPath, taskDeliveryPath, taskDeliveryRecoveryPath, teamDir } from "../utils/paths";
import { readTaskDeliveries, reconcileTaskChanges, TaskChangeDelivery } from "../utils/task-delivery";
import * as atomic from "../utils/atomic-json";
import { hostEnv } from "../env/host-env";
import type { TaskVersionRef } from "./task-version-ref";

const names: string[] = [];
let sequence = 0;
function name() { const value = `graph-only-${process.pid}-${++sequence}`; names.push(value); return value; }
function composition() {
  const authority = new DurableGraphTaskAuthority(); const publication = new DurableTaskMutationPublication();
  const graph = new DurableGraphTaskOrchestration(authority, publication, publication, publication);
  return { authority, publication, graph, guard: new DurableGraphAssignedWorkGuard(graph), query: new DurableGraphTaskStateDeliveryQuery(graph) };
}
async function team(teamName: string) {
  const config = await createTeam(teamName, "synthetic-lead-session", "lead");
  config.logicalWorkers = [{ name: "worker", scope: "Complete the criterion." }];
  config.members.push({ membershipId: "membership-worker", agentId: "worker-agent", name: "worker", agentType: "teammate", joinedAt: 0, cwd: "/synthetic", sessionFile: "synthetic-worker-session", subscriptions: [], isActive: true });
  writeConfigAtomic(configPath(teamName), config);
  return config;
}
const definition = { operationId: "apply", tasks: [{ key: "work", title: "Work", goal: "Criterion passes.", assignee: "worker" }] };
afterEach(() => { vi.restoreAllMocks(); for (const teamName of names.splice(0)) fs.rmSync(teamDir(teamName), { force: true, recursive: true }); });

describe("graph-only Task authority cutover", () => {
  it("creates a Team without Beads, reads its empty graph, applies its first graph and restarts", async () => {
    const teamName = name(); const exec = vi.spyOn(hostEnv().exec, "run");
    const config = await team(teamName); const { authority, graph } = composition();
    expect(config).not.toHaveProperty("taskBackend"); expect(config).not.toHaveProperty("taskWorkspace");
    expect(fs.existsSync(path.join(teamDir(teamName), ".beads"))).toBe(false);
    expect(await authority.readTasks(teamName)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(graphTaskAuthorityPath(teamName), "utf8"))).toMatchObject({ graphRevisions: [], events: [], receipts: [] });
    expect(await graph.applyGraph(teamName, definition)).toMatchObject({ kind: "applied", readyTaskIds: ["work"] });
    expect((await new DurableGraphTaskAuthority().readTasks(teamName))[0]).toMatchObject({ id: "work", status: "ready" });
    expect(exec.mock.calls.some(([binary]) => binary === "bd")).toBe(false);
  });

  it("uses a valid graph with obsolete Beads fields for reads, transitions and delivery without bd", async () => {
    const teamName = name(); const config = await team(teamName); const { graph, query } = composition();
    Object.assign(config, { taskBackend: "beads", taskWorkspace: "/absent-workspace", taskAuthorityId: "obsolete", taskAuthorityFingerprint: { obsolete: true } });
    writeConfigAtomic(configPath(teamName), config);
    const exec = vi.spyOn(hostEnv().exec, "run");
    const applied = await graph.applyGraph(teamName, definition); expect(applied.kind).toBe("applied");
    const task = (await graph.readTasks(teamName))[0];
    expect(await query.listTaskIds(teamName)).toEqual([task.id]);
    expect(await graph.transition(teamName, { taskId: task.id, operationId: "claim", expectedVersion: task.version as TaskVersionRef, transition: "claim", worker: "worker" }, "worker")).toMatchObject({ kind: "updated", task: { status: "in_progress" } });
    expect((await readTaskDeliveries(teamName, "worker")).length).toBeGreaterThan(0);
    expect(exec.mock.calls.some(([binary]) => binary === "bd")).toBe(false);
  });

  it("refuses graphless Beads reads, transitions and work guards without changing .beads", async () => {
    const teamName = name(); const config = await team(teamName); fs.rmSync(path.dirname(graphTaskAuthorityPath(teamName)), { recursive: true });
    Object.assign(config, { taskBackend: "beads" }); writeConfigAtomic(configPath(teamName), config);
    const beads = path.join(teamDir(teamName), ".beads"); fs.mkdirSync(beads); const file = path.join(beads, "retained.json"); fs.writeFileSync(file, '{"tasks":["old"]}');
    const before = fs.readFileSync(file); const { graph, guard, authority } = composition();
    await expect(graph.readTasks(teamName)).rejects.toThrow(UNSUPPORTED_BEADS_TEAM);
    await expect(guard.nonterminalTaskIds(teamName)).rejects.toThrow(UNSUPPORTED_BEADS_TEAM);
    await expect(guard.nonterminalTaskIdsAssignedToWorker(teamName, "worker")).rejects.toThrow(UNSUPPORTED_BEADS_TEAM);
    expect(await graph.applyGraph(teamName, definition)).toMatchObject({ kind: "unavailable", message: UNSUPPORTED_BEADS_TEAM });
    expect(await graph.transition(teamName, { taskId: "old", operationId: "claim", expectedVersion: "v_0000000000000000", transition: "claim", worker: "worker" }, "worker")).toMatchObject({ kind: "unavailable", message: UNSUPPORTED_BEADS_TEAM });
    await expect(authority.initializeEmpty(teamName)).rejects.toThrow(UNSUPPORTED_BEADS_TEAM);
    const lifecyclePublication = new DurableTeamLifecyclePublication();
    const stopped = vi.spyOn(lifecyclePublication, "recordWorkerStopped");
    const lifecycle = new TeamLifecycleService({ assignedWorkGuard: guard, lifecyclePublication });
    const configBefore = fs.readFileSync(configPath(teamName));
    await expect(lifecycle.stopWorker(teamName, "worker")).rejects.toThrow(UNSUPPORTED_BEADS_TEAM);
    await expect(lifecycle.shutdownTeam(teamName)).rejects.toThrow(UNSUPPORTED_BEADS_TEAM);
    expect(stopped).not.toHaveBeenCalled();
    expect(fs.readFileSync(configPath(teamName))).toEqual(configBefore);
    expect(fs.readFileSync(file)).toEqual(before); expect(fs.readdirSync(beads)).toEqual(["retained.json"]);
  });

  it.each(["missing", "corrupt"])("treats a %s established graph as unavailable, never empty", async state => {
    const teamName = name(); await team(teamName); const { graph, guard } = composition();
    if (state === "missing") fs.unlinkSync(graphTaskAuthorityPath(teamName)); else fs.writeFileSync(graphTaskAuthorityPath(teamName), "not-json");
    await expect(graph.readTasks(teamName)).rejects.toThrow(); await expect(guard.nonterminalTaskIds(teamName)).rejects.toThrow();
    expect(await graph.applyGraph(teamName, definition)).toMatchObject({ kind: "unavailable" });
  });

  it("replays a committed non-ready Task after enqueue failure once at Worker startup without bd", async () => {
    const teamName = name(); await team(teamName); const { graph, authority, publication } = composition(); await graph.applyGraph(teamName, definition);
    const task = (await graph.readTasks(teamName))[0];
    const original = atomic.writeJsonAtomicAsync;
    const failure = vi.spyOn(atomic, "writeJsonAtomicAsync").mockImplementation(async (file, data) => { if (file === taskDeliveryPath(teamName, "worker")) throw new Error("Injected spool failure"); return original(file, data); });
    const result = await graph.transition(teamName, { taskId: task.id, operationId: "claim", expectedVersion: task.version as TaskVersionRef, transition: "claim", worker: "worker" }, "worker");
    expect(result).toMatchObject({ kind: "updated", task: { status: "in_progress" } });
    if (result.kind !== "updated") throw new Error("Claim failed");
    await publication.publishTaskMutation({ teamName, before: { ...task, version: task.version as TaskVersionRef }, after: { ...result.task, version: result.task.version as TaskVersionRef }, created: false, kind: "status_changed", actor: "external", taskEventEvidence: [], deliver: true, taskCard: result.task });
    failure.mockRestore();
    expect(fs.existsSync(taskDeliveryRecoveryPath(teamName))).toBe(true);
    const send = vi.fn(); const exec = vi.spyOn(hostEnv().exec, "run");
    const delivery = new TaskChangeDelivery({ sendMessage: send, appendEntry: vi.fn() }, {
      teamName, recipient: "worker", membershipId: "membership-worker", sessionFile: "synthetic-worker-session", graphAuthority: authority,
      membership: { currentRecipient: async () => ({ membershipId: "membership-worker" }), withCurrentRecipient: async (_input, action) => action() },
    });
    try {
      await delivery.start([]); expect(send).toHaveBeenCalledTimes(1);
      expect(await reconcileTaskChanges(teamName, "worker", authority)).toBe(0);
      const committed = (await authority.readTasks(teamName))[0];
      expect((await readTaskDeliveries(teamName, "worker")).filter(record => record.ref.version === committed.version)).toHaveLength(1);
      expect(exec.mock.calls.some(([binary]) => binary === "bd")).toBe(false);
    } finally { delivery.stop(); }
  });
});
