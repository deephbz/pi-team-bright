import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SpawnOptions, TerminalAdapter } from "../../src/utils/terminal-adapter";

const CLEARED_PI_ENV = [
  "PI_TEAM_NAME",
  "PI_AGENT_NAME",
  "PI_AGENT_LAUNCH_ID",
  "PI_TEAMS_SESSION_ROOT",
  "PI_TEAMS_TRACE_JSONL",
] as const;

export interface IsolatedWorkspace {
  readonly root: string;
  readonly home: string;
  readonly tmp: string;
  resolve(...segments: string[]): string;
  write(relativePath: string, content: string): string;
  childEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  cleanup(): void;
}

/** A per-scenario filesystem boundary for public-process characterization. */
export function createIsolatedWorkspace(prefix = "pi-team-bright-external-"): IsolatedWorkspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });

  const resolve = (...segments: string[]) => {
    const candidate = path.resolve(root, ...segments);
    const relative = path.relative(root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Fixture path escapes its isolated root: ${candidate}`);
    }
    return candidate;
  };

  return {
    root,
    home,
    tmp,
    resolve,
    write(relativePath, content) {
      const target = resolve(relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      return target;
    },
    childEnvironment(overrides = {}) {
      const environment: NodeJS.ProcessEnv = { ...process.env };
      for (const key of CLEARED_PI_ENV) delete environment[key];
      return {
        ...environment,
        HOME: home,
        USERPROFILE: home,
        TMPDIR: tmp,
        BD_DISABLE_EVENT_FLUSH: "1",
        BD_DISABLE_METRICS: "1",
        ...overrides,
      };
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedFailure(label: string, timeoutMs: number, stdout: string, stderr: string): Error {
  return new Error(`${label} did not complete within ${timeoutMs}ms. stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
}

function matches(value: string, expected: string | RegExp): boolean {
  if (typeof expected === "string") return value.includes(expected);
  expected.lastIndex = 0;
  return expected.test(value);
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface ControlledProcessOptions {
  command: string;
  args?: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawnOptions?: Omit<SpawnOptionsWithoutStdio, "cwd" | "env" | "shell" | "stdio">;
  timeoutMs?: number;
}

/**
 * A shell-free child process with bounded observation and explicit crash/restart.
 * Tests use the child as an external boundary instead of mocking its internals.
 */
export class ControlledProcess {
  readonly options: ControlledProcessOptions;
  stdout = "";
  stderr = "";
  private child?: ChildProcessWithoutNullStreams;
  private closed = true;

  constructor(options: ControlledProcessOptions) {
    if (!path.isAbsolute(options.cwd)) throw new Error(`Controlled process cwd must be absolute: ${options.cwd}`);
    this.options = options;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  start(): this {
    if (this.child && !this.closed) throw new Error("Controlled process has not closed.");
    this.stdout = "";
    this.stderr = "";
    this.closed = false;
    this.child = spawn(this.options.command, [...(this.options.args ?? [])], {
      ...this.options.spawnOptions,
      cwd: this.options.cwd,
      env: this.options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => { this.stdout += chunk; });
    this.child.stderr.on("data", (chunk: string) => { this.stderr += chunk; });
    this.child.once("close", () => { this.closed = true; });
    return this;
  }

  async waitForOutput(expected: string | RegExp, options: { stream?: "stdout" | "stderr"; timeoutMs?: number } = {}): Promise<string> {
    const child = this.requireChild();
    const streamName = options.stream ?? "stdout";
    const stream = child[streamName];
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 2_000;
    const current = () => this[streamName];
    if (matches(current(), expected)) return current();

    return new Promise<string>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        stream.off("data", onData);
        child.off("error", onError);
        child.off("close", onClose);
        if (error) reject(error);
        else resolve(current());
      };
      const onData = () => { if (matches(current(), expected)) finish(); };
      const onError = (error: Error) => finish(error);
      const onClose = () => finish(new Error(`Process exited before ${streamName} matched ${String(expected)}. stdout=${JSON.stringify(this.stdout)} stderr=${JSON.stringify(this.stderr)}`));
      const timer = setTimeout(() => finish(boundedFailure(`${streamName} match ${String(expected)}`, timeoutMs, this.stdout, this.stderr)), timeoutMs);
      stream.on("data", onData);
      child.once("error", onError);
      child.once("close", onClose);
    });
  }

  async waitForExit(timeoutMs = this.options.timeoutMs ?? 2_000): Promise<ProcessExit> {
    const child = this.requireChild();
    if (this.closed) return this.exitResult(child);
    return new Promise<ProcessExit>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.off("error", onError);
        child.off("close", onClose);
        if (error) reject(error);
        else resolve(this.exitResult(child));
      };
      const onError = (error: Error) => finish(error);
      const onClose = () => finish();
      const timer = setTimeout(() => finish(boundedFailure("process exit", timeoutMs, this.stdout, this.stderr)), timeoutMs);
      child.once("error", onError);
      child.once("close", onClose);
    });
  }

  async crash(signal: NodeJS.Signals = "SIGKILL", timeoutMs = this.options.timeoutMs ?? 2_000): Promise<ProcessExit> {
    const child = this.requireChild();
    if (this.running && !child.kill(signal)) throw new Error(`Failed to send ${signal} to process ${child.pid ?? "unknown"}.`);
    return this.waitForExit(timeoutMs);
  }

  async restart(signal: NodeJS.Signals = "SIGKILL"): Promise<this> {
    if (this.running) await this.crash(signal);
    else if (this.child && !this.closed) await this.waitForExit();
    return this.start();
  }

  private requireChild(): ChildProcessWithoutNullStreams {
    if (!this.child) throw new Error("Controlled process has not started.");
    return this.child;
  }

  private exitResult(child: ChildProcessWithoutNullStreams): ProcessExit {
    return { code: child.exitCode, signal: child.signalCode, stdout: this.stdout, stderr: this.stderr };
  }
}

