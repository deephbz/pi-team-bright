import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { enterSimulation, hostEnv, nodeHostEnv, runWithHostEnv, type HostEnv, type TimerHandle } from "../src/env/host-env";
import { withLock } from "../src/utils/lock";
import { probePidPresence } from "../src/utils/runtime";
import { newMembershipId } from "../src/utils/teams";
import { execCommand } from "../src/utils/terminal-adapter";
import { getAdapterByName, getTerminalAdapter } from "../src/adapters/terminal-registry";
import { waitForLivenessHint } from "../src/utils/sync-liveness";
import { observeWorkerStartup } from "../src/utils/worker-startup-observation";
import { appendTeamEvent, waitForTeamEvents } from "../src/coordination/event-journal";
import { teamDir } from "../src/utils/paths";

// Each exception pins its access count. Remove or lower it when routing an
// access through HostEnv; new exceptions require an explicit reason.
const allowlist: Record<string, { count: number; reason: string }> = {
  "src/env/process-generation.ts": { count: 5, reason: "The production generation capability reads procfs or the native macOS helper." },
  "src/env/host-env.ts": { count: 22, reason: "The production capability implementation owns Node primitives." },
  "src/adapters/iterm2-adapter.ts": { count: 1, reason: "AppleScript needs stdin input; HostExec exposes only command and argv." },
  "src/adapters/tmux-adapter.ts": { count: 1, reason: "Legacy shell-based session probe retains execSync error semantics." },
  "src/cli/render-model-tool-contract.ts": { count: 1, reason: "Offline documentation generation runs git with an explicit cwd." },
  "src/utils/beads.ts": { count: 2, reason: "Legacy Beads uses asynchronous child streams, cwd, and process-group cleanup." },
  "src/utils/hooks.ts": { count: 1, reason: "User hooks use asynchronous execFile with a custom environment." },
  "src/utils/trace.ts": { count: 3, reason: "Monotonic diagnostic durations retain performance.now; HostClock is wall time." },
};

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "fixtures" ? [] : sourceFiles(file);
    return /\.(?:[cm]?js|tsx?)$/.test(file) && !/\.(?:test|spec)\.[^.]+$/.test(file) ? [file] : [];
  });
}

/** Parse expressions, so comments, strings, types, and explicit Date values do not count. */
function directAccesses(text: string): string[] {
  const source = ts.createSourceFile("scan.ts", text, ts.ScriptTarget.Latest, true);
  const aliases = new Map<string, string>();
  const hits: string[] = [];
  function canonical(node: ts.Node): string {
    if (ts.isIdentifier(node)) return aliases.get(node.text) ?? node.text;
    if (ts.isPropertyAccessExpression(node)) return `${canonical(node.expression)}.${node.name.text}`.replace(/^globalThis\./, "");
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) return `${canonical(node.expression)}.${node.argumentExpression.text}`.replace(/^globalThis\./, "");
    return node.getText(source);
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text.replace(/^node:/, "");
      const bindings = node.importClause?.namedBindings;
      if (node.importClause?.name) aliases.set(node.importClause.name.text, module);
      if (bindings && ts.isNamespaceImport(bindings)) aliases.set(bindings.name.text, module);
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) aliases.set(item.name.text, `${module}.${item.propertyName?.text ?? item.name.text}`);
      return;
    }
    if (ts.isTypeNode(node)) return;
    const name = canonical(node);
    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && canonical(node.expression) === "Date" && !node.arguments?.length) hits.push("Date clock");
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isIdentifier(node)) {
      if (/^(?:Date\.now|Math\.random|crypto\.(?:randomUUID|randomBytes)|process\.(?:pid|env|kill|exit|cwd|platform)|fs\.watch|performance\.now|Atomics\.wait|child_process\.(?:spawnSync|spawn|execFile|execFileSync|execSync|exec|fork)|timers(?:\/promises)?\.(?:setTimeout|setInterval|clearTimeout|clearInterval))$/.test(name)) {
        hits.push(name);
        return;
      }
    }
    if (ts.isCallExpression(node) && /^(?:setTimeout|setInterval|clearTimeout|clearInterval)$/.test(canonical(node.expression))) hits.push(canonical(node.expression));
    ts.forEachChild(node, visit);
  }
  visit(source);
  return hits;
}

