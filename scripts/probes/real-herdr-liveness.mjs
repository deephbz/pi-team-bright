#!/usr/bin/env node
// Opt-in D5 campaign. Real PTB/Pi/Herdr; only the owned launch environment and
// observation transport are faulted. Never stop the shared Herdr server.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE, createSandbox, LocalProviderFixture, PiRpcProcess, textResponse, toolCallResponse, toolResults } from "../team-sync-continuity-e2e/harness.mjs";
const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(PACKAGE, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const extension = path.join(HERE, "liveness-extension.ts");
const realHerdr = execFileSync("which", ["herdr"], { encoding: "utf8" }).trim();
const box = createSandbox();
const bin = box.path("bin"); fs.mkdirSync(bin);
const team = "d5-isolated";
const teamDir = box.path("home", ".pi", "teams", team);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
const readLines = file => fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const events = () => readLines(path.join(teamDir, "events/team-events.jsonl"));
const config = () => readJson(path.join(teamDir, "config.json"));
const member = name => config()?.members.find(m => m.name === name);
const runtime = name => readJson(path.join(teamDir, "runtime", `${name}.json`));
const lifecycle = () => readLines(box.path("lifecycle.jsonl"));
const owned = () => readLines(box.path("owned.jsonl")).map(row => row.pane_id);
const results = new Map();
const selected = new Set((process.argv[2] ?? "1,3,5,9").split(",").map(Number));
assert([...selected].every(item => [1,3,5,9].includes(item)), "Select items 1,3,5,9");
let workspace, pi, provider;
const meta = { base: execFileSync("git", ["rev-parse", "HEAD"], { cwd: PACKAGE, encoding: "utf8" }).trim(), date: new Date().toISOString(), platform: process.platform, arch: process.arch,
  pi: execFileSync(process.execPath, [CLI, "--version"], { encoding: "utf8" }).trim(), herdr: execFileSync(realHerdr, ["--version"], { encoding: "utf8" }).trim(), node: process.version, helperBuilt: fs.existsSync(path.join(PACKAGE, "native/bin/process-generation")) };
async function wait(predicate, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await predicate(); if (result) return result; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
async function herdr(...args) {
  const { stdout } = await exec(realHerdr, args, { timeout: 35000, maxBuffer: 4_000_000 });
  return args[1] === "read" ? { text: stdout } : stdout.trim() ? JSON.parse(stdout).result : {};
}
async function control(action, pane, ...rest) {
  assert(owned().includes(pane), "Refuse control of foreign pane");
  return herdr("pane", action, pane, ...rest);
}
async function inspect(name) {
  const m = member(name), pane = m?.terminalTarget?.targetId;
  assert(owned().includes(pane));
  const [listed, raw, processes] = await Promise.all([herdr("agent", "list"), herdr("pane", "get", pane), herdr("pane", "process-info", "--pane", pane)]);
  return { member: m, runtime: runtime(name), pane: raw.pane, processInfo: processes.process_info, agents: listed.agents.filter(a => a.pane_id === pane) };
}
async function command(pane, text) {
  assert(owned().includes(pane));
  await herdr("agent", "get", pane);
  await herdr("agent", "read", pane, "--source", "recent-unwrapped", "--lines", "20");
  await control("send-text", pane, text); await control("send-keys", pane, "enter");
}
async function tool(name, args) {
  const seq = provider.requests.at(-1)?.sequence ?? 0, start = pi.records.length;
  await pi.command("prompt", { message: `Run isolated probe operation ${name}.` });
  const request = await provider.nextRequest(seq, 30000);
  const call = toolCallResponse(name, args);
  assert(request.body.tools.some(t => t.function.name === name));
  provider.answer(request, call);
  const next = await provider.nextRequest(request.sequence, 30000);
  const [result] = toolResults(next, [call]);
  provider.answer(next, textResponse("Probe operation recorded."));
  await pi.waitForNew(e => e.type === "agent_settled", start, 30000);
  return result;
}
async function status() {
  const previous = pi.sessionEntries().filter(e => e.type === "custom" && e.customType === "ptb.status").length;
  await pi.command("prompt", { message: "/ptb status" }, 30000);
  return wait(() => {
    const entries = pi.sessionEntries().filter(e => e.type === "custom" && e.customType === "ptb.status");
    return entries.length > previous && entries.at(-1);
  }, "ptb.status entry");
}
async function start(name) {
  const receipt = await tool("ensure_worker", { name, scope: "Idle carrier for an isolated liveness probe. Do not call a model." });
  console.log(`ensure ${name}: ${JSON.stringify(receipt)}`);
  await wait(() => runtime(name)?.osBirthToken && member(name)?.sessionFile, `Worker ${name} admission`);
  await wait(async () => (await inspect(name)).agents.some(a => a.interactive_ready), `Worker ${name} ready`);
  await status(); await delay(1000);
  return { receipt, state: await inspect(name) };
}
function note(item, expected, verdict, observed) {
  const worker = { 1: "quit-worker", 3: "never-worker", 5: "session-worker", 9: "outage-worker" }[item];
  const leadNotifications = pi.records.filter(record => record.type === "extension_ui_request" && record.method === "notify"
    && (record.message?.startsWith(`Worker ${worker}:`) || item === 9 && record.message?.startsWith("Herdr observation unavailable")));
  results.set(item, { item, expected, verdict, command: `node scripts/probes/real-herdr-liveness.mjs ${[...selected].join(",")}`, observed: { environment: meta, ...observed, leadNotifications } });
  console.log(`Item ${item}: ${verdict}`);
}

// The shim adds HOME/PATH to *owned* splits because the production adapter's
// environment allowlist intentionally forwards PI_* but not HOME or PATH.
function installShims() {
  const shimConfig = { root: box.root, realHerdr, node: process.execPath, cli: CLI, bin, path: process.env.PATH };
  fs.writeFileSync(box.path("shim-config.json"), JSON.stringify(shimConfig));
  fs.writeFileSync(path.join(bin, "herdr"), `#!${process.execPath}\n` + `
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
const c = JSON.parse(fs.readFileSync(${JSON.stringify(box.path("shim-config.json"))}));
const args = process.argv.slice(2), owns = () => fs.readFileSync(path.join(c.root,'owned.jsonl'),'utf8').trim().split('\\n').filter(Boolean).map(x=>JSON.parse(x).pane_id);
const log = x => fs.appendFileSync(path.join(c.root,'cli.jsonl'),JSON.stringify({at:Date.now(),...x})+'\\n');
if (args[0]==='server') throw Error('Shared server control forbidden');
if (fs.existsSync(path.join(c.root,'outage')) && ['agent','pane'].includes(args[0]) && args[1]==='list') { log({args,fault:'scoped_observation_outage'}); process.stderr.write('Scoped probe transport unavailable\\n'); process.exit(75); }
if (args[0]==='pane' && args[1]==='split') {
 const target=args[args.indexOf('--pane')+1]; if(!owns().includes(target)) throw Error('Foreign split target');
 args.push('--env','HOME='+path.join(c.root,'home'),'--env','USERPROFILE='+path.join(c.root,'home'),'--env','ZDOTDIR='+path.join(c.root,'home'),'--env','PATH='+c.bin+':'+c.path);
}
if (args[0]==='agent' && args[1]==='start') {
 if(!owns().includes(args[args.indexOf('--pane')+1])) throw Error('Foreign start target');
 if(fs.existsSync(path.join(c.root,'fail-pi'))) args[args.indexOf('--timeout')+1]='4000';
}
const child=cp.spawnSync(c.realHerdr,args,{encoding:'utf8',timeout:350000,maxBuffer:4000000});
if(args[0]==='pane' && args[1]==='split' && child.status===0) {
 const pane=JSON.parse(child.stdout).result.pane; fs.appendFileSync(path.join(c.root,'owned.jsonl'),JSON.stringify(pane)+'\\n');
}
log({args,status:child.status,stdout:child.stdout,stderr:child.stderr});
process.stdout.write(child.stdout||''); process.stderr.write(child.stderr||''); process.exit(child.status??1);
` , { mode: 0o700 });
  fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}\n` + `
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const c=JSON.parse(fs.readFileSync(${JSON.stringify(box.path("shim-config.json"))}));
if(fs.existsSync(path.join(c.root,'fail-pi'))) { fs.appendFileSync(path.join(c.root,'pi-failures.jsonl'),JSON.stringify({at:Date.now(),worker:process.env.PI_AGENT_NAME,exitCode:73})+'\\n'); process.exit(73); }
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('PI_')||k.startsWith('HERDR_')));
Object.assign(env,{HOME:path.join(c.root,'home'),USERPROFILE:path.join(c.root,'home'),PI_CODING_AGENT_DIR:path.join(c.root,'agent'),PI_CODING_AGENT_SESSION_DIR:path.join(c.root,'sessions'),PATH:c.bin+':'+c.path,TERM:'xterm-256color',LANG:'C.UTF-8',NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'});
const child=cp.spawn(c.node,[c.cli,'--no-extensions','--no-skills','--no-context-files','--no-prompt-templates','--no-themes',...process.argv.slice(2)],{env,stdio:'inherit'});
child.on('exit',(code,signal)=>process.exit(code??(signal?1:0)));
` , { mode: 0o700 });
}

try {
  assert.equal(process.env.HERDR_ENV, "1"); assert.equal(process.platform, "darwin"); assert(meta.helperBuilt);
  await herdr("agent", "list");
  installShims();
  const created = await herdr("workspace", "create", "--no-focus", "--cwd", box.path("project"), "--label", "isolated-d5-probes", "--env", `HOME=${box.path("home")}`, "--env", `ZDOTDIR=${box.path("home")}`, "--env", `PATH=${bin}:${process.env.PATH}`);
  workspace = created.workspace.workspace_id;
  fs.writeFileSync(box.path("owned.jsonl"), JSON.stringify(created.root_pane) + "\n");
  console.log(`Owned workspace ${workspace}, leader pane ${created.root_pane.pane_id}`);
  fs.writeFileSync(box.path("agent", "settings.json"), JSON.stringify({ defaultProjectTrust: "no", compaction: { enabled: false }, pi_team_bright: {
    model_roles: { fixture: { model: "fixture/worker-scripted", thinking: "off", use: "Isolated local probe" } }, default_model_role: "fixture",
    team: { date_prefix: false, auto_sync_enabled: false, wait_seconds: 0 },
  } }));
  provider = await new LocalProviderFixture().start();
  const env = { PATH: `${bin}:${process.env.PATH}`, HERDR_ENV: "1", HERDR_PANE_ID: created.root_pane.pane_id, HERDR_TAB_ID: created.tab.tab_id, HERDR_WORKSPACE_ID: workspace,
    PI_PROBE_LOG: box.path("lifecycle.jsonl"), PI_TEAM_BRIGHT_SHIPPED_EXTENSION: extension };
  // Preserve socket selection only, never the parent's Team or Session binding.
  for (const [key, value] of Object.entries(process.env)) if (key.startsWith("HERDR_") && !["HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"].includes(key)) env[key] = value;
  pi = await new PiRpcProcess(box, provider, { extension, env }).start();
  const createdTeam = await tool("team_create", { name: team, purpose: "Isolated D5 carrier verification" });
  console.log(`team_create: ${JSON.stringify(createdTeam)}`);
  assert.equal(createdTeam.kind, "team_created");

  // Item 1: real keyboard quit, independent OS and Herdr observations, and UI entry.
  if (selected.has(1)) {
    const started = await start("quit-worker"), before = events().length, pane = started.state.pane.pane_id;
    await herdr("agent", "get", pane); await herdr("agent", "read", pane, "--source", "recent-unwrapped", "--lines", "20");
    await control("send-keys", pane, "ctrl+c"); await delay(100); await control("send-keys", pane, "ctrl+c");
    await wait(() => runtime("quit-worker")?.lastStop?.piReason === "quit", "quit shutdown hook");
    await wait(() => events().slice(before).some(e => e.carrier?.field === "process" && e.carrier.to === "gone"), "gone carrier event");
    const after = await inspect("quit-worker"), entry = await status(), changes = events().slice(before);
    const gone = changes.find(e => e.carrier?.field === "process" && e.carrier.to === "gone");
    const pass = after.agents.length === 0 && after.processInfo.foreground_processes.some(p => p.pid === after.processInfo.shell_pid)
      && gone?.carrier.suspectedHumanStop && gone?.carrier.nextActionHint === "ask_human";
    note(1, { carrier: "quit stop evidence, verified process gone, suspected human stop and ask_human", status: "process gone; terminal present; lastStop=quit", pane: "same shell survives and Team agent name disappears", historicalNote: "Proposal B item 1 describes reused as the pre-fix defect. This run does not request an unauthorized relaunch." }, pass ? "holds" : "refuted", { started, after, carrierEvents: changes, statusEntry: entry });
  }
  // Item 5: reload is same-process continuity; new replaces the Session binding.
  if (selected.has(5)) {
    const started = await start("session-worker"), pane = started.state.pane.pane_id, before = events().length, lifecycleBefore = lifecycle().length;
    await command(pane, "/reload");
    await wait(() => lifecycle().slice(lifecycleBefore).some(e => e.worker === "session-worker" && e.event === "session_start" && e.reason === "reload"), "reload complete");
    const reload = await inspect("session-worker"), reloadStatus = await status();
    const beforeNew = events().length;
    await command(pane, "/new");
    await wait(() => runtime("session-worker")?.lastStop?.piReason === "new", "new shutdown hook");
    await delay(6500);
    const afterNew = await inspect("session-worker"), newStatus = await status();
    const ensureAfterNew = await tool("ensure_worker", { name: "session-worker", scope: "Idle carrier for an isolated liveness probe. Do not call a model." });
    const changes = events().slice(before), newChanges = events().slice(beforeNew);
    const pass = reload.runtime.pid === started.state.runtime.pid && !reload.runtime.lastStop && reload.runtime.osBirthToken === started.state.runtime.osBirthToken
      && newChanges.some(e => e.carrier?.nextActionHint === "ask_human") && ensureAfterNew.kind === "attention"
      && afterNew.processInfo.foreground_processes.some(p => p.pid === started.state.runtime.pid);
    note(5, { reload: "same process generation becomes live; normal reload transitions stay quiet", new: "Session binding becomes unusable; process stays live; ask_human; no relaunch" }, pass ? "holds" : "refuted", { started, reload, reloadStatus, afterNew, newStatus, ensureAfterNew, lifecycle: lifecycle().slice(lifecycleBefore), carrierEvents: changes });
  }
  // Item 9: only the isolated leader's Herdr list subprocesses lose transport.
  if (selected.has(9)) {
    const started = await start("outage-worker"), before = events().length, launchesBefore = readLines(box.path("cli.jsonl")).filter(c => c.args[0] === "agent" && c.args[1] === "start").length;
    fs.writeFileSync(box.path("outage"), "scoped list outage\n");
    await delay(11000);
    const during = await status();
    const outageEvents = events().slice(before);
    fs.unlinkSync(box.path("outage"));
    await delay(6500);
    const recovered = await status(), after = await inspect("outage-worker");
    const launchesAfter = readLines(box.path("cli.jsonl")).filter(c => c.args[0] === "agent" && c.args[1] === "start").length;
    const alerts = outageEvents.filter(e => e.type === "alert" && e.kind === "attention" && e.text?.includes("Herdr observation unavailable"));
    const duringLine = during.data.lines.find(line => line.startsWith("outage-worker:"));
    const recoveredLine = recovered.data.lines.find(line => line.startsWith("outage-worker:"));
    note(9, { carrier: "one Team attention during outage, process verifier continues, terminal/activity unknown, recovery restores terminal evidence", launch: "no relaunch", mechanism: "PATH shim fails only isolated agent list and pane list calls; shared server stays running" }, alerts.length === 1 && launchesBefore === launchesAfter && after.runtime.pid === started.state.runtime.pid && duringLine?.includes("process live") && duringLine.includes("terminal unknown") && recoveredLine?.includes("terminal present") ? "holds" : "refuted", { started, duringStatus: during, recoveredStatus: recovered, after, outageEvents, recoveryEvents: events().slice(before + outageEvents.length), attentionCount: alerts.length, launchesBefore, launchesAfter });
  }
  // Item 3: a canonical Pi command exits before starting Pi. Bound readiness to 4s.
  if (selected.has(3)) {
    const before = events().length;
    fs.writeFileSync(box.path("fail-pi"), "fail canonical Pi executable\n");
    const startAt = Date.now();
    const receipt = await tool("ensure_worker", { name: "never-worker", scope: "Idle carrier for an isolated liveness probe. Do not call a model." });
    const receiptElapsedMs = Date.now() - startAt;
    await wait(() => readLines(box.path("pi-failures.jsonl")).length, "Pi executable failure");
    await wait(() => ["refused", "unknown"].includes(member("never-worker")?.launch?.state), "launch outcome");
    await delay(16000);
    const afterFailure = await inspect("never-worker"), failureStatus = await status();
    fs.unlinkSync(box.path("fail-pi"));
    const retry = await tool("ensure_worker", { name: "never-worker", scope: "Idle carrier for an isolated liveness probe. Do not call a model." });
    if (retry.kind !== "attention") await delay(5000);
    const afterRetry = await inspect("never-worker"), retryStatus = await status();
    const pass = afterFailure.member.launch.state === "refused" && !!afterRetry.runtime?.osBirthToken && afterFailure.pane.pane_id === afterRetry.pane.pane_id;
    note(3, { carrier: "prompt requested receipt, then refused; shell pane retained", retry: "successful ensure_worker retry", bound: "real Herdr start readiness timeout shortened from 300000 to 4000ms only for failed executable" }, pass ? "holds" : "refuted", { receipt, receiptElapsedMs, afterFailure, failureStatus, retry, afterRetry, retryStatus, failures: readLines(box.path("pi-failures.jsonl")), startCalls: readLines(box.path("cli.jsonl")).filter(c => c.args[0] === "agent" && c.args[1] === "start" && c.args[2].endsWith("-never-worker")), carrierEvents: events().slice(before) });
  }
} catch (error) {
  console.error(error);
  console.error(`Private diagnostics retained at ${box.root}`);
  fs.writeFileSync(box.path("error.txt"), String(error));
  if (pi) fs.writeFileSync(box.path("rpc.json"), JSON.stringify({ stderr: pi.stderr, records: pi.records }, null, 2));
  process.exitCode = 1;
} finally {
  if (fs.existsSync(box.path("outage"))) fs.unlinkSync(box.path("outage"));
  if (fs.existsSync(box.path("fail-pi"))) fs.unlinkSync(box.path("fail-pi"));
  await pi?.close();
  const closed = [];
  for (const pane of owned().reverse()) {
    try { await control("close", pane); closed.push(pane); } catch (e) { console.error(`Cleanup failed for owned pane ${pane}: ${e.message}`); process.exitCode = 1; }
  }
  if (workspace) try { await herdr("workspace", "close", workspace); } catch { /* Check absence below. */ }
  let workspaceGone = false;
  if (workspace) {
    try { await herdr("workspace", "get", workspace); }
    catch (error) { workspaceGone = String(error.stderr).includes("not_found"); }
    if (!workspaceGone) { console.error("Owned workspace cleanup is unverified"); process.exitCode = 1; }
  }
  await provider?.close();
  const aliases = new Map();
  const replaceId = (s, kind) => { if (!aliases.has(s)) aliases.set(s, `<${kind}_${aliases.size + 1}>`); return aliases.get(s); };
  function redact(value, key = "") {
    if (Array.isArray(value)) return value.map(v => redact(v, key));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
    if (typeof value === "number" && /^(pid|shell_pid|foreground_process_group_id)$/.test(key)) return replaceId(String(value), "PID");
    if (typeof value !== "string") return value;
    let text = value;
    const replacements = [[fs.realpathSync(box.path("home")), "<ISOLATED_HOME>"], [box.path("home"), "<ISOLATED_HOME>"], [fs.realpathSync(box.root), "<SANDBOX>"], [box.root, "<SANDBOX>"], [fs.realpathSync(PACKAGE), "<REPO>"], [PACKAGE, "<REPO>"], [os.homedir(), "<HOME>"], [os.hostname(), "<HOST>"], [os.userInfo().username, "<USER>"]];
    for (const [a, b] of replacements) text = text.replaceAll(a, b);
    text = text.replace(/w[A-Za-z0-9]+(?::[pt][A-Za-z0-9]+)?/g, match => /^(w[A-Z0-9]+)(:[pt][A-Z0-9]+)?$/.test(match) ? replaceId(match, "HERDR") : match);
    text = text.replace(/term_[a-f0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, match => replaceId(match, "ID"));
    if (/^(membershipId|membership|launchId|pendingLaunchId|osBirthToken|bootId|agentId|sessionId|id|parentId|nonce|token)$/.test(key)) text = replaceId(text, "ID");
    return text;
  }
  for (const [item, result] of results) {
    result.observed.cleanup = { ownedPaneIds: owned(), closedPaneIds: closed, workspaceId: workspace, workspaceGone, sharedServerStopped: false };
    fs.writeFileSync(path.join(PACKAGE, `sim/fixtures/probes/real-herdr-${item}.json`), JSON.stringify(redact(result), null, 2) + "\n");
  }
  if (!process.exitCode) box.cleanup();
}
