#!/usr/bin/env node
import { Check } from "typebox/value";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const EXPECTED_PI_VERSION = "0.80.10";
const EXPECTED_TOOL_NAMES = ["team_create", "ensure_worker", "task_create", "task_read", "task_update", "team_sync"];
const EXPECTED_TOOL_ORDER = ["team_create", "ensure_worker", "task_create", "team_sync", "task_read", "task_update", "team_sync"];
const REDACTION_POLICY = "pi-team-bright-model-tool-canary-redaction/1";
const SYSTEM_PROMPT = [
  "You are a careful coordination agent.",
  "Complete the operator request as far as the available tools permit.",
  "Treat tool results as authority and do not invent state or capabilities.",
  "When no available tool can complete the next action, identify that boundary.",
  "Finish with a concise factual report.",
].join(" ");
const OPERATOR_PROMPT = [
  "Prepare a durable release coordination frame.",
  "Establish the Team, add an independent area for release verification, and create the corresponding executable work contract.",
  "After creating the work contract, take a Team snapshot to establish observation context, read that Task by its ID, then update current_context exactly to 'Task is assigned but awaits a Worker carrier.' and append one decision journal entry while keeping status open.",
  "Then call Team updates to observe the committed Task delta. Keep the Task open and do not claim Worker execution. Report the updated work contract, its assignment, any execution boundary exposed by the results, and the next required action.",
].join(" ");

const PROVIDER_CREDENTIALS = {
  anthropic: new Set(["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]),
  openai: new Set(["OPENAI_API_KEY"]),
  google: new Set(["GEMINI_API_KEY"]),
  openrouter: new Set(["OPENROUTER_API_KEY"]),
  "openai-codex": new Set(["OPENAI_CODEX_OAUTH_TOKEN"]),
  groq: new Set(["GROQ_API_KEY"]),
  cerebras: new Set(["CEREBRAS_API_KEY"]),
  xai: new Set(["XAI_API_KEY"]),
};

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail(`Invalid argument near ${key ?? "end"}.`);
    if (values.has(key)) fail(`Duplicate argument ${key}.`);
    values.set(key, value);
  }
  const required = ["--provider", "--model", "--credential-env", "--raw-dir", "--receipt"];
  for (const key of required) {
    if (!values.get(key)) fail(`Missing required ${key}.`);
  }
  return {
    provider: values.get("--provider"),
    model: values.get("--model"),
    credentialEnvironment: values.get("--credential-env"),
    rawDirectory: resolve(values.get("--raw-dir")),
    receiptPath: resolve(values.get("--receipt")),
    thinking: values.get("--thinking") ?? "off",
    timeoutMs: Number(values.get("--timeout-ms") ?? "180000"),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function jwtExpiryMilliseconds(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function writePrivateJson(path, value) {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
}

function createPrivateFile(path) {
  const descriptor = openSync(path, "wx", 0o600);
  chmodSync(path, 0o600);
  return descriptor;
}

function filesUnder(root, excluded = new Set()) {
  const found = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && !excluded.has(relative(root, path))) found.push(path);
    }
  }
  visit(root);
  return found.sort();
}

function extractProviderTools(payload) {
  const tools = [];
  const direct = Array.isArray(payload?.tools) ? payload.tools : [];
  for (const item of direct) {
    const candidates = Array.isArray(item?.functionDeclarations)
      ? item.functionDeclarations
      : [item];
    for (const candidate of candidates) {
      const definition = candidate?.function ?? candidate;
      const name = definition?.name;
      const parameters = definition?.input_schema
        ?? definition?.inputSchema
        ?? definition?.parameters
        ?? definition?.parametersJsonSchema;
      if (typeof name === "string" && parameters && typeof parameters === "object") {
        tools.push({ name, parameters });
      }
    }
  }
  return tools;
}

function providerSystemText(payload) {
  const raw = payload?.instructions ?? payload?.system ?? payload?.systemInstruction;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw.map((part) => typeof part === "string" ? part : part?.text ?? "").join("");
  }
  if (raw && Array.isArray(raw.parts)) {
    return raw.parts.map((part) => part?.text ?? "").join("");
  }
  if (Array.isArray(payload?.messages)) {
    const system = payload.messages.find((message) => ["system", "developer"].includes(message?.role));
    if (typeof system?.content === "string") return system.content;
    if (Array.isArray(system?.content)) {
      return system.content.map((part) => typeof part === "string" ? part : part?.text ?? "").join("");
    }
  }
  return undefined;
}

