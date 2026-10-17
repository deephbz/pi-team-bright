/** Test-only real durability/coordination workload; synthetic carrier evidence, no Worker processes. */
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { DurableGraphTaskAuthority } from "../../src/adapters/durable-graph-task-authority";
import { DurableGraphTaskStateDeliveryQuery } from "../../src/adapters/durable-graph-task-read";
import type { GraphTaskOrchestrationPort } from "../../src/task-authority/graph-orchestration";
import { CoordinationObservationService, createDurableCoordinationObservationStore } from "../../src/coordination/observation-service";
import { projectNonterminalTaskIds, projectTaskChanges } from "../../src/coordination/task-change-projection";
import { appendTeamEvents } from "../../src/coordination/event-journal";
import { configPath, teamDir } from "../../src/utils/paths";
import { snapshotEntry } from "../../test/support/branch-observation";

export async function prepareWorkload() {
  const team = `responsiveness-${randomUUID()}`;
  const session = `/synthetic/${team}/leader.jsonl`;
  const authority = new DurableGraphTaskAuthority();
  const workers = Array.from({ length: 10 }, (_, i) => ({ name: `worker-${i}`, scope: "Synthetic responsiveness fixture" }));
  const definitions = Array.from({ length: 300 }, (_, i) => ({ key: `task-${i}`, title: `Task ${i}`, goal: "Measure responsiveness", assignee: workers[i % workers.length]!.name, needs: [] }));
  await authority.initializeEmpty(team);
  await fs.writeFile(configPath(team), JSON.stringify({ name: team, logicalWorkers: workers }), { mode: 0o600 });
  const applied = await authority.applyGraph(team, { operationId: "initial", tasks: definitions });
  if (applied.result.kind !== "graph_applied") throw new Error(`Fixture graph failed: ${applied.result.kind}`);
  await appendTeamEvents(team, Array.from({ length: 10_000 }, (_, i) => ({ type: "alert" as const, alertId: `seed-${i}`, from: workers[i % 10]!.name, to: "team-lead", kind: "attention" as const, text: "Synthetic historical coordination event" })));
  const service = new CoordinationObservationService({
    taskStateDelivery: new DurableGraphTaskStateDeliveryQuery(authority as unknown as GraphTaskOrchestrationPort),
    teamRuntime: {
      readLeaderBinding: async () => ({ teamName: team, sessionFile: session, epochId: "probe", purpose: "Responsiveness fixture", logicalWorkers: workers,
        members: [{ name: "team-lead", agentType: "lead", membershipId: "lead", sessionFile: session, isActive: true }, ...workers.map(w => ({ name: w.name, membershipId: `m-${w.name}`, sessionFile: `/synthetic/${w.name}.jsonl`, isActive: true }))] }),
      readRuntime: async () => null,
    },
    alertActuation: { readInboxEvidence: async () => ({ known: true, pending: false }) },
    receivedAlerts: { readRecentReceivedAlerts: async () => ({ alerts: [], omitted: 0 }) },
  }, { projectNonterminalTaskIds, projectTaskChanges }, createDurableCoordinationObservationStore());
  const cards = await authority.readTasks(team);
  service.setBranchEntries(session, [snapshotEntry("baseline", team, "probe", "lead", cards, 10_000)]);
  let graphVersion = applied.result.graphVersion;
  let iteration = 0;
  return {
    dimensions: { workers: 10, tasks: 300, initialJournalEvents: 10_000, realWorkerProcesses: 0 },
    async runOnce() {
      const rows: Array<{ operation: string; wallMs: number; result: string }> = [];
      const measure = async (operation: string, action: () => Promise<string>) => {
        const start = performance.now();
        rows.push({ operation, result: await action(), wallMs: performance.now() - start });
      };
      iteration++;
      await measure("journal_append", async () => { await appendTeamEvents(team, [{ type: "alert", alertId: `iteration-${iteration}`, from: "worker-0", to: "team-lead", kind: "attention", text: "Synthetic incremental coordination event" }]); return "appended"; });
      for (const view of ["updates", "snapshot"] as const) {
        await measure(`team_sync:${view}`, async () => {
          try {
            const result = await service.readTeamSync(session, view, new AbortController().signal, `${iteration}-${view}`);
            if (!["updates", "snapshot", "caught_up", "unsettled"].includes(result.kind)) throw new Error(`Unexpected sync result: ${result.kind}`);
            return result.kind;
          } finally { service.clearPending(session); }
        });
      }
      // Commit a new graph revision through real locking, serialization, fsync and rename.
      await measure("task_graph_apply:revision", async () => {
        const result = await authority.applyGraph(team, { operationId: `revision-${iteration}`, expectedGraphVersion: graphVersion, tasks: definitions });
        if (result.result.kind !== "graph_applied") throw new Error(`Graph replay failed: ${result.result.kind}`);
        graphVersion = result.result.graphVersion;
        return result.result.kind;
      });
      return rows;
    },
    async close() { service.clearPending(session); await fs.rm(teamDir(team), { recursive: true, force: true }); },
  };
}
