// Disposable-store operation probe. Opt in with PTB_GRAPH_BENCH_OUTPUT.
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import os from "node:os";
import { expect, it, vi } from "vitest";
import { DurableGraphTaskAuthority } from "../../src/adapters/durable-graph-task-authority";
import { DurableGraphTaskStateDeliveryQuery } from "../../src/adapters/durable-graph-task-read";
import { DurableGraphTaskOrchestration } from "../../src/task-authority/graph-orchestration";
import { DurableTaskMutationPublication } from "../../src/adapters/durable-task-mutation-publication";
import { GraphTaskController } from "../../src/task-authority/graph-control";
import type { GraphTaskOrchestrationPort } from "../../src/task-authority/graph-orchestration";
import { CoordinationObservationService } from "../../src/coordination/observation-service";
import { projectNonterminalTaskIds, projectTaskChanges } from "../../src/coordination/task-change-projection";
import { snapshotEntry } from "../../test/support/branch-observation";
import { teamDir } from "../../src/utils/paths";
import { TaskChangeDelivery } from "../../src/utils/task-delivery";

it.skipIf(!process.env.PTB_GRAPH_BENCH_OUTPUT)("measures copied W=17 graph operations", async () => {
  const team = "graph-probe", file = "/sessions/probe.jsonl";
  const dest = teamDir(team);
  fs.cpSync("/tmp/ptb-freeze/graph-source/team", dest, { recursive: true });
  const config = JSON.parse(fs.readFileSync(`${dest}/config.json`, "utf8"));
  const workers = config.logicalWorkers.slice(0, 17);
  expect(workers).toHaveLength(17);
  const authority = new DurableGraphTaskAuthority();
  const query = new DurableGraphTaskStateDeliveryQuery(authority as unknown as GraphTaskOrchestrationPort);
  const service = new CoordinationObservationService({
    taskStateDelivery: query,
    teamRuntime: {
      readLeaderBinding: async () => ({ teamName: team, sessionFile: file, epochId: "probe", purpose: "Probe", logicalWorkers: workers,
        members: [{ name: "team-lead", agentType: "lead", membershipId: "lead", sessionFile: file, isActive: true }, ...workers.map((w: {name:string}) => ({ name: w.name, membershipId: `m-${w.name}`, sessionFile: `/sessions/${w.name}.jsonl`, isActive: true }))] }),
      readRuntime: async () => null,
    },
    alertActuation: { readInboxEvidence: async () => ({ known: true, pending: false }) },
    receivedAlerts: { readRecentReceivedAlerts: async () => ({ alerts: [], omitted: 0 }) },
  }, { projectNonterminalTaskIds, projectTaskChanges }, {
    readEventCursor: () => "0",
    readEvents: () => ({ events: [], cursor: "0", headCursor: "0", truncated: false, remaining: 0 }),
  });
  const tasks = await authority.readTasks(team);
  service.setBranchEntries(file, [snapshotEntry("base", team, "probe", "lead", tasks)]);
  const methods = ["recover", "readTasks", "readAttempts", "derive"] as const;
  const counts: Record<string, { count: number; ms: number }> = {};
  for (const method of methods) {
    const target = (method === "recover" ? GraphTaskController : GraphTaskController.prototype) as any;
    const original = target[method];
    vi.spyOn(target, method).mockImplementation(function(this: unknown, ...args: unknown[]) {
      const start = performance.now();
      try { return original.apply(this, args); }
      finally { const row = counts[method] ??= { count: 0, ms: 0 }; row.count++; row.ms += performance.now() - start; }
    });
  }
  const rows = [];
  for (const view of ["updates", "snapshot"] as const) {
    for (const key of Object.keys(counts)) delete counts[key];
    const start = performance.now();
    const result = await service.readTeamSync(file, view, new AbortController().signal, view);
    expect(["caught_up", "unsettled", "snapshot"]).toContain(result.kind);
    rows.push({ operation: `team_sync:${view}`, result: result.kind, ms: performance.now() - start, counts: structuredClone(counts) });
    service.clearPending(file);
  }
  const snapshot = JSON.parse(fs.readFileSync(`${dest}/task-authority/graph-control.json`, "utf8"));
  const revision = snapshot.graphRevisions.at(-1);
  for (const key of Object.keys(counts)) delete counts[key];
  const start = performance.now();
  const mutation = await authority.applyGraph(team, { operationId: "graph-probe-replace", expectedGraphVersion: revision.version,
    tasks: revision.tasks.map(({ lineage: _lineage, ...task }: any) => task) });
  expect(mutation.result.kind).toBe("graph_applied");
  rows.push({ operation: "task_graph_apply:authority", result: mutation.result.kind, ms: performance.now() - start, counts: structuredClone(counts) });
  const publication = new DurableTaskMutationPublication();
  const orchestration = new DurableGraphTaskOrchestration(authority, publication, publication, publication);
  const next = JSON.parse(fs.readFileSync(`${dest}/task-authority/graph-control.json`, "utf8")).graphRevisions.at(-1);
  for (const key of Object.keys(counts)) delete counts[key];
  const applyStart = performance.now();
  const applied = await orchestration.applyGraph(team, { operationId: "graph-probe-orchestration", expectedGraphVersion: next.version,
    tasks: next.tasks.map(({ lineage: _lineage, ...task }: any) => task) });
  expect(applied.kind).toBe("applied");
  rows.push({ operation: "task_graph_apply:orchestration", result: applied.kind, ms: performance.now() - applyStart, counts: structuredClone(counts) });
  const worker = workers[0]!.name;
  const delivery = new TaskChangeDelivery({ sendMessage: () => { throw new Error("Unexpected delivery to synthetic Session"); } }, {
    teamName: team, recipient: worker, sessionFile: "/sessions/background-probe.jsonl", membershipId: "background-probe",
    membership: { currentRecipient: async () => ({ membershipId: "background-probe" }), withCurrentRecipient: async (_input, action) => action() },
    graphAuthority: authority,
    reconcileReady: () => orchestration.reconcileReady(team, worker),
    pollMs: 1_000_000,
  });
  try {
    await delivery.start([]);
    for (const key of Object.keys(counts)) delete counts[key];
    const scanStart = performance.now();
    await delivery.scan();
    rows.push({ operation: "background:TaskChangeDelivery.scan", result: "scanned", ms: performance.now() - scanStart, counts: structuredClone(counts) });
  } finally { delivery.stop(); }
  fs.writeFileSync(process.env.PTB_GRAPH_BENCH_OUTPUT!, JSON.stringify({ workers: 17, tasks: tasks.length, revisions: snapshot.graphRevisions.length, events: snapshot.events.length, loadavg: os.loadavg(), bytes: fs.statSync(`${dest}/task-authority/graph-control.json`).size, rows }, null, 2));
  vi.restoreAllMocks();
}, 120_000);
