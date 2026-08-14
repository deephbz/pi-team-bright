#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const SCHEMA = "pi-team-bright-pi-compile-cache-paired-results/1";
const BOOTSTRAP_RESAMPLES = 10_000;
const DEFAULT_PAIRS = 15;
const DEFAULT_TIMEOUT_MS = 45_000;
const REQUIRED_CONFIRMATION = "--confirm-team-shutdown";

function fail(message) { throw new Error(message); }
function rounded(value) { return Math.round(value * 1000) / 1000; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function sha256File(file) { return sha256(fs.readFileSync(file)); }
function exists(file) { return fs.existsSync(file); }
function remove(file) { fs.rmSync(file, { recursive: true, force: true }); }
function mkdir(file, mode = 0o700) { fs.mkdirSync(file, { recursive: true, mode }); fs.chmodSync(file, mode); }

function parseArgs(argv) {
  const flags = new Set();
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--self-test" || key === "--smoke" || key === REQUIRED_CONFIRMATION) { flags.add(key); continue; }
    if (!key.startsWith("--")) fail(`Unknown argument: ${key}`);
    const value = argv[++i];
    if (!value || value.startsWith("--") || values.has(key)) fail(`Expected one value for ${key}.`);
    values.set(key, value);
  }
  if (flags.has("--self-test") || flags.has("--smoke")) {
    if (values.size > 0 || flags.size > 1) fail("--self-test and --smoke accept no other options.");
    return { selfTest: flags.has("--self-test"), smoke: flags.has("--smoke") };
  }
  for (const key of ["--raw-dir", "--artifact"]) if (!values.has(key)) fail(`Missing ${key}.`);
  const integer = (key, fallback, min, max) => {
    const raw = values.get(key) ?? String(fallback);
    if (!/^\d+$/.test(raw)) fail(`${key} must be an integer.`);
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail(`${key} must be ${min} through ${max}.`);
    return parsed;
  };
  const rawDir = path.resolve(values.get("--raw-dir"));
  const artifact = values.get("--artifact");
  if (!path.isAbsolute(rawDir)) fail("--raw-dir must be absolute.");
  if (path.isAbsolute(artifact) || artifact.split(path.sep).includes("..")) fail("--artifact must be repository-relative.");
  return {
    selfTest: false,
    confirmed: flags.has(REQUIRED_CONFIRMATION),
    rawDir,
    artifact,
    pairs: integer("--pairs", DEFAULT_PAIRS, 15, 100),
    seed: integer("--seed", 20260814, 1, 0x7fffffff),
    timeoutMs: integer("--timeout-ms", DEFAULT_TIMEOUT_MS, 1_000, 120_000),
  };
}

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
function shuffled(values, random) {
  const output = [...values];
  for (let i = output.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [output[i], output[j]] = [output[j], output[i]];
  }
  return output;
}
function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1))];
}
function summary(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length === 0 ? { n: 0, min_ms: null, p50_ms: null, p95_ms: null, max_ms: null } : {
    n: sorted.length, min_ms: rounded(sorted[0]), p50_ms: rounded(percentile(sorted, 0.5)),
    p95_ms: rounded(percentile(sorted, 0.95)), max_ms: rounded(sorted.at(-1)),
  };
}
function bootstrapPaired(differences, seed) {
  if (differences.length < 2) fail("Need at least two paired differences.");
  const random = createRandom(seed);
  const resamples = [];
  for (let draw = 0; draw < BOOTSTRAP_RESAMPLES; draw += 1) {
    let total = 0;
    for (let i = 0; i < differences.length; i += 1) total += differences[Math.floor(random() * differences.length)];
    resamples.push(total / differences.length);
  }
  resamples.sort((a, b) => a - b);
  return {
    statistic: "mean paired enabled-minus-disabled session_admitted_ms",
    resamples: BOOTSTRAP_RESAMPLES,
    point_estimate_ms: rounded(differences.reduce((sum, value) => sum + value, 0) / differences.length),
    confidence_interval_95_ms: [rounded(percentile(resamples, 0.025)), rounded(percentile(resamples, 0.975))],
    signs: { negative: differences.filter((value) => value < 0).length, zero: differences.filter((value) => value === 0).length, positive: differences.filter((value) => value > 0).length },
  };
}
function directorySize(root) {
  if (!exists(root)) return { files: 0, bytes: 0 };
  let files = 0; let bytes = 0;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(item);
      else if (entry.isFile()) { files += 1; bytes += fs.statSync(item).size; }
    }
  };
  visit(root);
  return { files, bytes };
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function sourceFence(repository) {
  const cli = path.join(repository, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  const extension = path.join(repository, "extensions/index.ts");
  if (!exists(cli) || !exists(extension)) fail("Package-local Pi CLI or exact extension is missing.");
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" });
  if (revision.status !== 0) fail("Cannot resolve Git source revision.");
  return {
    revision: revision.stdout.trim(),
    worktree_dirty: spawnSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" }).stdout.trim() !== "",
    node_version: process.version.replace(/^v/, ""),
    node_compile_cache_api: typeof (awaitableCompileCacheApi()) === "function",
    pi_cli_sha256: sha256File(cli), exact_extension_sha256: sha256File(extension),
    cli, extension,
  };
}
function awaitableCompileCacheApi() { return requireModule()?.enableCompileCache; }
function requireModule() { return process.getBuiltinModule ? process.getBuiltinModule("node:module") : null; }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.chmodSync(file, 0o600); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function cacheManifest(cacheDirectory) { return path.join(cacheDirectory, "ptb-compile-cache-fence.json"); }
function prepareCache(cacheDirectory, fence) {
  const manifest = cacheManifest(cacheDirectory);
  let invalidated = false;
  if (exists(manifest)) {
    const prior = readJson(manifest);
    if (prior.node_version !== fence.node_version || prior.pi_cli_sha256 !== fence.pi_cli_sha256 || prior.exact_extension_sha256 !== fence.exact_extension_sha256) {
      remove(cacheDirectory); invalidated = true;
    }
  }
  mkdir(cacheDirectory);
  writeJson(manifest, { node_version: fence.node_version, pi_cli_sha256: fence.pi_cli_sha256, exact_extension_sha256: fence.exact_extension_sha256 });
  return { invalidated, before: directorySize(cacheDirectory) };
}
function cleanEnvironment(root, cacheDirectory) {
  const environment = { PATH: process.env.PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC", PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" };
  for (const [name, child] of Object.entries({ HOME: "home", PI_CODING_AGENT_DIR: "agent", PI_CODING_AGENT_SESSION_DIR: "sessions", TMPDIR: "tmp" })) {
    const value = path.join(root, child); mkdir(value); environment[name] = value;
  }
  mkdir(path.join(root, "work"));
  if (cacheDirectory) environment.NODE_COMPILE_CACHE = cacheDirectory;
  return environment;
}
async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return Promise.race([once(child, "exit").then(([code, signal]) => ({ code, signal })), new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: "timeout" }), timeoutMs))]);
}
async function runStartup({ repository, root, cacheDirectory, timeoutMs, label, cliOverride }) {
  const fence = sourceFence(repository);
  const sessionId = randomUUID();
  const sessionDirectory = path.join(root, "sessions");
  const stdout = path.join(root, "stdout.jsonl"); const stderr = path.join(root, "stderr.log");
  const args = [cliOverride ?? fence.cli, "--mode", "rpc", "--offline", "--no-extensions", "-e", fence.extension, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-builtin-tools", "--no-approve", "--session-dir", sessionDirectory, "--session-id", sessionId, "--name", "compile-cache-probe"];
  const started = performance.now();
  const child = spawn(process.execPath, args, { cwd: path.join(root, "work"), env: cleanEnvironment(root, cacheDirectory), detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = ""; let response; let responseAt; let spawnError; let childExit;
  const captured = [];
  child.once("error", (error) => { spawnError = error.code ?? error.name; });
  child.once("exit", (code, signal) => { childExit = { code, signal }; });
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8"); fs.appendFileSync(stdout, text, { mode: 0o600 }); buffer += text;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n"); const line = buffer.slice(0, index).replace(/\r$/, ""); buffer = buffer.slice(index + 1);
      try { const message = JSON.parse(line); captured.push(message); if (message.type === "response" && message.id === "probe-state" && message.success) { response = message.data; responseAt ??= performance.now(); } } catch { /* captured failure is classified below */ }
    }
  });
  child.stderr.on("data", (chunk) => fs.appendFileSync(stderr, chunk, { mode: 0o600 }));
  await once(child, "spawn").catch(() => undefined);
  if (!spawnError) child.stdin.write(`${JSON.stringify({ id: "probe-state", type: "get_state" })}\n`);
  const deadline = performance.now() + timeoutMs;
  while (!response && !spawnError && !childExit && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  if (child.stdin.writable) child.stdin.end();
  let exit = await waitForExit(child, 2_000);
  if (exit.signal === "timeout") { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } exit = await waitForExit(child, 2_000); }
  if (exit.signal === "timeout") { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
  // Pi deliberately removes an empty Session file at shutdown. Therefore this
  // boundary proves exact Session projection from the live RPC authority, not
  // persistence that requires an agent turn or provider credential.
  const sessionFile = typeof response?.sessionFile === "string" ? response.sessionFile : undefined;
  const sessionExact = response?.sessionId === sessionId && !!sessionFile && inside(sessionDirectory, sessionFile);
  const processReady = responseAt ? rounded(responseAt - started) : null;
  const result = { label, outcome: response && sessionExact ? "admitted" : spawnError ? "spawn_failed" : "startup_failed", process_ready_ms: processReady, session_admitted_ms: sessionExact ? processReady : null, exit, cache: cacheDirectory ? directorySize(cacheDirectory) : { files: 0, bytes: 0 }, private: { session_id: sessionId, session_file: sessionFile ?? null, root, stdout, stderr, rpc_events: captured.length } };
  if (result.outcome !== "admitted") result.private.failure = { spawn_error: spawnError ?? null, child_exit: childExit ?? null, response_seen: !!response, exact_session: sessionExact };
  return result;
}
function redactedSample(sample) { return { label: sample.label, outcome: sample.outcome, process_ready_ms: sample.process_ready_ms, session_admitted_ms: sample.session_admitted_ms, cache: sample.cache }; }
function cleanup(root) { remove(root); return !exists(root); }

