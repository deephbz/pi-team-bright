#!/usr/bin/env node
/**
 * Disposable fresh-process Pi bootstrap benchmark. It never creates a Team.
 * Run: node benchmarks/worker-bootstrap-discovery/run.mjs --samples 10
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const root = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const piCli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const exactExtension = join(root, "extensions/index.ts");
const darkTheme = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json");
const schema = "pi-team-bright-worker-bootstrap-discovery/1";
const argv = process.argv.slice(2);
const value = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const samples = Number(value("samples", "10"));
const artifact = resolve(value("artifact", join(root, "docs/journal/artifacts/2026-08-14-worker-bootstrap-discovery.json")));
if (!Number.isInteger(samples) || samples < 1 || samples > 100) throw new Error("--samples must be an integer from 1 through 100");
if (!existsSync(piCli) || !existsSync(exactExtension)) throw new Error("The exact source or package-local Pi CLI is unavailable.");

const keepEnv = ["PATH", "TMPDIR", "LANG", "LC_ALL", "TZ", "TERM", "COLORTERM"];
const cleanEnv = (fixture) => Object.fromEntries(keepEnv.filter((key) => process.env[key]).map((key) => [key, process.env[key]]).concat([
  ["HOME", fixture.home], ["PI_CODING_AGENT_DIR", fixture.agent], ["PI_CODING_AGENT_SESSION_DIR", fixture.sessions],
  ["PI_OFFLINE", "1"], ["PI_SKIP_VERSION_CHECK", "1"], ["BOOTSTRAP_PROBE_RECORD", fixture.record],
]));
const round = (n) => Math.round(n * 1000) / 1000;
const summary = (records, field = "spawn_to_rpc_ready_ms") => {
  const values = records.filter((r) => r.outcome === "ok" && Number.isFinite(r[field])).map((r) => r[field]).sort((a, b) => a - b);
  const rank = (fraction) => values.length ? values[Math.ceil(fraction * values.length) - 1] : null;
  return { requested_samples: records.length, successes: values.length, failures: records.length - values.length, min_ms: values.length ? round(values[0]) : null, p50_ms: rank(.5) === null ? null : round(rank(.5)), p95_ms: rank(.95) === null ? null : round(rank(.95)), max_ms: values.length ? round(values.at(-1)) : null, percentile_method: "nearest-rank successful samples only" };
};
function write(path, text) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, text, { mode: 0o600 }); }
function caseSummary(records) { return { rpc_ready: summary(records), process_uptime_phase_ends: { probe_module_evaluated: summary(records.map((record) => ({ outcome: record.outcome, phase_ms: record.probe_uptime_ms.probe_module_evaluated })), "phase_ms"), probe_factory: summary(records.map((record) => ({ outcome: record.outcome, phase_ms: record.probe_uptime_ms.probe_factory })), "phase_ms"), session_start: summary(records.map((record) => ({ outcome: record.outcome, phase_ms: record.probe_uptime_ms.session_start })), "phase_ms"), resources_discover: summary(records.map((record) => ({ outcome: record.outcome, phase_ms: record.probe_uptime_ms.resources_discover })), "phase_ms") } }; }
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "ptb-bootstrap-"));
  const value = { base, home: join(base, "home"), agent: join(base, "agent"), sessions: join(base, "sessions"), cwd: join(base, "project"), record: join(base, "records.jsonl") };
  for (const path of Object.values(value).filter((item) => item !== base && item !== value.record)) mkdirSync(path, { recursive: true, mode: 0o700 });
  write(join(value.agent, "extensions", "unrelated-fixture.ts"), `import { appendFileSync } from "node:fs"; import { Type } from "typebox";\nexport default function(pi) { appendFileSync(process.env.BOOTSTRAP_PROBE_RECORD, JSON.stringify({ event: "unrelated_extension_factory" }) + "\\n"); pi.registerTool({ name: "unrelated_fixture_tool", label: "Unrelated fixture", description: "Fixture tool", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "fixture" }] }; } }); pi.on("resources_discover", () => ({ skillPaths: [] })); }\n`);
  write(join(value.agent, "skills", "unrelated-fixture", "SKILL.md"), "---\nname: unrelated-fixture\ndescription: Fixture skill retained by bootstrap benchmark.\n---\n# Fixture\n");
  write(join(value.agent, "prompts", "fixture.md"), "---\ndescription: Fixture prompt\n---\nFixture prompt\n");
  mkdirSync(join(value.agent, "themes"), { recursive: true, mode: 0o700 }); copyFileSync(darkTheme, join(value.agent, "themes", "fixture-dark.json"));
  write(join(value.cwd, "AGENTS.md"), "BOOTSTRAP_CONTEXT_FIXTURE=present\n");
  write(join(value.cwd, ".agents", "skills", "project-fixture", "SKILL.md"), "---\nname: project-fixture\ndescription: Project fixture skill.\n---\n# Fixture\n");
  write(join(value.base, "probe.ts"), `import { appendFileSync } from "node:fs"; import { performance } from "node:perf_hooks"; const out = process.env.BOOTSTRAP_PROBE_RECORD; const log = (event, extra = {}) => appendFileSync(out, JSON.stringify({ event, process_uptime_ms: Math.round(performance.now() * 1000) / 1000, ...extra }) + "\\n"); log("probe_module_evaluated"); export default function(pi) { log("probe_factory"); pi.on("session_start", (_event, ctx) => { const prompt = ctx.getSystemPrompt(); log("session_start", { context_fixture_in_prompt: prompt.includes("BOOTSTRAP_CONTEXT_FIXTURE=present"), skill_fixture_in_prompt: prompt.includes("unrelated-fixture") || prompt.includes("project-fixture"), unrelated_tool_active: pi.getActiveTools().includes("unrelated_fixture_tool"), exact_team_environment_present: Boolean(process.env.PI_TEAM_NAME || process.env.PI_TEAM_MEMBERSHIP_ID) }); }); pi.on("resources_discover", () => { log("resources_discover"); }); }`);
  return value;
}
function readLines(file) { if (!existsSync(file)) return []; return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); }
function argsFor(name, probe, bundle) {
  const base = [piCli, "--mode", "rpc", "--offline", "--approve", "--no-session", "-e", name === "bundled_exact_extension" ? bundle : exactExtension, "-e", probe];
  const disabled = { no_extensions: ["--no-extensions"], no_skills: ["--no-skills"], no_prompt_templates: ["--no-prompt-templates"], no_themes: ["--no-themes"], no_context_files: ["--no-context-files"], all_discovery_disabled: ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"] };
  return [...base, ...(disabled[name] ?? [])];
}
function runOne(name, ordinal, bundle) {
  const f = fixture(); const started = performance.now(); let stdout = ""; let stderr = ""; let response; let exited = false;
  const child = spawn(process.execPath, argsFor(name, join(f.base, "probe.ts"), bundle), { cwd: f.cwd, env: cleanEnv(f), stdio: ["pipe", "pipe", "pipe"] });
  const childExit = new Promise((resolvePromise) => child.once("exit", (code, signal) => resolvePromise({ code, signal, at_ms: round(performance.now() - started) })));
  const done = new Promise((resolvePromise) => {
    const finish = (outcome, extra = {}) => { if (exited) return; exited = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 500).unref(); resolvePromise({ outcome, ...extra }); };
    const timer = setTimeout(() => finish("rpc_timeout"), 20000);
    child.stdout.on("data", (chunk) => { stdout += chunk; for (const line of stdout.split("\n")) { try { const record = JSON.parse(line); if (record.type === "response" && record.id === "ready") { clearTimeout(timer); finish(record.success === true ? "ok" : "rpc_failure", { rpc_success: record.success === true, rpc_response_at_ms: round(performance.now() - started) }); } } catch {} } });
    child.stderr.on("data", (chunk) => { stderr += chunk; }); child.on("error", () => { clearTimeout(timer); finish("spawn_failure"); }); child.on("exit", (code) => { if (!exited) { clearTimeout(timer); exited = true; resolvePromise({ outcome: "child_exit", exit_code: code }); } });
    child.stdin.write('{"type":"get_state","id":"ready"}\n');
  });
  return done.then(async (result) => { const exit = await childExit; const events = readLines(f.record); const event = (id) => events.find((item) => item.event === id); const start = event("session_start"); const record = { case: name, ordinal, outcome: result.outcome, spawn_to_rpc_ready_ms: result.outcome === "ok" ? result.rpc_response_at_ms : null, phases_observed: { pi_import_and_exact_extension_load: Boolean(event("probe_factory")), session_start: Boolean(start), resources_discover: Boolean(event("resources_discover")), exact_binding: "not_attempted_no_durable_membership", interactive_ready: "not_observable_rpc_mode", first_no_model_task_delivery: "not_attempted_no_durable_membership" }, resource_semantics: { context_fixture_in_prompt: start?.context_fixture_in_prompt === true, skill_fixture_in_prompt: start?.skill_fixture_in_prompt === true, prompt_template_fixture: "unmeasured", theme_fixture: "unmeasured", unrelated_extension_loaded: Boolean(event("unrelated_extension_factory")), unrelated_tool_active: start?.unrelated_tool_active === true, exact_team_environment_present: start?.exact_team_environment_present === true }, probe_uptime_ms: Object.fromEntries(events.map((item) => [item.event, item.process_uptime_ms])), cleanup: { child_exited: true, shutdown_after_rpc_ms: result.outcome === "ok" ? round(exit.at_ms - result.rpc_response_at_ms) : null, exit_code: exit.code, exit_signal: exit.signal, fixture_removed: false } }; rmSync(f.base, { recursive: true, force: true }); record.cleanup.fixture_removed = !existsSync(f.base); return record; });
}
function bundleExact() { const output = join(mkdtempSync(join(tmpdir(), "ptb-bootstrap-bundle-")), "pi-team-bright.mjs"); const result = spawnSync("bun", ["build", exactExtension, "--bundle", "--format=esm", "--target=node", "--external=@earendil-works/pi-coding-agent", "--external=@earendil-works/pi-ai", "--external=@earendil-works/pi-tui", "--external=typebox", `--outfile=${output}`], { cwd: root, encoding: "utf8", timeout: 60000 }); if (result.status !== 0 || !existsSync(output)) throw new Error("Could not build bundled exact extension."); return output; }
async function duplicateCheck() { const f = fixture(); const duplicate = join(f.agent, "extensions", "pi-team-bright-duplicate.ts"); write(duplicate, `export { default } from ${JSON.stringify(exactExtension)};`); const result = await new Promise((resolvePromise) => { let stderr = ""; const child = spawn(process.execPath, [piCli, "--mode", "rpc", "--offline", "--approve", "--no-session", "-e", exactExtension], { cwd: f.cwd, env: cleanEnv(f), stdio: ["pipe", "pipe", "pipe"] }); const timer = setTimeout(() => { child.kill("SIGKILL"); resolvePromise({ outcome: "timeout" }); }, 15000); child.stderr.on("data", (data) => { stderr += data; }); child.on("exit", (code) => { clearTimeout(timer); resolvePromise({ outcome: code === 0 ? "unexpected_success" : "failed", exit_code: code, duplicate_registration_detected: /already registered|duplicate|already exists/i.test(stderr) }); }); }); rmSync(f.base, { recursive: true, force: true }); return result; }
const names = ["current_exact_discovery", "no_extensions", "no_skills", "no_prompt_templates", "no_themes", "no_context_files", "all_discovery_disabled", "bundled_exact_extension"];
const bundle = bundleExact(); const records = [];
try { for (let ordinal = 1; ordinal <= samples; ordinal += 1) { const ordered = names.map((_, index) => names[(index + ordinal - 1) % names.length]); for (const name of ordered) records.push(await runOne(name, ordinal, bundle)); } const current = records.filter((record) => record.case === "current_exact_discovery"); if (!current.every((record) => record.outcome === "ok" && record.resource_semantics.skill_fixture_in_prompt && record.resource_semantics.unrelated_extension_loaded && record.resource_semantics.unrelated_tool_active)) throw new Error("Current exact-discovery case did not retain the unrelated configured extension and Skill."); const duplicate = await duplicateCheck(); const result = { schema, status: "complete", source: { integrated_startup_commit: "bcf57707b9bc546e5e754681db7d29e6bd094fea", harness_commit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(), node: process.version, pi: JSON.parse(readFileSync(join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version }, parameters: { samples_per_case: samples, order: "round-robin by ordinal", mode: "fresh child process Pi RPC; offline" }, cases: Object.fromEntries(names.map((name) => [name, caseSummary(records.filter((record) => record.case === name))])), raw_samples: records, resource_policy: { unrelated_extension_retention: "The fixture extension factory and its active custom tool are observed inside Pi after session_start.", current_exact_skill_retained: current.every((record) => record.resource_semantics.skill_fixture_in_prompt), current_exact_unrelated_tool_retained: current.every((record) => record.resource_semantics.unrelated_tool_active), duplicate_exact_extension: duplicate }, limits: { exact_binding: "not attempted: this harness creates no durable Team Membership", interactive_ready: "not observable in RPC mode", first_no_model_task_delivery: "not attempted: delivery requires exact Worker binding" } }; mkdirSync(dirname(artifact), { recursive: true }); writeFileSync(artifact, `${JSON.stringify(result, null, 2)}\n`); console.log(JSON.stringify({ artifact, status: result.status, cases: result.cases, duplicate }, null, 2)); } finally { rmSync(dirname(bundle), { recursive: true, force: true }); }
