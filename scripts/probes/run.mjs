#!/usr/bin/env node
// Exploratory fake-drift evidence. Opt-in live host lane, never part of npm test.
// Only control returned, owned pane IDs. Pi has an empty HOME and no PTB extension.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSandbox, LocalProviderFixture, PiRpcProcess, textResponse, PACKAGE } from "../team-sync-continuity-e2e/harness.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(process.env.PI_PROBE_CLI ?? path.join(PACKAGE, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"));
const extension = path.join(HERE, "pi-extension.ts");
const out = path.join(PACKAGE, "sim/fixtures/probes");
const sandboxes = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const metadata = { date: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
  pi: execFileSync(process.execPath, [CLI, "--version"], { encoding: "utf8" }).trim(), base: execFileSync("git", ["rev-parse", "HEAD"], { cwd: PACKAGE, encoding: "utf8" }).trim() };
const assumptions = {
  A1: "herdr agent list omits non-agent terminals.",
  A2: "Herdr drops the Team agent name when Pi exits; the pane keeps its shell.",
  A3: "Pi emits session_shutdown(quit) before process exit.",
  A4: "Pi queues a custom follow-up while streaming.",
  A5: "getBranch() keeps raw entries after compaction.",
  A6: "herdr agent start errors when the pane disappears.",
  A8: "herdr agent list can return a partial result.",
};
function sandbox() { const s = createSandbox(); sandboxes.push(s); return s; }
function scrub(value) {
  let text = JSON.stringify(value, null, 2);
  const replacements = [...sandboxes.flatMap((s) => [[fs.realpathSync(s.root), "<SANDBOX>"], [s.root, "<SANDBOX>"]]), [path.resolve(fs.realpathSync(CLI), "../.."), "<PI_PACKAGE>"], [PACKAGE, "<REPO>"], [os.homedir(), "<HOME>"], [os.hostname(), "<HOST>"], [os.userInfo().username, "<USER>"]];
  for (const [from, to] of replacements) text = text.replaceAll(from, to);
  return text;
}
function save(id, verdict, command, observed) {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${id}.json`), scrub({ assumption: assumptions[id], verdict, command, observed: { environment: metadata, ...observed } }) + "\n");
  console.log(`${id}: ${verdict}`);
}
function logs(s) {
  const file = s.path("events.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
}
async function wait(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
async function herdr(...args) {
  try {
    const { stdout } = await exec("herdr", args, { timeout: 40000, maxBuffer: 4_000_000 });
    if (args[1] === "read") return { text: stdout };
    return stdout.trim() ? JSON.parse(stdout).result : {};
  } catch (e) {
    let payload;
    try { payload = JSON.parse(e.stderr || e.stdout); } catch { payload = { text: e.stderr || e.message }; }
    throw Object.assign(new Error(`herdr ${args.slice(0, 2).join(" ")}: ${JSON.stringify(payload)}`), { payload, code: e.code });
  }
}
async function agents(panes) {
  const result = await herdr("agent", "list");
  return { ...Object.fromEntries(Object.entries(result).filter(([k]) => k !== "agents")), totalAgentCount: result.agents.length, agents: result.agents.filter((a) => panes.includes(a.pane_id)) };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function terminalProbes() {
  assert.equal(process.env.HERDR_ENV, "1", "Run in Herdr with explicit live-probe approval");
  assert.equal(process.platform, "darwin", "This campaign targets macOS");
  metadata.herdr = execFileSync("herdr", ["--version"], { encoding: "utf8" }).trim();
  await agents([]); // Query before control. Never retain unrelated identities.
  const s = sandbox();
  const bin = s.path("bin"); fs.mkdirSync(bin);
  // Use a minimal child environment even if the launching shell inherited a Team.
  const env = { HOME: s.path("home"), USERPROFILE: s.path("home"), PI_CODING_AGENT_DIR: s.path("agent"),
    PI_CODING_AGENT_SESSION_DIR: s.path("sessions"), PROBE_LOG: s.path("events.jsonl"), PATH: process.env.PATH,
    TERM: "xterm-256color", LANG: "C.UTF-8", PI_TELEMETRY: "0" };
  const assignments = Object.entries(env).map(([k, v]) => `${k}=${quote(v)}`).join(" ");
  fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\nexec env -i ${assignments} ${quote(process.execPath)} ${quote(CLI)} "$@"\n`, { mode: 0o700 });
  fs.writeFileSync(s.path("agent", "settings.json"), JSON.stringify({ defaultProjectTrust: "no", hideWelcome: true }));
  const owned = new Set();
  let workspace;
  const checks = [];
  try {
    const created = await herdr("workspace", "create", "--cwd", s.path("project"), "--label", "fake-drift-probes", "--no-focus", "--env", `HOME=${s.path("home")}`, "--env", `PATH=${bin}:${process.env.PATH}`);
    workspace = created.workspace.workspace_id;
    const pane = created.root_pane.pane_id; owned.add(pane);
    console.log(`Owned workspace ${workspace}; pane ${pane}`);
    const control = async (...args) => { assert(owned.has(args[2]), "Refuse foreign pane"); return herdr(...args); };
    // Explicit PATH at the shell prompt also covers shell startup files that reset PATH.
    await sleep(1000);
    await herdr("pane", "process-info", "--pane", pane);
    await control("pane", "run", pane, `export PATH=${quote(`${bin}:${process.env.PATH}`)}; printf 'PROBE_SHELL_READY\\n'`);
    await herdr("pane", "wait-output", pane, "--match", "PROBE_SHELL_READY", "--timeout", "10000");
    const shell = await herdr("pane", "process-info", "--pane", pane);
    const list = await agents([pane]);
    save("A1", list.agents.length === 0 ? "holds" : "refuted", ["herdr workspace create --no-focus --cwd <SANDBOX>/project", `herdr pane process-info --pane ${pane}`, "herdr agent list"], { paneId: pane, workspaceId: workspace, shell, list });
    const name = `probe-${Date.now().toString(36)}`;
    const piArgs = ["--no-extensions", "-e", extension, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-builtin-tools", "--no-approve", "--session-dir", s.path("sessions")];
    for (const method of ["/quit", "Ctrl-D", "SIGTERM"]) {
      const startIndex = logs(s).length;
      const start = await herdr("agent", "start", name, "--kind", "pi", "--pane", pane, "--timeout", "30000", "--", ...piArgs);
      const started = await wait(() => logs(s).slice(startIndex).find((e) => e.event === "session_start"), "Pi session_start");
      const before = { start, agent: await herdr("agent", "get", pane), list: await agents([pane]), processInfo: await herdr("pane", "process-info", "--pane", pane) };
      await herdr("agent", "read", pane, "--source", "recent-unwrapped", "--lines", "20");
      if (method === "/quit") { await control("pane", "send-text", pane, "/quit"); await control("pane", "send-keys", pane, "enter"); }
      else if (method === "Ctrl-D") await control("pane", "send-keys", pane, "ctrl+d");
      else { assert(alive(started.pid)); process.kill(started.pid, "SIGTERM"); }
      await wait(() => !alive(started.pid), "owned Pi exit");
      await sleep(500);
      const after = { list: await agents([pane]), pane: await herdr("pane", "get", pane), processInfo: await herdr("pane", "process-info", "--pane", pane) };
      checks.push({ method, pid: started.pid, processGone: !alive(started.pid), events: logs(s).slice(startIndex), before, after });
    }
    const drop = checks.every((c) => {
      const before = c.before.processInfo.process_info;
      const after = c.after.processInfo.process_info;
      return c.before.list.agents.some((a) => a.name === name) && c.after.list.agents.length === 0
        && !c.after.pane.pane.name && after.shell_pid === before.shell_pid
        && after.foreground_processes.some((p) => p.pid === after.shell_pid);
    });
    save("A2", drop ? "holds" : "refuted", ["herdr agent start <probe-name> --kind pi --pane <owned-pane> -- <isolated flags>", "/quit; Ctrl-D; SIGTERM (separate Pi processes)", "herdr agent list; herdr pane get <owned-pane>; herdr pane process-info --pane <owned-pane>"], { paneId: pane, workspaceId: workspace, scope: "Named Pi occupant uses the same Herdr agent-start surface as PTB. No Team was created or joined; PTB authority lifecycle is not tested.", checks });
    const ordered = checks.every((c) => { const q = c.events.findIndex((e) => e.event === "session_shutdown" && e.reason === "quit"); const x = c.events.findIndex((e) => e.event === "process_exit"); return q >= 0 && x > q && c.processGone; });
    save("A3", ordered ? "holds" : "refuted", ["isolated real Pi -e scripts/probes/pi-extension.ts", "/quit", "Ctrl-D", "kill -TERM <owned-Pi-pid>"], { checks: checks.map(({ method, pid, processGone, events }) => ({ method, pid, processGone, events })), anchor: "Synchronous extension event log orders session_shutdown and process exit; parent independently checks PID disappearance." });
    // Concurrent read pressure only. Do not kill, suspend, or reconfigure Herdr.
    const samples = [];
    for (let wave = 0; wave < 8; wave++) {
      await Promise.all(Array.from({ length: 8 }, async (_, slot) => {
        const begin = Date.now();
        try { const result = await agents([pane]); samples.push({ wave, slot, elapsedMs: Date.now() - begin, result }); }
        catch (e) { samples.push({ wave, slot, error: e.payload }); }
      }));
    }
    const partial = samples.some((x) => x.result?.partial === true || x.result?.complete === false);
    save("A8", partial ? "holds" : "inconclusive", "8 waves x 8 concurrent herdr agent list calls", { paneId: pane, samples, bound: "64 read-only calls; existing agents are not controlled. Only explicit partial/complete metadata qualifies as a partial-result witness. Count changes alone cannot distinguish lifecycle churn from partial reads.", interpretation: partial ? "Explicit partial witness observed." : "No explicit partial witness. This bounded run cannot refute the existential assumption." });
    await control("pane", "close", pane); owned.delete(pane);
    let error;
    try { await herdr("agent", "start", `${name}-gone`, "--kind", "pi", "--pane", pane, "--timeout", "1000", "--", ...piArgs); }
    catch (e) { error = { exitCode: e.code, response: e.payload }; }
    save("A6", error ? "holds" : "refuted", `herdr pane close ${pane}; herdr agent start <probe-name> --kind pi --pane ${pane} --timeout 1000`, { paneId: pane, error, scope: "Start after confirmed close; this does not test disappearance during an in-flight start." });
  } catch (error) {
    for (const pane of owned) console.error(scrub(await herdr("pane", "read", pane, "--source", "recent-unwrapped", "--lines", "30")));
    throw error;
  } finally {
    for (const pane of owned) await herdr("pane", "close", pane);
    if (workspace) {
      try { await herdr("workspace", "close", workspace); } catch (e) { if (!JSON.stringify(e.payload).includes("not_found")) throw e; }
    }
    const remaining = await herdr("workspace", "get", workspace).then(() => true).catch((e) => {
      if (!JSON.stringify(e.payload).includes("not_found")) throw e;
      return false;
    });
    assert.equal(remaining, false, "Owned workspace must be gone after cleanup");
    for (const id of ["A1", "A2", "A3", "A6", "A8"]) {
      const file = path.join(out, `${id}.json`);
      if (!fs.existsSync(file)) continue;
      const fixture = JSON.parse(fs.readFileSync(file, "utf8"));
      if (fixture.observed.environment.date !== metadata.date) continue;
      fixture.observed.cleanup = { workspaceId: workspace, workspaceGone: true, ownedPanesClosed: true };
      fs.writeFileSync(file, scrub(fixture) + "\n");
    }
    console.log("Herdr owned-pane cleanup complete");
  }
}

