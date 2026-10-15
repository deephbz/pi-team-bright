// Recovery-cost probe. Generated histories keep current Task count independent.
import fs from "node:fs";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { GraphTaskController, type GraphControlSnapshot } from "../../src/task-authority/graph-control";

it.skipIf(!process.env.PTB_GRAPH_RECOVERY_OUTPUT)("separates recovery phases and history dimensions", () => {
  const source = "/tmp/ptb-freeze/graph-source/team/task-authority/graph-control.json";
  const real = JSON.parse(fs.readFileSync(source, "utf8")) as GraphControlSnapshot;
  const rows: unknown[] = [];
  function measure(label: string, file: string) {
    for (let sample = 0; sample < 3; sample++) {
      const load = os.loadavg();
      let start = performance.now();
      const text = fs.readFileSync(file, "utf8"); const readMs = performance.now() - start;
      start = performance.now(); const snapshot = JSON.parse(text) as GraphControlSnapshot; const parseMs = performance.now() - start;
      let cloneMs = 0, cloneCount = 0;
      const original = globalThis.structuredClone;
      const clone = vi.spyOn(globalThis, "structuredClone").mockImplementation((value: any, options?: any) => {
        const begin = performance.now();
        try { return original(value, options); } finally { cloneMs += performance.now() - begin; cloneCount++; }
      });
      start = performance.now(); const controller = GraphTaskController.recover(snapshot); const recoverMs = performance.now() - start;
      clone.mockRestore();
      start = performance.now(); const tasks = controller.readTasks(); const deriveAndProjectMs = performance.now() - start;
      rows.push({ label, sample, load, bytes: Buffer.byteLength(text), tasks: tasks.length, revisions: snapshot.graphRevisions.length,
        events: snapshot.events.length, receipts: snapshot.receipts.length, readMs, parseMs, recoverMs, cloneMs, cloneCount,
        validationResidualMs: recoverMs - cloneMs, deriveAndProjectMs });
    }
  }
  measure("copied-real", source);
  const generated = `${process.env.PI_TEAMS_VITEST_HOME}/synthetic-graph.json`;
  // Independent axes: fixed current Tasks; vary retained revisions or events.
  for (const [taskCount, revisionCount, eventCount] of [[11, 1, 0], [11, 25, 0], [11, 100, 0], [11, 1, 100], [11, 1, 400], [100, 1, 0], [100, 25, 0]]) {
    const controller = new GraphTaskController();
    const definitions = Array.from({ length: taskCount! }, (_, index) => ({ key: `task-${index}`, title: `Task ${index}`, goal: "Complete synthetic work", assignee: `worker-${index % 17}`, needs: [] }));
    for (let revision = 0; revision < revisionCount!; revision++) controller.applyGraph({ operationId: `revision-${revision}`, expectedGraphVersion: controller.currentGraphVersion(), tasks: definitions });
    for (let event = 0; event < eventCount!; event++) controller.transition({ operationId: `context-${event}`, taskId: "task-0", expectedVersion: controller.readTask("task-0").version, currentContext: `Progress ${event}` });
    fs.writeFileSync(generated, JSON.stringify(controller.snapshot()));
    measure(`synthetic-T${taskCount}-R${revisionCount}-E${eventCount}`, generated);
  }
  expect(real.graphRevisions.length).toBeGreaterThan(1);
  fs.writeFileSync(process.env.PTB_GRAPH_RECOVERY_OUTPUT!, JSON.stringify({ rows }, null, 2));
}, 120_000);
