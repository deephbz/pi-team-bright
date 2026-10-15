// Run with node --expose-gc -r ts-node/register/transpile-only.
// Measures retained process heap after GC; source data stays in a temporary HOME.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serialize } from "node:v8";
import { execFileSync } from "node:child_process";

async function main() {
  const output = process.env.PTB_GRAPH_MEMO_MEMORY_OUTPUT;
  if (!output || !global.gc) throw new Error("Set PTB_GRAPH_MEMO_MEMORY_OUTPUT and enable --expose-gc.");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ptb-memo-memory-"));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  try {
    const { DurableGraphTaskAuthority } = require("../../src/adapters/durable-graph-task-authority");
    const { loadGraphController } = require("../../src/utils/graph-read-view");
    const { projectGraphTaskCards } = require("../../src/task-authority/graph-card");
    const team = "memo-memory";
    const directory = path.join(root, ".pi", "teams", team);
    fs.cpSync("/tmp/ptb-freeze/graph-source/team", directory, { recursive: true });
    const file = path.join(directory, "task-authority", "graph-control.json");
    const authority = new DurableGraphTaskAuthority();
    function warmFresh() {
      const controller = loadGraphController(team);
      projectGraphTaskCards(controller);
      controller.selectReadyFrontier();
    }
    warmFresh(); warmFresh();
    function heap() { global.gc!(); global.gc!(); global.gc!(); return process.memoryUsage().heapUsed; }
    async function readAndDiscard() {
      const tasks = await authority.readTasks(team);
      return { projectedJsonBytes: Buffer.byteLength(JSON.stringify(tasks)), projectedV8Bytes: serialize(tasks).byteLength };
    }
    const before = heap();
    const sizes = await readAndDiscard();
    const afterFirst = heap();
    for (let iteration = 0; iteration < 10; iteration++) await readAndDiscard();
    const afterTenHits = heap();
    for (let iteration = 0; iteration < 20; iteration++) {
      fs.copyFileSync(file, `${file}.replacement`);
      fs.renameSync(`${file}.replacement`, file);
      await readAndDiscard();
    }
    const afterTwentyReplacements = heap();
    fs.writeFileSync(output, JSON.stringify({ uptime: execFileSync("uptime", { encoding: "utf8" }).trim(), sourceBytes: fs.statSync(file).size, ...sizes,
      heapBytes: { before, afterFirst, afterTenHits, afterTwentyReplacements },
      deltas: { firstRead: afterFirst - before, tenHits: afterTenHits - afterFirst, twentyReplacements: afterTwentyReplacements - afterTenHits } }, null, 2));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
