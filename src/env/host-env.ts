// Project: pi-team-bright
/**
 * Host capability seam.
 *
 * PTB code reaches the host only through `hostEnv()`. Production resolves to
 * the real Node primitives. The deterministic simulator runs each simulated
 * Pi process inside `runWithHostEnv(actorEnv, ...)`; AsyncLocalStorage carries
 * that actor's capabilities through every await, so PTB algorithms run
 * unchanged against a simulated clock, process table and terminal.
 *
 * `durableFs` exposes only the asynchronous operations used by durable
 * replacement and journal append. Every actor on one host shares the real
 * `~/.pi` tree. A simulated world uses the process HOME that the test runner
 * isolates before any import, runs worlds one at a time and wipes the tree
 * between worlds. HostGuard schedules filesystem steps, fences each step to
 * its requesting actor generation, and fails closed outside that tree. File
 * timestamps never serve as time evidence; code compares only `clock.now()`
 * values. Crash-torn writes are out of scope; atomic writes use rename. One
 * Node loop serializes synchronous fs sequences that separate processes could
 * interleave; that limit is stated, not modelled.
 *
 * Rules for this interface:
 * - Each member is an OS primitive or an external authority's wire surface.
 *   No PTB algorithm lives behind it.
 * - Synchronous members stay synchronous. A simulated implementation answers
 *   from world state at call time and may advance only the caller's clock.
 *   Other actors make no progress during a synchronous block (assumption
 *   `S-sync-block`), so baseline blocking waits model their worst case.
 * - A simulated implementation runs every callback (timer, watcher, exec
 *   completion, Pi hook) inside the registering actor's context and drops it
 *   if that actor generation has exited.
 * - While a simulation is active, `hostEnv()` outside an actor throws.
 */
import { probeProcessGenerations } from "./process-generation";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { setTimeout as sleepNode } from "node:timers/promises";

export type TimerHandle = { readonly __timer: unique symbol } | ReturnType<typeof setTimeout>;

export interface HostClock {
  /** Wall-clock milliseconds since the epoch. Evidence of order only within one actor. */
  now(): number;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | undefined): void;
  setInterval(callback: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle | undefined): void;
  /** Non-blocking delay. Rejects with an AbortError when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Blocking delay (today: Atomics.wait). Blocks the whole actor. */
  sleepSync(ms: number): void;
  /** Resume in a later event-loop turn. */
  yield(): Promise<void>;
}

export interface HostRandom {
  uuid(): string;
  /** Uniform in [0, 1). */
  float(): number;
  bytes(length: number): Buffer;
}

/**
 * OS process-generation identity. Two observations name the same process only
 * if all three fields match. A pid alone never identifies a process.
 */
export interface ProcessGeneration {
  pid: number;
  /** Platform start token: Linux /proc starttime ticks, macOS proc_pidinfo start µs. */
  osBirthToken: string;
  bootId: string;
}

export type GenerationProbe =
  | { kind: "found"; generation: ProcessGeneration }
  | { kind: "absent" }
  | { kind: "unknown"; reason: string };

export interface HostProcess {
  readonly pid: number;
  /** This actor's environment variables. Never read `process.env` directly. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly argv: readonly string[];
  readonly execPath: string;
  cwd(): string;
  /** `kill(pid, 0)` semantics: true when the pid exists or EPERM. */
  pidExists(pid: number): boolean;
  kill(pid: number, signal: NodeJS.Signals | number): void;
  /** Read fresh generation evidence. Unsupported platforms answer `unknown`. */
  generations(pids: readonly number[]): Promise<Map<number, GenerationProbe>>;
  /** Terminate this actor. Simulated actors stop scheduling instead of exiting the test process. */
  exit(code: number): never;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

/**
 * Outcome of one bounded command. `timeout` and `aborted` leave the command's
 * effect unknown: the caller must not infer that it did not happen.
 */
export type ExecOutcome =
  | ({ kind: "exited" } & ExecResult)
  | { kind: "spawn_failed"; code: string; message: string }
  | { kind: "timeout"; afterMs: number }
  | { kind: "aborted" };

export interface HostExec {
  /** Blocking command execution, e.g. the Herdr CLI. Baseline only. */
  runSync(command: string, args: readonly string[]): ExecResult;
  /** Bounded async command execution. Arrival, effect and completion are separate world events. */
  run(command: string, args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal }): Promise<ExecOutcome>;
}

export interface HostWatcher {
  close(): void;
  onError(listener: (error: unknown) => void): void;
}