async function sessionProbes() {
  const s = sandbox();
  const provider = await new LocalProviderFixture().start();
  const pi = new PiRpcProcess(s, provider, { piCli: CLI, extension, env: { PROBE_LOG: s.path("events.jsonl"), PROBE_ALLOW_LOCAL: "1" } });
  fs.writeFileSync(s.path("agent", "settings.json"), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 16, reserveTokens: 1000 } }));
  try {
    await pi.start();
    await pi.command("prompt", { message: "PROBE_OLD_SENTINEL " + "old context ".repeat(100) });
    const first = await provider.nextRequest();
    // Hold an actual SSE stream after a text delta. No model executes.
    first.response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: "probe-stream", object: "chat.completion.chunk", created: 1, model: first.body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    first.response.write(chunk({ role: "assistant", content: "PROBE_STREAM_DELTA" }));
    await pi.waitFor((e) => e.type === "message_update", 10000, "stream delta");
    const streamingState = await pi.command("get_state");
    await pi.command("prompt", { message: "/probe-followup" });
    const queued = await wait(() => logs(s).find((e) => e.event === "followup_queued"), "follow-up queued");
    const requestsWhileHeld = provider.requests.length;
    first.answered = true; provider.pending.splice(provider.pending.indexOf(first), 1);
    first.response.write(chunk({}, "stop")); first.response.end("data: [DONE]\n\n");
    const second = await provider.nextRequest(first.sequence);
    const hasFollowup = JSON.stringify(second.body.messages).includes("PROBE_FOLLOWUP_SENTINEL");
    provider.answer(second, textResponse("PROBE_FOLLOWUP_REPLY"));
    await pi.waitFor((e) => e.type === "agent_settled");
    const entries = pi.sessionEntries();
    const a4 = streamingState.data.isStreaming && queued.idleBefore === false && requestsWhileHeld === 1 && hasFollowup && !JSON.stringify(queued.branch).includes("PROBE_FOLLOWUP_SENTINEL");
    save("A4", a4 ? "holds" : "refuted", "isolated Pi RPC: prompt -> held loopback SSE text delta -> /probe-followup -> release SSE -> second provider request", { streamingState, requestsWhileHeld, queued, nextRequestMessages: second.body.messages.filter((m) => m.role !== "system"), persistedEntries: entries, pendingFlagNote: "The immediate hasPendingMessages value is recorded but does not decide this probe. Delayed delivery at the provider boundary is the oracle.", provider: "Scripted loopback HTTP only; no remote model or credentials." });
    const compact = await pi.command("compact", {}, 20000);
    const before = logs(s).find((e) => e.event === "before_compact");
    const after = logs(s).find((e) => e.event === "after_compact");
    const retained = before && after && before.branch.every((e) => after.branch.some((a) => JSON.stringify(a) === JSON.stringify(e)));
    const hasCompaction = after?.branch.some((e) => e.type === "compaction");
    const contextPruned = after && !JSON.stringify(after.contextEntries).includes("PROBE_OLD_SENTINEL");
    save("A5", compact.success && before && after && hasCompaction && contextPruned ? (retained ? "holds" : "refuted") : "inconclusive", "isolated Pi RPC compact; extension supplies static summary; compare getBranch() before/after and active context", { compact, before, after, rawEntriesRetainedExactly: retained, hasCompaction, contextPruned, providerRequests: provider.requests.length, scope: "Real AgentSession compaction and extension hooks; static summary avoids a model call." });
  } finally { await pi.close(); await provider.close(); }
}

try {
  const lane = process.argv[2] ?? "all";
  assert(["all", "herdr", "pi"].includes(lane), "Usage: node scripts/probes/run.mjs [all|herdr|pi]");
  if (lane !== "pi") await terminalProbes();
  if (lane !== "herdr") await sessionProbes();
} finally { for (const s of sandboxes) s.cleanup(); }
