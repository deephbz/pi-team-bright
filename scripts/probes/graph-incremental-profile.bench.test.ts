// Opt-in recovery phase probe. Run against the instrumented disposable source
// copy described in /tmp/ptb-freeze/graph-incremental.md, not production source.
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { DurableGraphTaskAuthority } from "../../src/adapters/durable-graph-task-authority";
import { GraphTaskController } from "../../src/task-authority/graph-control";
import type { TaskVersionRef } from "../../src/task-authority/task-version-ref";
import { teamDir, graphTaskAuthorityPath } from "../../src/utils/paths";

it.skipIf(!process.env.PTB_INCR_PROFILE_OUTPUT)("profiles one recovery after each context write in a W=17 copied Team", async () => {
  const team = "incremental-profile", file = graphTaskAuthorityPath(team);
  fs.cpSync("/tmp/ptb-freeze/graph-source/team", teamDir(team), { recursive: true });
  const config = JSON.parse(fs.readFileSync(`${teamDir(team)}/config.json`, "utf8"));
  config.logicalWorkers = config.logicalWorkers.slice(0, 17);
  expect(config.logicalWorkers).toHaveLength(17);
  fs.writeFileSync(`${teamDir(team)}/config.json`, JSON.stringify(config));
  let active = false;
  let phases: Record<string, { count: number; ms: number }> = {};
  const profile = {
    begin: () => performance.now(),
    end: (phase: string, start: number) => { if (active) { const row = phases[phase] ??= { count: 0, ms: 0 }; row.count++; row.ms += performance.now() - start; } },
  };
  (globalThis as any).__ptbIncrProfile = profile;
  const read = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation(((...args: any[]) => {
    const start = performance.now();
    try { return (read as any)(...args); } finally { if (String(args[0]) === file) profile.end("read", start); }
  }) as any);
  const parse = JSON.parse;
  vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    const start = performance.now();
    try { return parse(text, reviver); } finally { if (typeof text === "string" && text.slice(0, 200).includes('"pi-team-bright-graph-control/1"')) profile.end("parse", start); }
  });
  const clone = globalThis.structuredClone;
  vi.spyOn(globalThis, "structuredClone").mockImplementation((value: any, options?: any) => {
    const start = performance.now();
    try { return clone(value, options); } finally { profile.end("structuredClone", start); }
  });
  const derive = (GraphTaskController.prototype as any).derive;
  vi.spyOn(GraphTaskController.prototype as any, "derive").mockImplementation(function(this: unknown, ...args: any[]) {
    const start = performance.now();
    try { return derive.apply(this, args); } finally { profile.end("derive", start); }
  });
  const authority = new DurableGraphTaskAuthority();
  const rows = [];
  try {
    let task = (await authority.readTasks(team))[0]!;
    for (let sample = 0; sample < 3; sample++) {
      const mutation = await authority.transition(team, { operationId: `profile-write-${sample}`, taskId: task.id, expectedVersion: task.version as TaskVersionRef, currentContext: `Profile progress ${sample}` });
      task = mutation.after.find(item => item.id === task.id)!;
      const uptime = execFileSync("uptime", { encoding: "utf8" }).trim();
      const load = os.loadavg();
      phases = {}; active = true;
      const start = performance.now();
      await authority.readTasks(team);
      const ms = performance.now() - start;
      active = false;
      if (process.env.PTB_INCR_PROFILE_REUSED === "1") {
        expect(phases.currentRevision?.count ?? 0).toBe(0);
        expect(phases.retainedRevisions?.count ?? 0).toBe(0);
        expect(phases.revisionFingerprint?.count).toBeGreaterThan(0);
      } else {
        expect(phases.currentRevision?.count).toBe(1);
        expect(phases.retainedRevisions?.count).toBeGreaterThan(0);
      }
      rows.push({ sample, ms, uptime, load, phases: structuredClone(phases) });
    }
    fs.writeFileSync(process.env.PTB_INCR_PROFILE_OUTPUT!, JSON.stringify({ workers: 17, rows }, null, 2));
  } finally { active = false; delete (globalThis as any).__ptbIncrProfile; vi.restoreAllMocks(); }
}, 120_000);