function actor(pid = 7101) {
  let now = 1_700_000_000_000;
  let sequence = 0;
  const scheduled = new Map<TimerHandle, { at: number; callback: () => void; interval?: number }>();
  const watches: Array<{ directory: string; notify: (filename: string | null) => void; fail: (error: unknown) => void; close: ReturnType<typeof vi.fn> }> = [];
  const schedule = (callback: () => void, ms: number, interval?: number): TimerHandle => {
    const owner = hostEnv();
    const handle = {} as TimerHandle;
    scheduled.set(handle, { at: now + ms, callback: () => runWithHostEnv(owner, callback), interval });
    return handle;
  };
  const env: HostEnv = {
    clock: {
      now: () => now,
      setTimeout: (fn, ms) => schedule(fn, ms),
      setInterval: (fn, ms) => schedule(fn, ms, ms),
      clearTimeout: handle => { if (handle) scheduled.delete(handle); },
      clearInterval: handle => { if (handle) scheduled.delete(handle); },
      sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
        const error = () => Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" });
        if (signal?.aborted) { reject(error()); return; }
        const onAbort = () => { scheduled.delete(timer); reject(error()); };
        const timer = schedule(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
      sleepSync: ms => { now += ms; },
    },
    random: { uuid: () => `${pid}-${++sequence}`, float: () => 0, bytes: length => Buffer.alloc(length, pid % 256) },
    process: {
      pid, platform: "linux", cwd: () => "/fixture", env: { PI_AGENT_NAME: `worker-${pid}`, TMUX: "fixture", TMUX_PANE: `%${pid}` },
      pidExists: other => other === pid,
      kill: vi.fn((other: number) => { if (other !== pid) throw Object.assign(new Error("absent"), { code: "ESRCH" }); }),
      generation: () => ({ kind: "unknown", reason: "fixture" }),
      exit: () => { throw new Error("actor exited"); },
    },
    exec: {
      runSync: vi.fn(() => ({ stdout: "actor output", stderr: "", status: 0 })),
      run: vi.fn(async () => ({ kind: "exited" as const, stdout: "actor output", stderr: "", status: 0 })),
    },
    watch: { watchDirectory: (directory, listener) => {
      const owner = hostEnv();
      const watch = { directory, notify: (filename: string | null) => runWithHostEnv(owner, () => listener(filename)), fail: (_error: unknown) => {}, close: vi.fn() };
      watches.push(watch);
      return { close: watch.close, onError: handler => { watch.fail = error => runWithHostEnv(owner, () => handler(error)); } };
    } },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [handle, timer] of [...scheduled]) if (timer.at <= now) {
      if (timer.interval) timer.at += timer.interval; else scheduled.delete(handle);
      timer.callback();
    }
  };
  return { env, advance, scheduled, watches };
}

