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
 * The filesystem is deliberately absent. Every actor on one host shares the
 * real `~/.pi` tree, and the simulator gives each world an isolated temp HOME.
 * Crash-torn writes are out of scope; atomic writes use rename.
 *
 * Rules for this interface:
 * - Each member is an OS primitive or an external authority's wire surface.
 *   No PTB algorithm lives behind it.
 * - Synchronous members stay synchronous. A simulated implementation answers
 *   from world state at call time and may advance only the caller's clock.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

export type TimerHandle = { readonly __timer: unique symbol } | ReturnType<typeof setTimeout>;

export interface HostClock {
  /** Wall-clock milliseconds since the epoch. Evidence of order only within one actor. */
  now(): number;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | undefined): void;
  setInterval(callback: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle | undefined): void;
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
  /** `kill(pid, 0)` semantics: true when the pid exists or EPERM. */
  pidExists(pid: number): boolean;
  kill(pid: number, signal: NodeJS.Signals | number): void;
  /** Read the generation of `pid` now. Unsupported platforms answer `unknown`. */
  generation(pid: number): GenerationProbe;
  /** Terminate this actor. Simulated actors stop scheduling instead of exiting the test process. */
  exit(code: number): never;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

export interface HostExec {
  /** Blocking command execution, e.g. the Herdr CLI. */
  runSync(command: string, args: readonly string[]): ExecResult;
}

export interface HostWatcher {
  close(): void;
  onError(listener: (error: unknown) => void): void;
}

export interface HostWatch {
  watchDirectory(directory: string, listener: (filename: string | null) => void): HostWatcher;
}

export interface HostEnv {
  clock: HostClock;
  random: HostRandom;
  process: HostProcess;
  exec: HostExec;
  watch: HostWatch;
}

function unsupportedGeneration(): GenerationProbe {
  return { kind: "unknown", reason: "generation_verifier_unavailable" };
}

export const nodeHostEnv: HostEnv = {
  clock: {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  },
  random: {
    uuid: () => crypto.randomUUID(),
    float: () => Math.random(),
    bytes: (length) => crypto.randomBytes(length),
  },
  process: {
    get pid() { return process.pid; },
    get env() { return process.env; },
    pidExists: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === "EPERM";
      }
    },
    kill: (pid, signal) => { process.kill(pid, signal); },
    generation: unsupportedGeneration,
    exit: (code) => process.exit(code),
  },
  exec: {
    runSync: (command, args) => {
      const result = spawnSync(command, [...args], { encoding: "utf-8" });
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
    },
  },
  watch: {
    watchDirectory: (directory, listener) => {
      const watcher = fs.watch(directory, (_event, filename) => listener(typeof filename === "string" ? filename : null));
      return { close: () => watcher.close(), onError: (handler) => { watcher.on("error", handler); } };
    },
  },
};

const actorEnv = new AsyncLocalStorage<HostEnv>();

/** The current actor's host capabilities. */
export function hostEnv(): HostEnv {
  return actorEnv.getStore() ?? nodeHostEnv;
}

/** Run `action` and all its async continuations as one simulated actor. */
export function runWithHostEnv<T>(env: HostEnv, action: () => T): T {
  return actorEnv.run(env, action);
}