export type TerminalOperation =
  | { kind: "spawn"; id: string; options: SpawnOptions }
  | { kind: "kill"; id: string }
  | { kind: "set_title"; title: string }
  | { kind: "spawn_window"; id: string; options: SpawnOptions }
  | { kind: "kill_window"; id: string }
  | { kind: "set_window_title"; id: string; title: string };

/** A deterministic fake at the production TerminalAdapter boundary. */
export class FakeTerminalAdapter implements TerminalAdapter {
  readonly name: string;
  readonly operations: TerminalOperation[] = [];
  readonly paneIds = new Set<string>();
  readonly windowIds = new Set<string>();
  private paneSequence = 0;
  private windowSequence = 0;

  constructor(private readonly settings: {
    name?: string;
    detected?: boolean;
    direct?: boolean;
    currentTargetId?: string | null;
    windows?: boolean;
  } = {}) {
    this.name = settings.name ?? "fixture";
  }

  currentTargetId(): string | null { return this.settings.currentTargetId === undefined ? "leader-pane" : this.settings.currentTargetId; }
  isDirectCarrier(): boolean { return this.settings.direct ?? true; }
  detect(): boolean { return this.settings.detected ?? true; }
  supportsWindows(): boolean { return this.settings.windows ?? false; }

  spawn(options: SpawnOptions): string {
    const id = `pane-${++this.paneSequence}`;
    this.paneIds.add(id);
    this.operations.push({ kind: "spawn", id, options });
    return id;
  }

  kill(id: string): void {
    this.paneIds.delete(id);
    this.operations.push({ kind: "kill", id });
  }

  isAlive(id: string): boolean { return this.paneIds.has(id); }
  setTitle(title: string): void { this.operations.push({ kind: "set_title", title }); }

  spawnWindow(options: SpawnOptions): string {
    if (!this.supportsWindows()) throw new Error(`${this.name} does not support windows.`);
    const id = `window-${++this.windowSequence}`;
    this.windowIds.add(id);
    this.operations.push({ kind: "spawn_window", id, options });
    return id;
  }

  killWindow(id: string): void {
    this.windowIds.delete(id);
    this.operations.push({ kind: "kill_window", id });
  }

  isWindowAlive(id: string): boolean { return this.windowIds.has(id); }
  setWindowTitle(id: string, title: string): void { this.operations.push({ kind: "set_window_title", id, title }); }

  /** Inject carrier death without recording an adapter-requested stop. */
  crashPane(id: string): void { this.paneIds.delete(id); }
  crashWindow(id: string): void { this.windowIds.delete(id); }
}