function parseJsonLines(path) {
  const text = readFileSync(path, "utf8");
  return text.split("\n").filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      fail(`Invalid JSONL record ${index + 1} in private evidence.`);
    }
  });
}

function findSessionFiles(sessionRoot) {
  return filesUnder(sessionRoot).filter((path) => path.endsWith(".jsonl"));
}

function isNegated(text, index) {
  const prefix = text.slice(Math.max(0, index - 24), index).toLowerCase();
  return /(?:\bno\b|\bnot\b|\bnever\b|\bneither\b|\bwithout\b|n't)\s*$/.test(prefix);
}

function hasPositiveForbiddenClaim(text) {
  const patterns = [
    /\b(?:worker|team)\s+(?:is|are|was|were|became)\s+(?:ready|connected|running|working|staffed)\b/gi,
    /\b(?:ready|connected|running|working|staffed)\s+(?:worker|team)\b/gi,
    /\b(?:successfully\s+)?(?:launched|started)\s+(?:the\s+)?worker\b/gi,
  ];
  return patterns.some((pattern) => {
    for (const match of text.matchAll(pattern)) {
      if (!isNegated(text, match.index ?? 0)) return true;
    }
    return false;
  });
}

function normalizedEventKinds(rpcEvents, extensionRecords) {
  const interestingRpc = new Set([
    "agent_start",
    "agent_settled",
    "turn_start",
    "turn_end",
    "tool_execution_start",
    "tool_execution_end",
  ]);
  return [
    ...rpcEvents.filter((event) => interestingRpc.has(event.type)).map((event) =>
      event.toolName ? `rpc:${event.type}:${event.toolName}` : `rpc:${event.type}`),
    ...extensionRecords.filter((record) => record.kind !== "catalog").map((record) =>
      record.toolName ? `extension:${record.kind}:${record.toolName}` : `extension:${record.kind}`),
  ];
}

function parallelToolExecutionObserved(events) {
  const active = new Set();
  for (const event of events) {
    if (!EXPECTED_TOOL_NAMES.includes(event.toolName)) continue;
    if (event.type === "tool_execution_start") {
      if (active.size > 0) return true;
      active.add(event.toolCallId);
    }
    if (event.type === "tool_execution_end") active.delete(event.toolCallId);
  }
  return active.size > 0;
}

function safeSourceRevision(repositoryRoot) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) fail("Cannot resolve source revision.");
  return result.stdout.trim();
}

function killProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already stopped */ }
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  let timer;
  try {
    return await Promise.race([
      once(child, "exit").then(([code, signal]) => ({ code, signal })),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("rpc_exit_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  process.umask(0o077);
  const options = parseArguments(process.argv.slice(2));
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 10_000 || options.timeoutMs > 600_000) {
    fail("--timeout-ms must be between 10000 and 600000.");
  }
  const acceptedCredentials = PROVIDER_CREDENTIALS[options.provider];
  if (!acceptedCredentials?.has(options.credentialEnvironment)) {
    fail(`Credential environment is not accepted for provider ${options.provider}.`);
  }
  const credential = process.env[options.credentialEnvironment];
  if (!credential) fail(`Selected credential environment ${options.credentialEnvironment} is empty.`);
  if (!isAbsolute(options.rawDirectory)) fail("--raw-dir must be absolute.");
  if (existsSync(options.rawDirectory)) fail("--raw-dir must not already exist.");

  const scriptPath = fileURLToPath(import.meta.url);
  const repositoryRoot = realpathSync(resolve(dirname(scriptPath), "../.."));
  const rawParent = realpathSync(dirname(options.rawDirectory));
  const normalizedRaw = resolve(rawParent, options.rawDirectory.slice(dirname(options.rawDirectory).length + 1));
  if (normalizedRaw === repositoryRoot || normalizedRaw.startsWith(`${repositoryRoot}${sep}`)) {
    fail("Private raw evidence must stay outside the Git repository.");
  }
  if (options.receiptPath === normalizedRaw || options.receiptPath.startsWith(`${normalizedRaw}${sep}`)) {
    fail("The redacted receipt must not be inside the private raw bundle.");
  }

  mkdirSync(normalizedRaw, { mode: 0o700 });
  chmodSync(normalizedRaw, 0o700);
  const workDirectory = join(normalizedRaw, "work");
  const configDirectory = join(normalizedRaw, "config");
  const sessionDirectory = join(normalizedRaw, "sessions");
  const homeDirectory = join(normalizedRaw, "home");
  const temporaryDirectory = join(normalizedRaw, "tmp");
  for (const path of [workDirectory, configDirectory, sessionDirectory, homeDirectory, temporaryDirectory]) {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
  }

  const extensionPath = join(repositoryRoot, "scripts/model-tool-canary/extension.ts");
  const cliPath = join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  const capturePath = join(normalizedRaw, "extension.jsonl");
  const rpcPath = join(normalizedRaw, "rpc.jsonl");
  const stderrPath = join(normalizedRaw, "stderr.log");
  const sessionId = randomUUID();
  const sourceFiles = [
    "scripts/model-tool-canary/extension.ts",
    "scripts/model-tool-canary/run.mjs",
    "src/model-tool-contract/catalog.ts",
    "src/model-tool-contract/result-projection.ts",
    "src/model-tool-contract/in-memory-team-port.ts",
    "src/model-tool-contract/executors.ts",
    "src/model-tool-contract/pi-registration.ts",
    "src/model-tool-contract/runtime.ts",
  ];
  const sourceDigests = Object.fromEntries(sourceFiles.map((path) => [path, sha256File(join(repositoryRoot, path))]));

  const piVersionResult = spawnSync(process.execPath, [cliPath, "--version"], { encoding: "utf8" });
  const piVersion = piVersionResult.status === 0 ? piVersionResult.stdout.trim() : "unavailable";
  if (piVersion !== EXPECTED_PI_VERSION) fail(`Package-local Pi must be ${EXPECTED_PI_VERSION}.`);

  const cliArguments = [
    cliPath,
    "--mode", "rpc",
    "--provider", options.provider,
    "--model", options.model,
    "--thinking", options.thinking,
    "--offline",
    "--no-extensions",
    "-e", extensionPath,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-builtin-tools",
    "--tools", EXPECTED_TOOL_NAMES.join(","),
    "--no-approve",
    "--session-dir", sessionDirectory,
    "--session-id", sessionId,
    "--system-prompt", SYSTEM_PROMPT,
    "--name", "model-tool-canary",
  ];
  const childEnvironment = {
    HOME: homeDirectory,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    TMPDIR: temporaryDirectory,
    PI_CODING_AGENT_DIR: configDirectory,
    PI_CODING_AGENT_SESSION_DIR: sessionDirectory,
    PI_MODEL_TOOL_CANARY_CAPTURE: capturePath,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    [options.credentialEnvironment]: credential,
  };
  for (const proxyName of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
    if (process.env[proxyName]) childEnvironment[proxyName] = process.env[proxyName];
  }
  if (options.provider === "openai-codex") {
    const expires = jwtExpiryMilliseconds(credential);
    if (!expires || expires <= Date.now() + 60_000) fail("OpenAI Codex OAuth token expires too soon.");
    writePrivateJson(join(configDirectory, "auth.json"), {
      "openai-codex": {
        type: "oauth",
        access: credential,
        refresh: "canary-no-refresh",
        expires,
      },
    });
  }

  const redactedArguments = cliArguments.map((value) => {
    if (value === cliPath) return "<package-local-pi-cli>";
    if (value === extensionPath) return "<canary-extension>";
    if (value === sessionDirectory) return "<private-session-dir>";
    if (value === sessionId) return "<session-id>";
    return value;
  });

  writePrivateJson(join(normalizedRaw, "manifest.json"), {
    schema: "pi-team-bright-model-tool-canary-manifest/1",
    startedAt: new Date().toISOString(),
    sourceRevision: safeSourceRevision(repositoryRoot),
    sourceDigests,
    cliSha256: sha256File(cliPath),
    piVersion,
    nodeVersion: process.version,
    provider: options.provider,
    model: options.model,
    thinking: options.thinking,
    argv: ["<node>", ...redactedArguments],
    environmentNames: Object.keys(childEnvironment).sort(),
    systemPrompt: SYSTEM_PROMPT,
    operatorPrompt: OPERATOR_PROMPT,
    expectedToolOrder: EXPECTED_TOOL_ORDER,
    sessionId,
  });

  const captureDescriptor = createPrivateFile(capturePath);
  closeSync(captureDescriptor);
  const rpcDescriptor = createPrivateFile(rpcPath);
  const stderrDescriptor = createPrivateFile(stderrPath);
  const child = spawn(process.execPath, cliArguments, {
    cwd: workDirectory,
    env: childEnvironment,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const rpcEvents = [];
  const pending = new Map();
  let requestNumber = 0;
  let stdoutBuffer = "";
  let protocolFailure;
  let timedOut = false;
  let initialState;
  let finalState;
  let sessionEntries;
  let finalAssistantText;
  let commands;
  let exit = { code: null, signal: null };

  function handleLine(line) {
    if (!line) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      protocolFailure = "invalid_rpc_json";
      return;
    }
    if (message.type === "response" && message.id && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.success) waiter.resolve(message.data);
      else waiter.reject(new Error(`rpc_${message.command}_failed`));
      return;
    }
    rpcEvents.push(message);
  }

  child.stdout.on("data", (chunk) => {
    appendFileSync(rpcDescriptor, chunk);
    stdoutBuffer += chunk.toString("utf8");
    while (true) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      let line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      handleLine(line);
    }
  });
  child.stderr.on("data", (chunk) => appendFileSync(stderrDescriptor, chunk));
  child.on("exit", () => {
    for (const waiter of pending.values()) waiter.reject(new Error("rpc_process_exited"));
    pending.clear();
  });

  function send(command) {
    const id = `canary-rpc-${++requestNumber}`;
    return new Promise((resolvePromise, rejectPromise) => {
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`, (error) => {
        if (error) {
          pending.delete(id);
          rejectPromise(error);
        }
      });
    });
  }

  function waitForEvent(type) {
    const prior = rpcEvents.find((event) => event.type === type);
    if (prior) return Promise.resolve(prior);
    return new Promise((resolvePromise, rejectPromise) => {
      const interval = setInterval(() => {
        const found = rpcEvents.find((event) => event.type === type);
        if (found) {
          clearInterval(interval);
          resolvePromise(found);
        }
        if (child.exitCode !== null || protocolFailure) {
          clearInterval(interval);
          rejectPromise(new Error(protocolFailure ?? "rpc_process_exited"));
        }
      }, 10);
    });
  }

  let runErrorCode;
  const timeout = setTimeout(() => {
    timedOut = true;
    killProcessGroup(child, "SIGTERM");
  }, options.timeoutMs);

  try {
    await once(child, "spawn");
    initialState = await send({ type: "get_state" });
    commands = await send({ type: "get_commands" });
    await send({ type: "set_auto_retry", enabled: false });
    await send({ type: "set_auto_compaction", enabled: false });
    const settled = waitForEvent("agent_settled");
    await send({ type: "prompt", message: OPERATOR_PROMPT });
    await settled;
    finalState = await send({ type: "get_state" });
    sessionEntries = await send({ type: "get_entries" });
    finalAssistantText = (await send({ type: "get_last_assistant_text" }))?.text;
    child.stdin.end();
    try {
      exit = await waitForExit(child, 5_000);
    } catch {
      killProcessGroup(child, "SIGTERM");
      exit = await waitForExit(child, 5_000).catch(() => {
        killProcessGroup(child, "SIGKILL");
        return { code: null, signal: "SIGKILL" };
      });
    }
  } catch (error) {
    runErrorCode = timedOut ? "timeout" : error instanceof Error ? error.message : "unknown_run_failure";
    killProcessGroup(child, "SIGTERM");
    exit = await waitForExit(child, 5_000).catch(() => ({ code: null, signal: "unconfirmed" }));
  } finally {
    clearTimeout(timeout);
    if (stdoutBuffer) handleLine(stdoutBuffer.endsWith("\r") ? stdoutBuffer.slice(0, -1) : stdoutBuffer);
    closeSync(rpcDescriptor);
    closeSync(stderrDescriptor);
  }

  let extensionRecords = [];
  let sessionHeader;
  let analysisError;
  try {
    extensionRecords = parseJsonLines(capturePath);
    const sessionFiles = findSessionFiles(sessionDirectory);
    if (sessionFiles.length === 1) {
      sessionHeader = JSON.parse(readFileSync(sessionFiles[0], "utf8").split("\n", 1)[0]);
    }
  } catch {
    analysisError = "private_evidence_parse_failure";
  }

  const catalogRecord = extensionRecords.find((record) => record.kind === "catalog");
  const expectedCatalog = Array.isArray(catalogRecord?.tools) ? catalogRecord.tools : [];
  const expectedByName = new Map(expectedCatalog.map((tool) => [tool.name, tool]));
  const providerRequests = extensionRecords.filter((record) => record.kind === "before_provider_request");
  const providerResponses = extensionRecords.filter((record) => record.kind === "after_provider_response");
  const toolCalls = extensionRecords.filter((record) => record.kind === "tool_call");
  const toolResults = extensionRecords.filter((record) => record.kind === "tool_result");
  const sessionStarts = extensionRecords.filter((record) => record.kind === "session_start");
  const extensionSessionIds = extensionRecords
    .filter((record) => typeof record.sessionId === "string")
    .map((record) => record.sessionId);

  const providerSchemasExact = providerRequests.length > 0 && providerRequests.every((record) => {
    const actual = extractProviderTools(record.payload);
    return actual.length === EXPECTED_TOOL_NAMES.length
      && new Set(actual.map((tool) => tool.name)).size === EXPECTED_TOOL_NAMES.length
      && EXPECTED_TOOL_NAMES.every((name) => {
        const providerTool = actual.find((tool) => tool.name === name);
        return providerTool && isDeepStrictEqual(canonical(providerTool.parameters), canonical(expectedByName.get(name)?.parameters));
      });
  });
  const providerSystemExact = providerRequests.length > 0
    && providerRequests.every((record) => {
      const actual = providerSystemText(record.payload);
      return typeof actual === "string"
        && actual.startsWith(SYSTEM_PROMPT)
        && /^\nCurrent working directory: .+/.test(actual.slice(SYSTEM_PROMPT.length));
    });
  const resultSchemasValid = toolResults.length === EXPECTED_TOOL_ORDER.length
    && toolResults.every((record) => {
      const schema = expectedByName.get(record.toolName)?.result;
      return schema && Check(schema, record.details);
    });
  const parametersValid = toolCalls.length === EXPECTED_TOOL_ORDER.length
    && toolCalls.every((record) => {
      const schema = expectedByName.get(record.toolName)?.parameters;
      return schema && Check(schema, record.input);
    });
  const modelContentEqualsDetails = toolResults.length === EXPECTED_TOOL_ORDER.length
    && toolResults.every((record) => record.content?.length === 1
      && record.content[0]?.type === "text"
      && record.content[0]?.text === JSON.stringify(record.details));
  const callOrderExact = isDeepStrictEqual(toolCalls.map((record) => record.toolName), EXPECTED_TOOL_ORDER)
    && isDeepStrictEqual(toolResults.map((record) => record.toolName), EXPECTED_TOOL_ORDER);
  const noParallelCalls = !parallelToolExecutionObserved(rpcEvents);
  const validOrderedToolJourney = parametersValid
    && resultSchemasValid
    && modelContentEqualsDetails
    && callOrderExact
    && noParallelCalls
    && toolResults.every((record) => record.isError === false);
  const createCall = toolCalls[0]?.input;
  const ensureCall = toolCalls[1]?.input;
  const taskCall = toolCalls[2]?.input;
  const initialSnapshotResult = toolResults[3]?.details;
  const taskReadCall = toolCalls[4]?.input;
  const taskUpdateCall = toolCalls[5]?.input;
  const createResult = toolResults[0]?.details;
  const ensureResult = toolResults[1]?.details;
  const taskResult = toolResults[2]?.details;
  const taskReadResult = toolResults[4]?.details;
  const taskUpdateResult = toolResults[5]?.details;
  const snapshotResult = initialSnapshotResult;
  const updatesResult = toolResults[6]?.details;
  const carrierAbsent = ensureResult?.kind === "worker_ensured"
    && ensureResult?.worker?.carrier === "absent"
    && snapshotResult?.kind === "snapshot"
    && snapshotResult?.workers?.length === 1
    && snapshotResult.workers[0]?.carrier === "absent";
  const logicalWorkerPreserved = ensureCall
    && snapshotResult?.kind === "snapshot"
    && snapshotResult.workers?.[0]?.name === ensureCall.name
    && snapshotResult.workers?.[0]?.scope === ensureCall.scope;
  const teamPreserved = createCall
    && createResult?.kind === "team_created"
    && snapshotResult?.kind === "snapshot"
    && snapshotResult.team?.name === createCall.name
    && snapshotResult.team?.purpose === createCall.purpose;
  const createdTask = taskResult?.kind === "task_create_batch"
    && Array.isArray(taskCall?.tasks)
    && taskCall.tasks.length === 1
    && Array.isArray(taskResult.outcomes)
    && taskResult.outcomes.length === 1
    && taskResult.outcomes[0]?.kind === "created"
    && taskResult.outcomes[0]?.input_index === 0
    && taskResult.outcomes[0]?.task?.assignee === taskCall.tasks[0]?.assignee;
  const initialSnapshotAgrees = createdTask
    && initialSnapshotResult?.kind === "snapshot"
    && initialSnapshotResult.tasks?.length === 1
    && isDeepStrictEqual(initialSnapshotResult.tasks[0], taskResult.outcomes[0].task);
  const taskReadAgrees = createdTask
    && Array.isArray(taskReadCall?.task_ids)
    && taskReadCall.task_ids.length === 1
    && taskReadResult?.kind === "task_read_batch"
    && taskReadResult.outcomes?.length === 1
    && taskReadResult.outcomes[0]?.kind === "found"
    && taskReadResult.outcomes[0]?.input_index === 0
    && taskReadResult.outcomes[0]?.task_id === taskResult.outcomes[0].task.id
    && isDeepStrictEqual(taskReadResult.outcomes[0].task, taskResult.outcomes[0].task);
  const taskUpdated = taskUpdateResult?.kind === "task_update_batch"
    && Array.isArray(taskUpdateCall?.updates)
    && taskUpdateCall.updates.length === 1
    && taskUpdateResult.outcomes?.length === 1
    && taskUpdateResult.outcomes[0]?.kind === "updated"
    && taskUpdateResult.outcomes[0]?.input_index === 0
    && taskUpdateResult.outcomes[0]?.task_id === taskResult.outcomes[0].task.id
    && taskUpdateResult.outcomes[0]?.operation_id === taskUpdateCall.updates[0]?.operation_id
    && taskUpdateResult.outcomes[0]?.task?.status === "open"
    && /assigned/i.test(taskUpdateResult.outcomes[0]?.task?.current_context ?? "")
    && /awaits.*worker.*carrier/i.test(taskUpdateResult.outcomes[0]?.task?.current_context ?? "")
    && taskUpdateResult.outcomes[0]?.journal_entries?.length >= 1
    && taskUpdateResult.outcomes[0]?.journal_entries[0]?.actor === "leader"
    && taskUpdateResult.outcomes[0]?.journal_entries[0]?.kind === "decision";
  const updatesAgrees = taskUpdated
    && updatesResult?.kind === "updates"
    && updatesResult.task_changes?.length === 1
    && isDeepStrictEqual(updatesResult.task_changes[0].change_kinds, ["progress"])
    && isDeepStrictEqual(updatesResult.task_changes[0].journal_entries, taskUpdateResult.outcomes[0].journal_entries)
    && isDeepStrictEqual(updatesResult.task_changes[0].current, {
      status: taskUpdateResult.outcomes[0].task.status,
      assignee: taskUpdateResult.outcomes[0].task.assignee,
      current_context: taskUpdateResult.outcomes[0].task.current_context,
      version: taskUpdateResult.outcomes[0].task.version,
    });
  const workerTaskIndexAgrees = taskUpdated
    && snapshotResult?.kind === "snapshot"
    && snapshotResult.workers?.length === 1
    && isDeepStrictEqual(snapshotResult.workers[0]?.nonterminal_task_ids, [taskUpdateResult.outcomes[0].task.id]);
  const taskReadRecord = extensionRecords.find((record) => record.kind === "tool_call" && record.toolName === "task_read");
  const taskReadResultRecord = extensionRecords.find((record) => record.kind === "tool_result" && record.toolName === "task_read");
  const taskReadDoesNotMutate = Number.isInteger(taskReadRecord?.debugRevision)
    && Number.isInteger(taskReadResultRecord?.debugRevision)
    && taskReadRecord.debugRevision === taskReadResultRecord.debugRevision;
  const finalText = typeof finalAssistantText === "string" ? finalAssistantText : "";
  const finalReportsAbsentCarrier = /(?:\bno\b|\babsent\b|\bnot present\b|\bunavailable\b|\bmissing\b|\bnot connected\b|\bnot launched\b)[\s\S]{0,100}\bcarrier\b|\bcarrier\b[\s\S]{0,100}(?:\bno\b|\babsent\b|\bnot present\b|\bunavailable\b|\bmissing\b|\bnot connected\b|\bnot launched\b)/i.test(finalText);
  const finalReportsAssignedTask = /\btask\b/i.test(finalText)
    && /\b(?:creat\w*|assign\w*|open|contract)\b/i.test(finalText);
  const noForbiddenFinalClaim = finalText.length > 0 && !hasPositiveForbiddenClaim(finalText);
  const assistantMessageEnds = extensionRecords.filter((record) =>
    record.kind === "assistant_message_end" && record.role === "assistant");
  const completedUsageAssistantResponses = assistantMessageEnds.filter((record) =>
    record.stopReason === "stop"
    && Number.isFinite(record.usage?.input)
    && Number.isFinite(record.usage?.output)
    && Number.isFinite(record.usage?.totalTokens)
    && record.usage.totalTokens > 0);
  const successfulHttpResponses = providerRequests.length >= 1
    && providerResponses.length === providerRequests.length
    && providerResponses.every((record) => Number.isInteger(record.status) && record.status >= 200 && record.status < 300);
  const successfulProviderAnchor = successfulHttpResponses
    || (validOrderedToolJourney && completedUsageAssistantResponses.length >= 1);
  const providerAnchorClass = successfulHttpResponses
    ? "successful_http_response"
    : completedUsageAssistantResponses.length >= 1 && validOrderedToolJourney
      ? "completed_usage_bearing_assistant_response"
      : null;
  const noRuntimeErrors = !runErrorCode
    && !analysisError
    && !protocolFailure
    && !timedOut
    && !rpcEvents.some((event) => [
      "extension_error",
      "auto_retry_start",
      "auto_retry_end",
      "compaction_start",
      "compaction_end",
      "summarization_retry_scheduled",
      "summarization_retry_attempt_start",
      "summarization_retry_finished",
    ].includes(event.type))
    && toolResults.every((record) => record.isError === false);
  const sessionIdentityExact = sessionHeader?.type === "session"
    && sessionHeader.id === sessionId
    && initialState?.sessionId === sessionId
    && finalState?.sessionId === sessionId
    && extensionSessionIds.length > 0
    && extensionSessionIds.every((value) => value === sessionId)
    && sessionStarts.length === 1
    && sessionStarts[0]?.reason === "startup";
  const isolatedCommands = Array.isArray(commands?.commands) && commands.commands.length === 0;
  const captureSecure = (statSync(normalizedRaw).mode & 0o777) === 0o700
    && filesUnder(normalizedRaw).every((path) => (statSync(path).mode & 0o777) === 0o600);
  const sessionEvidencePresent = Array.isArray(sessionEntries?.entries)
    && sessionEntries.entries.length > 0
    && findSessionFiles(sessionDirectory).length === 1;
  const processExitedCleanly = exit.code === 0 && exit.signal === null;

  const checks = {
    packageLocalPiPinned: piVersion === EXPECTED_PI_VERSION,
    privateCaptureSecure: captureSecure,
    isolatedCommands,
    sessionIdentityExact,
    providerSchemasExact,
    providerSystemExact,
    successfulProviderAnchor,
    parametersValid,
    resultSchemasValid,
    modelContentEqualsDetails,
    callOrderExact,
    noParallelCalls,
    teamPreserved,
    logicalWorkerPreserved,
    carrierAbsent,
    initialSnapshotAgrees,
    taskReadAgrees,
    taskUpdated,
    updatesAgrees,
    workerTaskIndexAgrees,
    taskReadDoesNotMutate,
    finalReportsAbsentCarrier,
    finalReportsAssignedTask,
    noForbiddenFinalClaim,
    sessionEvidencePresent,
    noRuntimeErrors,
    processExitedCleanly,
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  const status = failedChecks.length === 0 ? "passed" : "failed";

  writePrivateJson(join(normalizedRaw, "outcome.json"), {
    schema: "pi-team-bright-model-tool-canary-private-outcome/1",
    completedAt: new Date().toISOString(),
    status,
    failedChecks,
    runErrorCode,
    analysisError,
    protocolFailure,
    timedOut,
    exit,
    checks,
  });

  const bundleEntries = filesUnder(normalizedRaw, new Set(["bundle-digest.json"])).map((path) => ({
    path: relative(normalizedRaw, path),
    sha256: sha256File(path),
  }));
  const bundleDigest = sha256Bytes(canonicalJson(bundleEntries));
  writePrivateJson(join(normalizedRaw, "bundle-digest.json"), {
    schema: "pi-team-bright-model-tool-canary-bundle-digest/1",
    excludes: ["bundle-digest.json"],
    entries: bundleEntries,
    sha256: bundleDigest,
  });

  const normalizedSchemas = EXPECTED_TOOL_NAMES.map((name) => ({
    name,
    parameters: canonical(expectedByName.get(name)?.parameters),
    parameterSchemaSha256: expectedByName.has(name)
      ? sha256Bytes(canonicalJson(expectedByName.get(name).parameters))
      : null,
    resultSchemaSha256: expectedByName.has(name)
      ? sha256Bytes(canonicalJson(expectedByName.get(name).result))
      : null,
  }));
  const safeJourney = toolCalls.length === EXPECTED_TOOL_ORDER.length && toolResults.length === EXPECTED_TOOL_ORDER.length
    ? EXPECTED_TOOL_ORDER.map((name, index) => ({
      tool: name,
      call: toolCalls[index].input,
      result: toolResults[index].details,
    }))
    : [];
  const receipt = {
    schema: "pi-team-bright-model-tool-real-pi-canary/1",
    redactionPolicy: REDACTION_POLICY,
    completedAt: new Date().toISOString(),
    status,
    sourceRevision: safeSourceRevision(repositoryRoot),
    sourceDigests,
    runtime: {
      piVersion,
      nodeVersion: process.version,
      provider: options.provider,
      model: options.model,
      thinking: options.thinking,
    },
    prompt: {
      systemSha256: sha256Bytes(SYSTEM_PROMPT),
      operatorSha256: sha256Bytes(OPERATOR_PROMPT),
      source: "scripts/model-tool-canary/run.mjs",
    },
    isolation: {
      freshWorkingDirectory: true,
      freshConfigDirectory: true,
      freshSessionDirectory: true,
      discoveredExtensions: false,
      discoveredSkills: false,
      discoveredPromptTemplates: false,
      discoveredThemes: false,
      contextFiles: false,
      builtInTools: false,
      activeToolNames: EXPECTED_TOOL_NAMES,
      offlineStartup: true,
      projectTrust: false,
    },
    providerObservation: {
      interpretation: "before_provider_request is a local pre-send observation; an HTTP success or a completed usage-bearing assistant response correlated with the valid ordered tool journey anchors provider execution",
      requestCount: providerRequests.length,
      evidenceClasses: {
        httpResponse: {
          observedCount: providerResponses.length,
          successfulCount: providerResponses.filter((record) => Number.isInteger(record.status) && record.status >= 200 && record.status < 300).length,
        },
        completedUsageBearingAssistantResponse: {
          observedCount: completedUsageAssistantResponses.length,
          assistantMessageEndCount: assistantMessageEnds.length,
        },
      },
      anchorClass: providerAnchorClass,
      schemas: normalizedSchemas,
    },
    journey: safeJourney,
    orderedEventKinds: normalizedEventKinds(rpcEvents, extensionRecords),
    checks,
    failedChecks,
    privateEvidence: {
      persistedOutsideGit: true,
      bundleSha256: bundleDigest,
    },
    claims: {
      proved: status === "passed"
        ? "One provider-bound Pi Session created and re-read one in-process logical Team, assigned one open Task to one Worker, and reported carrier absent."
        : null,
      notProved: [
        "public or shipped registration",
        "carrier launch, connection, readiness, liveness, or staffing",
        "Task creation, assignment, delegation, progress, or completion",
        "persistence, reload, resume, fork, or cross-Session isolation",
        "updates, waiting, cancellation, performance, security, or general readiness",
      ],
    },
  };
  mkdirSync(dirname(options.receiptPath), { recursive: true });
  writeFileSync(options.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644, flag: "w" });
  chmodSync(options.receiptPath, 0o644);

  process.stdout.write(`${JSON.stringify({ status, failedChecks, bundleSha256: bundleDigest })}\n`);
  process.exitCode = status === "passed" ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`Canary runner failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 2;
});
