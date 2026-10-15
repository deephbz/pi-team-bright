import fs from "node:fs";
import fsp from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { DurableGraphTaskAuthority } from "../adapters/durable-graph-task-authority";
import { GraphTaskController, type GraphControlSnapshot } from "../task-authority/graph-control";
import { readCurrentGraphTaskCoordinatesLocked, withGraphRevisionLease } from "./graph-revision-retirement";
import { graphTaskAuthorityPath, teamDir } from "./paths";

const team = "durable-write-interleaving";
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(teamDir(team), { recursive: true, force: true }); });

it("keeps readers and successor receipts fenced while an async graph replacement is suspended", async () => {
  const authority = new DurableGraphTaskAuthority();
  await authority.initializeEmpty(team);
  const task = (title: string) => [{ key: "task", title, goal: "Complete synthetic work", assignee: "worker", needs: [] }];
  const initialApply = await authority.applyGraph(team, { operationId: "initial", tasks: task("Initial") });
  const file = graphTaskAuthorityPath(team);
  const initial = await authority.readTask(team, "task");
  const firstInput = { operationId: "first", expectedGraphVersion: initialApply.graphVersion, tasks: task("First") };
  const simulation = GraphTaskController.recover(JSON.parse(fs.readFileSync(file, "utf8")) as GraphControlSnapshot);
  const firstVersion = simulation.applyGraph(firstInput).graphVersion;
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const rename = fsp.rename.bind(fsp);
  let intercept = true;
  vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
    if (String(to) === file && intercept) {
      intercept = false;
      entered();
      await held;
    }
    return rename(from, to);
  });
  let firstDone = false, readDone = false, nextDone = false;
  const first = authority.applyGraph(team, firstInput).then(result => { firstDone = true; return result; });
  await Promise.race([paused, first.then(() => { throw new Error("Graph write completed before the pause."); })]);
  const read = authority.readTasks(team).then(result => { readDone = true; return result; });
  const next = authority.applyGraph(team, { operationId: "next", expectedGraphVersion: firstVersion, tasks: task("Next") }).then(result => { nextDone = true; return result; });
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    expect([firstDone, readDone, nextDone]).toEqual([false, false, false]);
    const visible = GraphTaskController.recover(JSON.parse(fs.readFileSync(file, "utf8")) as GraphControlSnapshot);
    expect(visible.readTask("task")?.title).toBe("Initial");
    expect(visible.hasOperationReceipt("first")).toBe(false);
    expect(visible.hasOperationReceipt("next")).toBe(false);
    // Delivery-currentness readers use a distinct lease and can see only the
    // complete old snapshot while the writer has not renamed its replacement.
    const coordinates = await withGraphRevisionLease(team, async () => readCurrentGraphTaskCoordinatesLocked(team));
    expect(coordinates).toEqual(new Set([`task\u0000${initial!.version}`]));
  } finally { release(); }
  const [committed, observed, successor] = await Promise.all([first, read, next]);
  expect(committed.result.replayed).toBe(false);
  expect(successor.result.replayed).toBe(false);
  expect(["First", "Next"]).toContain(observed[0].title);
  expect((await authority.readTask(team, "task"))?.title).toBe("Next");
  const final = GraphTaskController.recover(JSON.parse(fs.readFileSync(file, "utf8")) as GraphControlSnapshot);
  expect(final.snapshot().receipts.map(receipt => receipt.operationId)).toEqual(["initial", "first", "next"]);
  expect((await authority.applyGraph(team, firstInput)).result.replayed).toBe(true);
  expect((await authority.readTask(team, "task"))?.title).toBe("Next");
});