function parseCursor(cursor: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(cursor)) throw new Error(`Invalid event cursor: ${JSON.stringify(cursor)}`);
  return BigInt(cursor);
}

export function assertCursorUnchanged(before: string, after: string): void {
  parseCursor(before);
  parseCursor(after);
  if (after !== before) throw new Error(`Expected cursor ${before} to remain unchanged, but received ${after}.`);
}

export function assertCursorAdvanced(before: string, after: string): void {
  const prior = parseCursor(before);
  const next = parseCursor(after);
  if (next <= prior) throw new Error(`Expected cursor to advance beyond ${before}, but received ${after}.`);
}

export interface RegisteredToolLike {
  name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    context?: unknown,
  ): Promise<{ content?: unknown[]; details?: unknown; isError?: boolean }>;
  renderResult?: (
    result: { content: unknown[]; details: unknown },
    options: { expanded: boolean; isPartial: boolean },
    theme: unknown,
    context: unknown,
  ) => { render(width: number): string[] };
}

export interface TrioProjection {
  tool: string;
  execution: { kind: "returned"; isError: boolean } | { kind: "threw"; error: string };
  machine?: { details: unknown; json: string };
  model?: { content: unknown[]; text: string };
  human?: { collapsed: string; expanded: string };
}

const identityTheme = new Proxy({}, {
  get: (_target, property) => {
    if (["fg", "bg"].includes(String(property))) return (_name: string, text: string) => text;
    if (["bold", "italic", "underline", "strikethrough"].includes(String(property))) return (text: string) => text;
    return undefined;
  },
});

function modelText(content: unknown[]): string {
  return content
    .filter((block): block is { type: "text"; text: string } => {
      if (!block || typeof block !== "object") return false;
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string";
    })
    .map((block) => block.text)
    .join("\n");
}

function render(tool: RegisteredToolLike, result: { content: unknown[]; details: unknown; isError?: boolean }, args: Record<string, unknown>, expanded: boolean, width: number): string {
  if (!tool.renderResult) return modelText(result.content);
  return tool.renderResult(
    { content: result.content, details: result.details },
    { expanded, isPartial: false },
    identityTheme,
    {
      args,
      toolCallId: "external-harness-render",
      invalidate() {},
      lastComponent: undefined,
      state: {},
      cwd: process.cwd(),
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded,
      showImages: false,
      isError: !!result.isError,
    },
  ).render(width).join("\n");
}

/** Capture machine, model, and human projections from one real registered tool call. */
export async function captureTrioProjection(options: {
  tool: RegisteredToolLike;
  args: Record<string, unknown>;
  context?: unknown;
  signal?: AbortSignal;
  toolCallId?: string;
  width?: number;
}): Promise<TrioProjection> {
  try {
    const returned = await options.tool.execute(
      options.toolCallId ?? "external-harness-call",
      options.args,
      options.signal,
      undefined,
      options.context,
    );
    const result = {
      content: returned.content ?? [],
      details: returned.details,
      isError: returned.isError,
    };
    return {
      tool: options.tool.name,
      execution: { kind: "returned", isError: !!result.isError },
      machine: { details: result.details, json: JSON.stringify(result.details) ?? "" },
      model: { content: result.content, text: modelText(result.content) },
      human: {
        collapsed: render(options.tool, result, options.args, false, options.width ?? 100),
        expanded: render(options.tool, result, options.args, true, options.width ?? 100),
      },
    };
  } catch (error) {
    return { tool: options.tool.name, execution: { kind: "threw", error: errorText(error) } };
  }
}

/** Exact released-versus-working-tree comparison after scenario-specific normalization. */
export function trioProjectionDifferences(expected: TrioProjection, actual: TrioProjection): string[] {
  const differences: string[] = [];
  const fields: Array<[string, unknown, unknown]> = [
    ["tool", expected.tool, actual.tool],
    ["execution", expected.execution, actual.execution],
    ["machine", expected.machine, actual.machine],
    ["model", expected.model, actual.model],
    ["human", expected.human, actual.human],
  ];
  for (const [field, left, right] of fields) {
    if (JSON.stringify(left) !== JSON.stringify(right)) differences.push(field);
  }
  return differences;
}
