export type TimerHandle = {
    readonly __timer: unique symbol;
} | ReturnType<typeof setTimeout>;
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
export type GenerationProbe = {
    kind: "found";
    generation: ProcessGeneration;
} | {
    kind: "absent";
} | {
    kind: "unknown";
    reason: string;
};
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
export type ExecOutcome = ({
    kind: "exited";
} & ExecResult) | {
    kind: "spawn_failed";
    code: string;
    message: string;
} | {
    kind: "timeout";
    afterMs: number;
} | {
    kind: "aborted";
};
export interface HostExec {
    /** Blocking command execution, e.g. the Herdr CLI. Baseline only. */
    runSync(command: string, args: readonly string[]): ExecResult;
    /** Bounded async command execution. Arrival, effect and completion are separate world events. */
    run(command: string, args: readonly string[], options: {
        timeoutMs: number;
        signal?: AbortSignal;
    }): Promise<ExecOutcome>;
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
    mkdir(path: string, options: {
        recursive: true;
    }): Promise<void>;
    stat(path: string): Promise<DurableStats>;
    open(path: string, flags: string, mode?: number): Promise<DurableFileHandle>;
    writeFile(path: string, data: string | Uint8Array, options: {
        flag: string;
        mode: number;
    }): Promise<void>;
    rename(from: string, to: string, beforeCommit?: () => void): Promise<void>;
    unlink(path: string): Promise<void>;
}
export interface DurableFileHandle {
    writeFile(data: string | Uint8Array): Promise<void>;
    write(buffer: Buffer, offset: number, length: number, position: number | null): Promise<{
        bytesWritten: number;
        buffer: Buffer;
    }>;
    read(buffer: Buffer, offset: number, length: number, position: number): Promise<{
        bytesRead: number;
        buffer: Buffer;
    }>;
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
export declare function createNodeDurableFileSystem(): DurableFileSystem;
export declare const nodeHostEnv: HostEnv;
/** The current actor's host capabilities. */
export declare function hostEnv(): HostEnv;
/** Make host access outside an actor fail closed until the returned release runs. */
export declare function enterSimulation(): () => void;
/** Run `action` and all its async continuations as one simulated actor. */
export declare function runWithHostEnv<T>(env: HostEnv, action: () => T): T;
