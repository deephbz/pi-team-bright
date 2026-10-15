import { expect, it } from "vitest";
import { prepareWorkload } from "./workload";
it("runs real durable coordination against the declared high-load fixture", async () => {
  const fixture = await prepareWorkload();
  try {
    expect(fixture.dimensions).toEqual({ workers: 10, tasks: 300, initialJournalEvents: 10_000, realWorkerProcesses: 0 });
    for (let i = 0; i < 2; i++) {
      const rows = await fixture.runOnce();
      expect(rows.map(r => r.operation)).toEqual(["journal_append", "team_sync:updates", "team_sync:snapshot", "task_graph_apply:revision"]);
      expect(rows.every(r => Number.isFinite(r.wallMs) && r.wallMs >= 0)).toBe(true);
      console.log(JSON.stringify({ iteration: i, dimensions: fixture.dimensions, rows }));
    }
  } finally { await fixture.close(); }
}, 30_000);
