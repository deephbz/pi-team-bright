import { performance } from "node:perf_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const teamEnvironmentNames = [
  "PI_TEAM_NAME",
  "PI_AGENT_NAME",
  "PI_TEAM_MEMBERSHIP_ID",
  "PI_AGENT_LAUNCH_ID",
  "PI_TEAM_BRIGHT_WORKER_AGGREGATE",
  "PI_TEAM_BRIGHT_MODEL_TOOL",
];

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function sameDirectory(left, right) {
  if (!left || !right) return false;
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return left === right;
  }
}

function countJsonl(root) {
  if (!root || !fs.existsSync(root)) return 0;
  let count = 0;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) count += 1;
    }
  };
  visit(root);
  return count;
}

function readActivation() {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      process.stdin.off("data", onData);
      try {
        resolve(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", () => reject(new Error("Activation lease ended before use.")));
  });
}

const importStarted = performance.now();
const environmentAtImport = Object.fromEntries(teamEnvironmentNames.map((name) => [name, Boolean(process.env[name])]));
const cwdAtImport = process.cwd();
const imported = await import("@earendil-works/pi-coding-agent");
const extensionFactories = [];
for (const extensionPath of process.argv.slice(2)) {
  const extensionModule = await import(pathToFileURL(extensionPath).href);
  const factory = extensionModule.default;
  if (typeof factory !== "function") throw new Error("Preloaded extension did not export a default factory.");
  extensionFactories.push(factory);
}
const importFinished = performance.now();

send({
  type: "preload_ready",
  process_id: process.pid,
  import_ms: Math.round((importFinished - importStarted) * 1000) / 1000,
  rss_bytes: process.memoryUsage().rss,
  cwd_at_import: cwdAtImport,
  team_environment_present_at_import: environmentAtImport,
  main_exported: typeof imported.main === "function",
  preloaded_extension_factory_count: extensionFactories.length,
});

let activation;
try {
  activation = await readActivation();
} catch (error) {
  send({ type: "preload_activation_failed", error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
  process.exit();
}

if (activation?.type !== "activate" || typeof imported.main !== "function") {
  send({ type: "preload_activation_failed", error: "The single-use activation lease was invalid." });
  process.exitCode = 1;
  process.exit();
}

// All Pi settings are applied only after the ready lease is consumed. The
// child is never reset or re-used after this point.
for (const [name, value] of Object.entries(activation.environment ?? {})) {
  if (typeof value === "string") process.env[name] = value;
}
process.chdir(activation.cwd);

send({
  type: "preload_activation_started",
  process_id: process.pid,
  rss_bytes: process.memoryUsage().rss,
  cwd_matches_activation: sameDirectory(process.cwd(), activation.cwd),
  sessions_before_activation: countJsonl(activation.agent_dir),
  stdin_is_tty: process.stdin.isTTY === true,
  stdout_is_tty: process.stdout.isTTY === true,
});

try {
  await imported.main(activation.args, extensionFactories.length > 0 ? { extensionFactories } : undefined);
  send({ type: "preload_main_returned" });
} catch (error) {
  send({ type: "preload_main_failed", error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