export interface HostWatch {
  watchDirectory(directory: string, listener: (filename: string | null) => void): HostWatcher;
}

/** Narrow async filesystem capability for durable replacement and journal append. */
export interface DurableStats {
  readonly size: number;
  readonly mode: number;
  isFile(): boolean;
}

export interface DurableFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<void>;
  stat(path: string): Promise<DurableStats>;
  open(path: string, flags: string, mode?: number): Promise<DurableFileHandle>;
  writeFile(path: string, data: string | Uint8Array, options: { flag: string; mode: number }): Promise<void>;
  rename(from: string, to: string, beforeCommit?: () => void): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface DurableFileHandle {
  writeFile(data: string | Uint8Array): Promise<void>;
  write(buffer: Buffer, offset: number, length: number, position: number | null): Promise<{ bytesWritten: number; buffer: Buffer }>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number; buffer: Buffer }>;
  sync(): Promise<void>;
  stat(): Promise<DurableStats>;
  truncate(length?: number): Promise<void>;
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
}

export interface HostEnv {
  clock: HostClock;
  random: HostRandom;
  process: HostProcess;
  exec: HostExec;
  watch: HostWatch;
  durableFs: DurableFileSystem;
}

export function createNodeDurableFileSystem(): DurableFileSystem {
  return {
    mkdir: async (path, options) => { await fsp.mkdir(path, options); },
    stat: (path) => fsp.stat(path),
    open: async (path, flags, mode) => await fsp.open(path, flags, mode),
    writeFile: async (path, data, options) => { await fsp.writeFile(path, data, options); },
    rename: async (from, to, beforeCommit) => { beforeCommit?.(); await fsp.rename(from, to); },
    unlink: async (path) => { await fsp.unlink(path); },
  };
}

function runNode(command: string, args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal }): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) return resolve({ kind: "aborted" });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const finish = (outcome: ExecOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => { child.kill("SIGTERM"); finish({ kind: "aborted" }); };
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish({ kind: "timeout", afterMs: options.timeoutMs }); }, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf-8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf-8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error: NodeJS.ErrnoException) => finish({ kind: "spawn_failed", code: error.code ?? "unknown", message: error.message }));
    child.on("close", (status) => finish({ kind: "exited", stdout, stderr, status }));
  });
}

export const nodeHostEnv: HostEnv = {
  durableFs: createNodeDurableFileSystem(),
  clock: {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    sleep: (ms, signal) => sleepNode(ms, undefined, { signal }),
    sleepSync: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms)); },
    yield: () => new Promise<void>((resolve) => setImmediate(resolve)),
  },
  random: {
    uuid: () => crypto.randomUUID(),
    float: () => Math.random(),
    bytes: (length) => crypto.randomBytes(length),
  },
  process: {
    get pid() { return process.pid; },
    get env() { return process.env; },
    get platform() { return process.platform; },
    get argv() { return process.argv; },
    get execPath() { return process.execPath; },
    cwd: () => process.cwd(),
    pidExists: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === "EPERM";
      }
    },
    kill: (pid, signal) => { process.kill(pid, signal); },
    generations: probeProcessGenerations,
    exit: (code) => process.exit(code),
  },
  exec: {
    runSync: (command, args) => {
      const result = spawnSync(command, [...args], { encoding: "utf-8" });
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
    },
    run: (command, args, options) => runNode(command, args, options),
  },
  watch: {
    watchDirectory: (directory, listener) => {
      const watcher = fs.watch(directory, (_event, filename) => listener(typeof filename === "string" ? filename : null));
      return { close: () => watcher.close(), onError: (handler) => { watcher.on("error", handler); } };
    },
  },
};

const actorEnv = new AsyncLocalStorage<HostEnv>();
let simulationActive = false;

/** The current actor's host capabilities. */
export function hostEnv(): HostEnv {
  const env = actorEnv.getStore();
  if (simulationActive && (!env || env === nodeHostEnv)) throw new Error("Host access outside a simulated actor.");
  if (env) return env;
  return nodeHostEnv;
}

/** Make host access outside an actor fail closed until the returned release runs. */
export function enterSimulation(): () => void {
  if (simulationActive) throw new Error("A simulation is already active in this process.");
  simulationActive = true;
  return () => { simulationActive = false; };
}

/** Run `action` and all its async continuations as one simulated actor. */
export function runWithHostEnv<T>(env: HostEnv, action: () => T): T {
  return actorEnv.run(env, action);
}