async function runMeasurement(options) {
  if (!options.confirmed) fail(`Refusing measurement without ${REQUIRED_CONFIRMATION}. Run after Team shutdown.`);
  const repository = process.cwd(); const raw = options.rawDir;
  if (exists(raw)) fail("--raw-dir must not already exist.");
  if (inside(repository, raw)) fail("--raw-dir must be outside the repository.");
  const fence = sourceFence(repository);
  if (!fence.node_compile_cache_api) fail("This Node runtime does not expose node:module enableCompileCache.");
  mkdir(raw);
  const random = createRandom(options.seed);
  const pairs = shuffled(Array.from({ length: options.pairs * 2 }, (_, index) => ({ phase: index < options.pairs ? "cold" : "warm", pair_index: index % options.pairs })), random);
  const rawPairs = [];
  try {
    for (const pair of pairs) {
      const pairRoot = path.join(raw, `${pair.phase}-${String(pair.pair_index).padStart(2, "0")}`); mkdir(pairRoot);
      const enabledFirst = random() < 0.5;
      const order = enabledFirst ? [true, false] : [false, true];
      const outcomes = [];
      for (const enabled of order) {
        const sampleRoot = path.join(pairRoot, enabled ? "enabled" : "disabled"); mkdir(sampleRoot);
        const cache = enabled ? path.join(sampleRoot, "cache") : undefined;
        let cacheEvidence = enabled ? prepareCache(cache, fence) : { invalidated: false, before: { files: 0, bytes: 0 } };
        if (enabled && pair.phase === "warm") {
          const primeRoot = path.join(sampleRoot, "prime"); mkdir(primeRoot);
          const prime = await runStartup({ repository, root: primeRoot, cacheDirectory: cache, timeoutMs: options.timeoutMs, label: "warm-prime" });
          if (prime.outcome !== "admitted") fail(`Warm cache prime failed for pair ${pair.phase}/${pair.pair_index}.`);
          cacheEvidence = { ...cacheEvidence, after_prime: directorySize(cache) };
          if (!cleanup(primeRoot)) fail("Cannot clean warm-prime directory.");
        }
        const sample = await runStartup({ repository, root: sampleRoot, cacheDirectory: cache, timeoutMs: options.timeoutMs, label: `${pair.phase}-${enabled ? "enabled" : "disabled"}` });
        cacheEvidence.after_measurement = directorySize(cache ?? path.join(sampleRoot, "missing-cache"));
        if (sample.outcome !== "admitted") fail(`Startup failed for ${sample.label}.`);
        const privateSample = { enabled, ...sample, cache_evidence: cacheEvidence };
        const cleaned = cleanup(sampleRoot);
        privateSample.cache_evidence.after_cleanup = directorySize(cache ?? path.join(sampleRoot, "missing-cache"));
        privateSample.cleanup = { sample_root_removed: cleaned, cache_root_removed: !cache || !exists(cache) };
        if (!cleaned || (cache && exists(cache))) fail("Sample cleanup failed.");
        outcomes.push(privateSample);
      }
      rawPairs.push({ ...pair, order: order.map((enabled) => enabled ? "enabled" : "disabled"), outcomes });
      remove(pairRoot);
    }
    const byPhase = Object.fromEntries(["cold", "warm"].map((phase) => {
      const phasePairs = rawPairs.filter((pair) => pair.phase === phase);
      const enabled = phasePairs.map((pair) => pair.outcomes.find((sample) => sample.enabled));
      const disabled = phasePairs.map((pair) => pair.outcomes.find((sample) => !sample.enabled));
      const differences = enabled.map((sample, index) => sample.session_admitted_ms - disabled[index].session_admitted_ms);
      return [phase, { pairs: phasePairs.length, enabled: summary(enabled.map((sample) => sample.session_admitted_ms)), disabled: summary(disabled.map((sample) => sample.session_admitted_ms)), paired: bootstrapPaired(differences, options.seed + (phase === "cold" ? 1 : 2)) }];
    }));
    writeJson(path.join(raw, "private-raw.json"), { schema: `${SCHEMA}-raw/1`, source: fence, seed: options.seed, pairs: rawPairs });
    const artifact = {
      schema: SCHEMA, recorded_at: new Date().toISOString(), source: { revision: fence.revision, worktree_dirty: fence.worktree_dirty, node_version: fence.node_version, node_compile_cache_api: fence.node_compile_cache_api, pi_cli_sha256: fence.pi_cli_sha256, exact_extension_sha256: fence.exact_extension_sha256 },
      design: { pairs_per_phase: options.pairs, seed: options.seed, interleaving: "seed-shuffled pair order; each pair has one enabled and one disabled launch in independently shuffled order", cold: "unique empty enabled cache per measured launch", warm: "one unmeasured exact enabled launch primes each unique cache", boundary: "process start through exact RPC Session admission", bootstrap_resamples: BOOTSTRAP_RESAMPLES },
      summaries: byPhase, raw_samples: rawPairs.map((pair) => ({ phase: pair.phase, pair_index: pair.pair_index, order: pair.order, outcomes: pair.outcomes.map((sample) => ({ enabled: sample.enabled, ...redactedSample(sample), cache_evidence: sample.cache_evidence, cleanup: sample.cleanup })) })),
      cleanup: { child_roots_removed: true, cache_roots_removed: true, private_raw_bundle: "retained outside repository by explicit operator choice" },
      limits: ["Run only after Team shutdown; this artifact cannot remove machine-load confounding.", "No provider request, agent turn, Team creation, Worker launch, or Worker admission is measured.", "Bootstrap intervals describe this sampled machine state and do not prove production causality."]
    };
    const destination = path.resolve(repository, options.artifact); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ artifact: options.artifact, complete: true, source_revision: fence.revision }));
  } catch (error) {
    writeJson(path.join(raw, "private-failure.json"), { error: error instanceof Error ? error.message : String(error), source: fence, pairs: rawPairs });
    throw error;
  }
}

