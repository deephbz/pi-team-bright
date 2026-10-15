// Opt-in copied-store probe. Never accesses the live Team root.
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { DurableGraphTaskAuthority } from "../../src/adapters/durable-graph-task-authority";
import { DurableGraphTaskStateDeliveryQuery } from "../../src/adapters/durable-graph-task-read";
import { DurableTaskMutationPublication } from "../../src/adapters/durable-task-mutation-publication";
import { DurableGraphTaskOrchestration } from "../../src/task-authority/graph-orchestration";
import { GraphTaskController, GraphObservationRecovery } from "../../src/task-authority/graph-control";
import { CoordinationObservationService } from "../../src/coordination/observation-service";
import { projectNonterminalTaskIds, projectTaskChanges } from "../../src/coordination/task-change-projection";
import { snapshotEntry } from "../../test/support/branch-observation";
import { teamDir } from "../../src/utils/paths";
import { TaskChangeDelivery } from "../../src/utils/task-delivery";

it.skipIf(!process.env.PTB_GRAPH_MEMO_OUTPUT)("measures unchanged and post-write operations on a W=17 copied store", async () => {
  const team = "graph-memo-probe", session = "/sessions/memo-probe.jsonl", dest = teamDir(team);
  fs.cpSync("/tmp/ptb-freeze/graph-source/team", dest, { recursive: true });
  const config = JSON.parse(fs.readFileSync(`${dest}/config.json`, "utf8"));
  const workers = config.logicalWorkers.slice(0, 17);
  expect(workers).toHaveLength(17);
  const authority = new DurableGraphTaskAuthority();
  const publication = new DurableTaskMutationPublication();
  const graph = new DurableGraphTaskOrchestration(authority, publication, publication, publication);
  const service = new CoordinationObservationService({
    taskStateDelivery: new DurableGraphTaskStateDeliveryQuery(graph),
    teamRuntime: {
      readLeaderBinding: async () => ({ teamName: team, sessionFile: session, epochId: "probe", purpose: "Probe", logicalWorkers: workers,
        members: [{ name: "team-lead", agentType: "lead", membershipId: "lead", sessionFile: session, isActive: true }, ...workers.map((w: {name:string}) => ({ name: w.name, membershipId: `m-${w.name}`, sessionFile: `/sessions/${w.name}.jsonl`, isActive: true }))] }),
      readRuntime: async () => null,
    },
    alertActuation: { readInboxEvidence: async () => ({ known: true, pending: false }) },
    receivedAlerts: { readRecentReceivedAlerts: async () => ({ alerts: [], omitted: 0 }) },
  }, { projectNonterminalTaskIds, projectTaskChanges }, {
    readEventCursor: () => "0", readEvents: () => ({ events: [], cursor: "0", headCursor: "0", truncated: false, remaining: 0 }),
  });
  const worker = workers[0]!.name;
  const delivery = new TaskChangeDelivery({ sendMessage: () => { throw new Error("Unexpected synthetic Session delivery"); } }, {
    teamName: team, recipient: worker, sessionFile: "/sessions/background-probe.jsonl", membershipId: "background-probe",
    membership: { currentRecipient: async () => ({ membershipId: "background-probe" }), withCurrentRecipient: async (_input, action) => action() },
    graphAuthority: authority, reconcileReady: () => graph.reconcileReady(team, worker), pollMs: 1_000_000,
  });
  const tasks = await authority.readTasks(team);
  const baseline = () => service.setBranchEntries(session, [snapshotEntry("base", team, "probe", "lead", tasks)]);
  baseline();
  let counts: Record<string, { count: number; ms: number }> = {};
  const rows: unknown[] = [];
  for (const method of ["recover", "readTasks", "readAttempts", "derive"] as const) for (const target of (method === "recover"
    ? [GraphTaskController, GraphObservationRecovery.prototype] : [GraphTaskController.prototype]) as any[]) {
    const original = target[method];
    vi.spyOn(target, method).mockImplementation(function(this: unknown, ...args: unknown[]) {
      const start = performance.now();
      try { return original.apply(this, args); }
      finally { const row = counts[method] ??= { count: 0, ms: 0 }; row.count++; row.ms += performance.now() - start; }
    });
  }
  async function measure(operation: string, state: string, sample: number, action: () => Promise<unknown>) {
    const uptime = execFileSync("uptime", { encoding: "utf8" }).trim();
    const load = os.loadavg();
    counts = {};
    const begin = performance.now();
    const result = await action();
    rows.push({ operation, state, sample, ms: performance.now() - begin, uptime, load, counts: structuredClone(counts) });
    return result;
  }
  let revision = 0;
  async function write() {
    const current = await authority.readTask(team, tasks[0]!.id);
    await authority.transition(team, { operationId: `memo-context-${++revision}`, taskId: current!.id, expectedVersion: current!.version, currentContext: `Memo probe progress ${revision}` });
    // Read for branch fixture through a separate fresh controller, not the memo.
    const controller = GraphTaskController.recover(JSON.parse(fs.readFileSync(`${dest}/task-authority/graph-control.json`, "utf8")));
    const changed = controller.readTasks().find(task => task.id === current!.id)!;
    tasks[0] = { ...tasks[0]!, version: changed.version, current_context: changed.currentContext };
    baseline();
  }
  try {
    await delivery.start([]);
    for (const state of ["unchanged", "after-write"] as const) {
      for (const operation of ["team_sync:updates", "team_sync:snapshot", "background:scan"] as const) {
        for (let sample = 0; sample < 3; sample++) {
          if (state === "after-write") await write();
          if (operation === "background:scan") await measure(operation, state, sample, () => delivery.scan());
          else {
            const view = operation.endsWith("updates") ? "updates" : "snapshot";
            const result = await measure(operation, state, sample, () => service.readTeamSync(session, view, new AbortController().signal, `${state}-${operation}-${sample}`));
            expect(["unsettled", "snapshot", "caught_up"]).toContain((result as any).kind);
            service.clearPending(session);
          }
        }
      }
    }
    const snapshot = JSON.parse(fs.readFileSync(`${dest}/task-authority/graph-control.json`, "utf8"));
    fs.writeFileSync(process.env.PTB_GRAPH_MEMO_OUTPUT!, JSON.stringify({ workers: workers.length, tasks: tasks.length, sourceBytes: fs.statSync("/tmp/ptb-freeze/graph-source/team/task-authority/graph-control.json").size,
      revisions: snapshot.graphRevisions.length, events: snapshot.events.length, projectedJsonBytes: Buffer.byteLength(JSON.stringify(tasks)), rows }, null, 2));
  } finally { delivery.stop(); service.clearPending(session); vi.restoreAllMocks(); }
}, 240_000);
