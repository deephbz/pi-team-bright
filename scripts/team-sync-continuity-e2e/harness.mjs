import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE = path.resolve(HERE, "../..");
const PI_CLI = path.join(PACKAGE, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const DEFAULT_EXTENSION = path.join(PACKAGE, "extensions/index.ts");

function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = predicate();
      if (value !== undefined) return resolve(value);
      if (Date.now() - started >= timeoutMs) return reject(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

export function createSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-sync-real-pi-"));
  for (const name of ["home", "agent", "project", "sessions", "tmp"]) fs.mkdirSync(path.join(root, name));
  return {
    root,
    path: (...parts) => path.join(root, ...parts),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
  };
}

/** A dedicated tmux socket. It cannot address any existing user tmux server. */
export class PrivateTmuxCarrier {
  constructor(sandbox) {
    this.sandbox = sandbox;
    this.socket = sandbox.path("tmux.sock");
    this.name = `fixture-${randomUUID().slice(0, 8)}`;
  }

  command(...args) {
    return execFileSync("tmux", ["-S", this.socket, ...args], { encoding: "utf8", env: this.serverEnv });
  }

  start(serverEnv = {}) {
    this.serverEnv = { ...process.env, ...serverEnv };
    this.command("-f", "/dev/null", "new-session", "-d", "-s", this.name, "-c", this.sandbox.path("project"), "sleep", "3600");
    this.leaderPane = this.command("display-message", "-p", "-t", this.name, "#{pane_id}").trim();
    assert.match(this.leaderPane, /^%[0-9]+$/);
    return this;
  }

  childEnvironment() {
    assert(this.leaderPane);
    return { TMUX: `${this.socket},0,0`, TMUX_PANE: this.leaderPane };
  }

  close() {
    if (!this.leaderPane) return;
    try { this.command("kill-server"); } catch { /* The private server may already have exited. */ }
    this.leaderPane = undefined;
  }
}

function completionChunk(id, model, delta, finishReason = null, usage) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

export function textResponse(text) {
  return { kind: "text", text };
}

export function toolCallResponse(name, args, id = `call_${randomUUID().replaceAll("-", "")}`) {
  return { kind: "tool", name, args, id };
}

/** One loopback-only OpenAI Completions endpoint with explicit response gates. */
export class LocalProviderFixture {
  constructor() {
    this.server = http.createServer((request, response) => void this.accept(request, response));
    this.requests = [];
    this.pending = [];
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    assert(address && typeof address !== "string");
    this.baseUrl = `http://127.0.0.1:${address.port}/v1`;
    return this;
  }

  async accept(request, response) {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert(size < 2_000_000, "Fixture request exceeds bound");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const item = { sequence: this.requests.length + 1, at: Date.now(), body, response, answered: false };
      this.requests.push(item);
      this.pending.push(item);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  }

  async nextRequest(afterSequence = 0, timeoutMs = 10_000) {
    return waitFor(() => this.requests.find((item) => item.sequence > afterSequence), timeoutMs, "provider request");
  }

  async requestMatching(predicate, afterSequence = 0, timeoutMs = 10_000) {
    return waitFor(() => this.requests.find((item) => item.sequence > afterSequence && predicate(item)), timeoutMs, "matching provider request");
  }

  answer(request, scripted) {
    assert(this.pending.includes(request), "Provider request was not pending");
    assert.equal(request.answered, false);
    request.answered = true;
    this.pending.splice(this.pending.indexOf(request), 1);
    const id = `chatcmpl-fixture-${request.sequence}`;
    const model = request.body.model;
    const delta = scripted.kind === "tool"
      ? { role: "assistant", tool_calls: [{ index: 0, id: scripted.id, type: "function", function: { name: scripted.name, arguments: JSON.stringify(scripted.args) } }] }
      : { role: "assistant", content: scripted.text };
    const finishReason = scripted.kind === "tool" ? "tool_calls" : "stop";
    request.response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    request.response.write(`data: ${JSON.stringify(completionChunk(id, model, delta))}\n\n`);
    request.response.write(`data: ${JSON.stringify(completionChunk(id, model, {}, finishReason, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }))}\n\n`);
    request.response.end("data: [DONE]\n\n");
  }

  fail(request, status = 503) {
    assert(this.pending.includes(request), "Provider request was not pending");
    assert.equal(request.answered, false);
    request.answered = true;
    this.pending.splice(this.pending.indexOf(request), 1);
    request.response.writeHead(status, { "content-type": "application/json" });
    request.response.end(JSON.stringify({ error: { type: "fixture_failure", message: "Intentional local provider failure" } }));
  }

  async close() {
    for (const request of this.pending) request.response.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

/** Actual Pi RPC process. stdout is parsed only at LF protocol boundaries. */
export class PiRpcProcess {
  constructor(sandbox, provider, options = {}) {
    this.sandbox = sandbox;
    this.provider = provider;
    this.options = options;
    this.records = [];
    this.stderr = "";
    this.stdoutFragment = "";
    this.nextId = 1;
    this.sessionId = options.sessionId ?? randomUUID();
  }

  async start() {
    fs.writeFileSync(this.sandbox.path("agent", "models.json"), JSON.stringify({
      providers: {
        fixture: {
          baseUrl: this.provider.baseUrl,
          api: "openai-completions",
          apiKey: "fixture-local-only",
          models: ["scripted", "worker-scripted"].map((id) => ({ id, name: `Scripted local fixture ${id}`, reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
        },
      },
    }));
    const env = {
      HOME: this.sandbox.path("home"), USERPROFILE: this.sandbox.path("home"),
      TMPDIR: this.sandbox.path("tmp"), PI_CODING_AGENT_DIR: this.sandbox.path("agent"),
      PI_CODING_AGENT_SESSION_DIR: this.sandbox.path("sessions"),
      PI_TELEMETRY: "0", TERM: "xterm-256color", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
      PI_TEAM_SYNC_CONTEXT_CAPTURE: this.sandbox.path("context.jsonl"),
      PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH,
      NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
      BD_DISABLE_EVENT_FLUSH: "1", BD_DISABLE_METRICS: "1",
      ...this.options.env,
    };
    const args = [
      this.options.piCli ?? PI_CLI, "--mode", "rpc", "--provider", "fixture", "--model", "scripted", "--thinking", "off",
      "--no-extensions", "-e", this.options.extension ?? DEFAULT_EXTENSION, "-e", path.join(HERE, "capture.ts"),
      "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
      "--no-builtin-tools", "--no-approve", "--session-dir", this.sandbox.path("sessions"),
      ...(this.options.sessionPath ? ["--session", this.options.sessionPath] : ["--session-id", this.sessionId]),
      ...(this.options.extraArgs ?? []),
    ];
    this.child = spawn(process.execPath, args, { cwd: this.sandbox.path("project"), env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk) => {
      this.stdoutFragment += chunk.toString("utf8");
      let index;
      while ((index = this.stdoutFragment.indexOf("\n")) >= 0) {
        const line = this.stdoutFragment.slice(0, index);
        this.stdoutFragment = this.stdoutFragment.slice(index + 1);
        if (line) {
          try { this.records.push(JSON.parse(line)); }
          catch (error) { this.records.push({ type: "invalid_json", line, error: String(error) }); }
        }
      }
    });
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString("utf8"); });
    this.child.once("error", (error) => { this.spawnError = error; });
    await this.command("get_state");
    return this;
  }

  async command(type, fields = {}, timeoutMs = 10_000) {
    const id = `fixture-${this.nextId++}`;
    this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    const response = await this.waitFor((record) => record.type === "response" && record.id === id, timeoutMs, `${type} response`);
    if (type === "get_state" && typeof response.data?.sessionFile === "string") this.currentSessionFile = response.data.sessionFile;
    return response;
  }

  async waitFor(predicate, timeoutMs = 10_000, label = "RPC event") {
    return waitFor(() => this.records.find(predicate), timeoutMs, label).catch((error) => {
      throw new Error(`${error.message} childExit=${this.child.exitCode} stderr=${JSON.stringify(this.stderr.slice(-2000))} records=${JSON.stringify(this.records.slice(-8))}`);
    });
  }

  async waitForNew(predicate, afterIndex, timeoutMs = 10_000, label = "new RPC event") {
    return waitFor(() => this.records.slice(afterIndex).find(predicate), timeoutMs, label).catch((error) => {
      throw new Error(`${error.message} childExit=${this.child.exitCode} stderr=${JSON.stringify(this.stderr.slice(-2000))} records=${JSON.stringify(this.records.slice(-8))}`);
    });
  }

  sessionEntries() {
    assert(this.currentSessionFile && this.currentSessionFile.startsWith(this.sandbox.path("sessions")), "Pi did not report an isolated Session file");
    return fs.readFileSync(this.currentSessionFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  capturedFrameworkContext() {
    const file = this.sandbox.path("context.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  async close() {
    if (!this.child) return;
    if (this.child.exitCode === null) this.child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => this.child.once("close", resolve)),
      new Promise((resolve) => setTimeout(() => { this.child.kill("SIGKILL"); resolve(); }, 3_000)),
    ]);
  }
}