async function smoke() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ptb-compile-cache-smoke-"));
  try {
    const repository = process.cwd();
    const cache = path.join(root, "cache");
    prepareCache(cache, sourceFence(repository));
    const sample = await runStartup({ repository, root: path.join(root, "sample"), cacheDirectory: cache, timeoutMs: DEFAULT_TIMEOUT_MS, label: "unmeasured-smoke" });
    if (sample.outcome !== "admitted") fail(`Exact-extension smoke failed: ${sample.outcome}.`);
    if (!cleanup(path.join(root, "sample"))) fail("Exact-extension smoke cleanup failed.");
    console.log(JSON.stringify({ smoke: "passed", boundary: "exact RPC Session admission", cache_after: directorySize(cache) }));
  } finally { remove(root); }
}

async function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ptb-compile-cache-self-test-"));
  try {
    const fence = { node_version: "test", pi_cli_sha256: "new-cli", exact_extension_sha256: "new-extension" };
    const cache = path.join(root, "cache"); mkdir(cache); writeJson(cacheManifest(cache), { node_version: "old", pi_cli_sha256: "old", exact_extension_sha256: "old" }); fs.writeFileSync(path.join(cache, "stale"), "old");
    const stale = prepareCache(cache, fence);
    if (!stale.invalidated || exists(path.join(cache, "stale"))) fail("Stale-cache invalidation self-test failed.");
    const order = shuffled([true, false], createRandom(7)); if (order.length !== 2 || order[0] === order[1]) fail("Pair interleaving self-test failed.");
    const interval = bootstrapPaired([-4, -2, 1, 3], 7); if (interval.resamples !== BOOTSTRAP_RESAMPLES || interval.confidence_interval_95_ms.length !== 2) fail("Bootstrap self-test failed.");
    const redacted = redactedSample({ label: "x", outcome: "admitted", process_ready_ms: 1, session_admitted_ms: 2, cache: { files: 3, bytes: 4 }, private: { session_id: "secret", root: "/private" } });
    if (JSON.stringify(redacted).includes("secret") || JSON.stringify(redacted).includes("/private")) fail("Redaction self-test failed.");
    const failure = await runStartup({ repository: process.cwd(), root: path.join(root, "failed"), cacheDirectory: undefined, timeoutMs: 1_000, label: "missing-cli", cliOverride: path.join(root, "missing-cli.js") });
    if (failure.outcome === "admitted" || !cleanup(path.join(root, "failed"))) fail("Failed-start cleanup self-test failed.");
    console.log(JSON.stringify({ self_test: "passed", stale_cache_invalidation: true, failed_start_classified: failure.outcome, cleanup: true }));
  } finally { remove(root); }
}

const options = parseArgs(process.argv.slice(2));
if (options.selfTest) selfTest().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
else if (options.smoke) smoke().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
else runMeasurement(options).catch((error) => { process.stderr.write(`Pi compile-cache probe failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