function moduleTimeEnvReads(text: string): string[] {
  const source = ts.createSourceFile("scan.ts", text, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  function visit(node: ts.Node): void {
    // Function bodies and instance initializers run when the actor calls them.
    if (ts.isFunctionLike(node) || ts.isPropertyDeclaration(node)) return;
    if (ts.isPropertyAccessExpression(node) && node.getText(source) === "hostEnv().process.env") hits.push(node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  return hits;
}

async function flush() { for (let i = 0; i < 5; i++) await Promise.resolve(); }

describe("host capability seam", () => {
  it("pins a shrinking, reasoned direct-access allowlist across src and extensions", () => {
    const actual: Record<string, number> = {};
    for (const file of [...sourceFiles("src"), ...sourceFiles("extensions")]) {
      const hits = directAccesses(fs.readFileSync(file, "utf8"));
      if (hits.length) actual[file] = hits.length;
    }
    for (const entry of Object.values(allowlist)) expect(entry.reason.length).toBeGreaterThan(20);
    expect(actual).toEqual(Object.fromEntries(Object.entries(allowlist).map(([file, entry]) => [file, entry.count])));
  });

  it("keeps actor environment reads out of module initialization", () => {
    expect(moduleTimeEnvReads("const actor = hostEnv().process.env.PI_AGENT_NAME;")).toHaveLength(1);
    expect(moduleTimeEnvReads("function actor() { return hostEnv().process.env.PI_AGENT_NAME; }")).toEqual([]);
    for (const file of [...sourceFiles("src"), ...sourceFiles("extensions")]) {
      expect(moduleTimeEnvReads(fs.readFileSync(file, "utf8")), file).toEqual([]);
    }
  });

  it("finds aliased and bracket host calls without flagging comments or Date formatting", () => {
    expect(directAccesses(`
      import { randomUUID as uuid } from 'node:crypto';
      import * as files from 'node:fs';
      // Date.now(); process.env.HOME
      const example = 'setTimeout()';
      new Date(123); new Date('2026-01-01');
      uuid(); files.watch('/tmp', () => {});
      globalThis.setTimeout(() => {}, 1);
      process['env'].PI_AGENT_NAME; new Date(); Date.now();
    `)).toEqual(["crypto.randomUUID", "fs.watch", "setTimeout", "process.env", "Date clock", "Date.now"]);
  });

  it("keeps concurrent actors isolated after modules were already imported", async () => {
    const a = actor(7101); const b = actor(7102);
    const observe = (env: HostEnv) => runWithHostEnv(env, async () => {
      await Promise.resolve();
      return [newMembershipId(), hostEnv().process.env.PI_AGENT_NAME, execCommand("fixture", ["arg"]).stdout];
    });
    expect(await Promise.all([observe(a.env), observe(b.env)])).toEqual([
      ["membership_7101-1", "worker-7101", "actor output"],
      ["membership_7102-1", "worker-7102", "actor output"],
    ]);
    expect(a.env.exec.runSync).toHaveBeenCalledWith("fixture", ["arg"]);
    expect(b.env.exec.runSync).toHaveBeenCalledWith("fixture", ["arg"]);
    expect(hostEnv()).toBe(nodeHostEnv);
  });

  it("fails closed outside actor scope during simulation", async () => {
    const a = actor(); const release = enterSimulation();
    try {
      expect(() => newMembershipId()).toThrow("outside a simulated actor");
      expect(() => execCommand("fixture", [])).toThrow("outside a simulated actor");
      await runWithHostEnv(a.env, async () => {
        await Promise.resolve();
        expect(newMembershipId()).toBe("membership_7101-1");
      });
    } finally { release(); }
    expect(hostEnv()).toBe(nodeHostEnv);
  });

  it("does not reuse one actor's detected terminal in another actor", () => {
    const a = actor(); const b = actor(7102);
    b.env.process = { ...b.env.process, env: { ZELLIJ: "fixture" } };
    expect(runWithHostEnv(a.env, () => getTerminalAdapter()?.name)).toBe("tmux");
    expect(runWithHostEnv(b.env, () => getTerminalAdapter()?.name)).toBe("zellij");
    expect(runWithHostEnv(a.env, () => getAdapterByName("iTerm2"))).not.toBe(runWithHostEnv(b.env, () => getAdapterByName("iTerm2")));
  });

  it.each(["ESRCH", "EPERM", "EIO"])("keeps conservative PID probe semantics for %s", code => {
    const a = actor();
    a.env.process.kill = () => { throw Object.assign(new Error(code), { code }); };
    expect(runWithHostEnv(a.env, () => probePidPresence(99))).toBe(code === "ESRCH" ? "absent" : "occupied");
  });

  it("uses one clock for lock creation, stale recovery, and heartbeat mtime", async () => {
    const a = actor();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-seam-lock-"));
    const target = path.join(directory, "record");
    const lock = `${target}.lock`;
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: 9999, token: "dead-owner" }));
      const stale = new Date(a.env.clock.now() - 31_000);
      fs.utimesSync(lock, stale, stale);
      await runWithHostEnv(a.env, () => withLock(target, async () => {
        expect(JSON.parse(fs.readFileSync(lock, "utf8"))).toEqual({ pid: 7101, token: "7101-1" });
        expect(fs.statSync(lock).mtimeMs).toBe(a.env.clock.now());
        a.advance(10_000);
        expect(fs.statSync(lock).mtimeMs).toBe(a.env.clock.now());
      }));
      expect(fs.existsSync(lock)).toBe(false);
      expect(fs.existsSync(`${lock}.recovery`)).toBe(false);
      expect(a.scheduled.size).toBe(0);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(["hint", "timeout", "abort", "error"] as const)("cleans actor watches and timers after a liveness %s", async outcome => {
    const a = actor(); const controller = new AbortController();
    const teamName = `host-seam-${outcome}`;
    let ready = false;
    const waiting = runWithHostEnv(a.env, () => waitForLivenessHint({ teamName, waitMs: 500, signal: controller.signal, check: () => ready }));
    const result = waiting.then(value => value, error => error);
    try {
      await flush();
      expect(a.watches).toHaveLength(2);
      a.watches[0].notify(null);
      a.watches[0].notify("unrelated.tmp");
      expect(a.scheduled.size).toBe(2);
      if (outcome === "hint") { ready = true; a.watches[0].notify("worker.json"); }
      if (outcome === "timeout") a.advance(500);
      if (outcome === "abort") controller.abort();
      if (outcome === "error") a.watches[1].fail(new Error("watch failed"));
      const value = await result;
      if (outcome === "abort") expect(value).toMatchObject({ name: "AbortError" });
      else if (outcome === "error") expect(value).toMatchObject({ message: "watch failed" });
      else expect(value).toBe(outcome);
      expect(a.scheduled.size).toBe(0);
      expect(a.watches.every(watch => watch.close.mock.calls.length === 1)).toBe(true);
    } finally { controller.abort(); fs.rmSync(teamDir(teamName), { recursive: true, force: true }); }
  });

  it("stamps journal events and wakes a waiter through the actor watch", async () => {
    const a = actor(); const teamName = "host-seam-journal";
    try {
      const waiting = runWithHostEnv(a.env, () => waitForTeamEvents({ teamName, afterCursor: "0", waitMs: 500 }));
      fs.writeFileSync(path.join(teamDir(teamName), "config.json"), "{}");
      await runWithHostEnv(a.env, () => appendTeamEvent(teamName, { type: "worker", worker: "worker", membershipId: "member", phase: "prepared" }));
      a.watches[0].notify("team-events.jsonl");
      const result = await waiting;
      expect(result.timedOut).toBe(false);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].at).toBe(new Date(a.env.clock.now()).toISOString());
      expect(a.scheduled.size).toBe(0);
      expect(a.watches[0].close).toHaveBeenCalledOnce();
    } finally { fs.rmSync(teamDir(teamName), { recursive: true, force: true }); }
  });

  it("clears the journal actor's timer when another context aborts", async () => {
    const a = actor(); const controller = new AbortController(); const teamName = "host-seam-journal-abort";
    const waiting = runWithHostEnv(a.env, () => waitForTeamEvents({ teamName, afterCursor: "0", waitMs: 500, signal: controller.signal }));
    const result = waiting.catch(error => error);
    try {
      controller.abort();
      expect(await result).toMatchObject({ name: "AbortError" });
      expect(a.scheduled.size).toBe(0);
      expect(a.watches[0].close).toHaveBeenCalledOnce();
    } finally { fs.rmSync(teamDir(teamName), { recursive: true, force: true }); }
  });

  it.each(["visible", "abort", "preaborted"])("uses cancellable actor timers while launch authority is %s", async outcome => {
    const a = actor(); const controller = new AbortController();
    const generation = { membershipId: "member", pid: 7101, startedAt: a.env.clock.now() };
    let visible = false;
    if (outcome === "preaborted") controller.abort();
    const waiting = runWithHostEnv(a.env, () => observeWorkerStartup({
      teamName: "host-seam-startup", workerName: "worker", membershipId: "member", afterCursor: "0", timeoutMs: 500, signal: controller.signal,
      waitForEvents: async () => ({
        events: [{ type: "worker", worker: "worker", membershipId: "member", phase: "session_bound", generation, at: new Date(a.env.clock.now()).toISOString(), cursor: "1" }],
        cursor: "1", headCursor: "1", truncated: false, remaining: 0, timedOut: false,
      }),
      verifyAuthority: async () => visible ? { sessionBound: true, generation } : { sessionBound: false },
    }));
    const result = waiting.catch(error => error);
    await flush();
    if (outcome === "visible") { visible = true; a.advance(50); }
    else controller.abort();
    expect(await result).toMatchObject(outcome === "visible" ? { observed: true } : { name: "AbortError", code: "ABORT_ERR" });
    expect(a.scheduled.size).toBe(0);
  });

  it("uses actor time for the launch-observation ceiling", async () => {
    const a = actor();
    const result = await runWithHostEnv(a.env, () => observeWorkerStartup({
      teamName: "host-seam-startup", workerName: "worker", membershipId: "member", afterCursor: "0", timeoutMs: 500,
      isCarrierAlive: () => true,
      waitForEvents: async () => { a.advance(500); return { events: [], cursor: "0", headCursor: "0", truncated: false, remaining: 0, timedOut: true }; },
      verifyAuthority: async () => ({ sessionBound: false }),
    }));
    expect(result).toMatchObject({ observed: false, reason: "timeout" });
  });
});
