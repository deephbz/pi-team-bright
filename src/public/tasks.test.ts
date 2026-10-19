import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { GraphTaskController } from "../task-authority/graph-control";
import { readTaskSnapshot } from "./observation";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
it("publishes cards, all dependencies and the authoritative ready frontier; refreshes atomic replacements", async () => {
  const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ptb-public-tasks-")); roots.push(teamsRoot);
  const dir = path.join(teamsRoot, "alpha", "task-authority"); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "graph-control.json");
  const controller = new GraphTaskController();
  const write = () => { fs.writeFileSync(file + ".tmp", JSON.stringify(controller.snapshot())); fs.renameSync(file + ".tmp", file); };
  write();
  expect(await readTaskSnapshot({ teamsRoot, teamName: "alpha" })).toMatchObject({ availability: "available", tasks: [], issues: [] });
  controller.applyGraph({ operationId: "apply", tasks: [
    { key: "a", title: "Read 日本語", goal: "Read.", assignee: "reader" },
    { key: "b", title: "Review", goal: "Review.", assignee: "reviewer", needs: ["a"] },
    { key: "c", title: "Read the next Session", goal: "Read next.", assignee: "reader" },
  ] }); write();
  const first = await readTaskSnapshot({ teamsRoot, teamName: "alpha" });
  expect(first.tasks).toEqual([
    { id: "a", title: "Read 日本語", status: "ready", owner: "reader", deps: [], ready: true },
    { id: "b", title: "Review", status: "dependency_waiting", owner: "reviewer", deps: ["a"], ready: false },
    { id: "c", title: "Read the next Session", status: "ready", owner: "reader", deps: [], ready: false },
  ]);
  first.tasks[0].deps.push("mutated");
  expect((await readTaskSnapshot({ teamsRoot, teamName: "alpha" })).tasks[0].deps).toEqual([]);
  const transition = (operation: "claim" | "goal_achieved") => {
    controller.transition({ taskId: "a", operationId: operation, expectedVersion: controller.readTasks()[0].version, transition: operation, worker: "reader", evidence: "Read verified." });
    write();
  };
  transition("claim");
  expect((await readTaskSnapshot({ teamsRoot, teamName: "alpha" })).tasks.map(t => [t.id, t.status, t.ready])).toEqual([
    ["a", "in_progress", false], ["b", "dependency_waiting", false], ["c", "ready", false],
  ]);
  transition("goal_achieved");
  expect((await readTaskSnapshot({ teamsRoot, teamName: "alpha" })).tasks.map(t => [t.id, t.status, t.ready])).toEqual([
    ["a", "goal_achieved", false], ["b", "ready", true], ["c", "ready", true],
  ]);
  fs.writeFileSync(file, "broken");
  expect(await readTaskSnapshot({ teamsRoot, teamName: "alpha" })).toMatchObject({ availability: "unavailable", tasks: [], issues: ["task_authority_unavailable"] });
  fs.unlinkSync(file);
  expect(await readTaskSnapshot({ teamsRoot, teamName: "alpha" })).toMatchObject({ availability: "unavailable", issues: ["task_authority_missing"] });
  expect(await readTaskSnapshot({ teamsRoot, teamName: "../escape" })).toMatchObject({ availability: "unavailable" });
  expect(await readTaskSnapshot({ teamsRoot, teamName: "alpha", signal: AbortSignal.abort() })).toMatchObject({ issues: ["task_read_interrupted"] });
});
