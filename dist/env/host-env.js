"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.nodeHostEnv = void 0;
exports.createNodeDurableFileSystem = createNodeDurableFileSystem;
exports.hostEnv = hostEnv;
exports.enterSimulation = enterSimulation;
exports.runWithHostEnv = runWithHostEnv;
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
const process_generation_1 = require("./process-generation");
const node_async_hooks_1 = require("node:async_hooks");
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const promises_1 = __importDefault(require("node:fs/promises"));
const promises_2 = require("node:timers/promises");
function createNodeDurableFileSystem() {
    return {
        mkdir: async (path, options) => { await promises_1.default.mkdir(path, options); },
        stat: (path) => promises_1.default.stat(path),
        open: async (path, flags, mode) => await promises_1.default.open(path, flags, mode),
        writeFile: async (path, data, options) => { await promises_1.default.writeFile(path, data, options); },
        rename: async (from, to, beforeCommit) => { beforeCommit?.(); await promises_1.default.rename(from, to); },
        unlink: async (path) => { await promises_1.default.unlink(path); },
    };
}
function runNode(command, args, options) {
    return new Promise((resolve) => {
        if (options.signal?.aborted)
            return resolve({ kind: "aborted" });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const child = (0, node_child_process_1.spawn)(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
        const finish = (outcome) => {
            if (settled)
                return;
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
        child.on("error", (error) => finish({ kind: "spawn_failed", code: error.code ?? "unknown", message: error.message }));
        child.on("close", (status) => finish({ kind: "exited", stdout, stderr, status }));
    });
}
exports.nodeHostEnv = {
    durableFs: createNodeDurableFileSystem(),
    clock: {
        now: () => Date.now(),
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) => clearTimeout(handle),
        setInterval: (callback, ms) => setInterval(callback, ms),
        clearInterval: (handle) => clearInterval(handle),
        sleep: (ms, signal) => (0, promises_2.setTimeout)(ms, undefined, { signal }),
        sleepSync: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms)); },
        yield: () => new Promise((resolve) => setImmediate(resolve)),
    },
    random: {
        uuid: () => node_crypto_1.default.randomUUID(),
        float: () => Math.random(),
        bytes: (length) => node_crypto_1.default.randomBytes(length),
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
            }
            catch (error) {
                return error?.code === "EPERM";
            }
        },
        kill: (pid, signal) => { process.kill(pid, signal); },
        generations: process_generation_1.probeProcessGenerations,
        exit: (code) => process.exit(code),
    },
    exec: {
        runSync: (command, args) => {
            const result = (0, node_child_process_1.spawnSync)(command, [...args], { encoding: "utf-8" });
            return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
        },
        run: (command, args, options) => runNode(command, args, options),
    },
    watch: {
        watchDirectory: (directory, listener) => {
            const watcher = node_fs_1.default.watch(directory, (_event, filename) => listener(typeof filename === "string" ? filename : null));
            return { close: () => watcher.close(), onError: (handler) => { watcher.on("error", handler); } };
        },
    },
};
const actorEnv = new node_async_hooks_1.AsyncLocalStorage();
let simulationActive = false;
/** The current actor's host capabilities. */
function hostEnv() {
    const env = actorEnv.getStore();
    if (simulationActive && (!env || env === exports.nodeHostEnv))
        throw new Error("Host access outside a simulated actor.");
    if (env)
        return env;
    return exports.nodeHostEnv;
}
/** Make host access outside an actor fail closed until the returned release runs. */
function enterSimulation() {
    if (simulationActive)
        throw new Error("A simulation is already active in this process.");
    simulationActive = true;
    return () => { simulationActive = false; };
}
/** Run `action` and all its async continuations as one simulated actor. */
function runWithHostEnv(env, action) {
    return actorEnv.run(env, action);
}
