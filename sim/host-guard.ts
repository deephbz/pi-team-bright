import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import timers from "node:timers";
import timerPromises from "node:timers/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

interface Scope { root: string; canonicalRoot: string; violations: string[]; failures: Error[]; changed: (file: string) => void; fds: Set<number> }
const active = new AsyncLocalStorage<Scope>();
const real = { exists: fs.existsSync, realpath: fs.realpathSync, lstat: fs.lstatSync };
let users = 0;
let undo: Array<() => void> = [];

function fail(scope: Scope, message: string): never {
  scope.violations.push(message);
  const error = new Error(message);
  scope.failures.push(error);
  throw error;
}
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function checkPath(scope: Scope, input: unknown): string {
  if (typeof input === "number") {
    if (!scope.fds.has(input)) fail(scope, "Unowned filesystem descriptor");
    return "";
  }
  const name = input instanceof URL ? fileURLToPath(input) : Buffer.isBuffer(input) ? input.toString() : input;
  if (typeof name !== "string") return fail(scope, "Unsupported filesystem path");
  const target = path.resolve(name);
  if (!inside(scope.root, target) && !inside(scope.canonicalRoot, target)) return fail(scope, "Filesystem access outside world root");
  let ancestor = target;
  while (!real.exists(ancestor)) {
    // A dangling symlink must not become a future escape.
    try { if (real.lstat(ancestor).isSymbolicLink()) return fail(scope, "Dangling world symlink"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (!inside(scope.canonicalRoot, real.realpath(ancestor))) return fail(scope, "Filesystem symlink escapes world root");
  return target;
}
function patch(object: any, key: string, wrap: (original: (...args: any[]) => any) => (...args: any[]) => any): void {
  const original = object[key];
  if (typeof original !== "function") return;
  object[key] = wrap(original);
  undo.push(() => { object[key] = original; });
}
function reject(object: any, key: string, reason: string): void {
  patch(object, key, original => function(this: unknown, ...args: any[]) {
    const scope = active.getStore();
    if (scope) fail(scope, `${reason}: ${key}`);
    return original.apply(this, args);
  });
}
function install(): void {
  for (const target of [globalThis, timers]) for (const name of ["setTimeout", "setInterval", "setImmediate"]) reject(target, name, "Real timer");
  for (const name of ["setTimeout", "setInterval", "setImmediate"]) reject(timerPromises, name, "Real timer");
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) reject(childProcess, name, "Real subprocess");
  for (const name of ["watch", "watchFile", "createReadStream", "createWriteStream"]) reject(fs, name, "Uncontrolled filesystem operation");
  const paths: Record<string, number[]> = {
    accessSync: [0], appendFileSync: [0], chmodSync: [0], chownSync: [0], copyFileSync: [0, 1], cpSync: [0, 1],
    existsSync: [0], lstatSync: [0], linkSync: [0, 1], mkdirSync: [0], mkdtempSync: [0], openSync: [0],
    opendirSync: [0], readdirSync: [0], readFileSync: [0], readlinkSync: [0], realpathSync: [0], renameSync: [0, 1],
    rmSync: [0], rmdirSync: [0], statSync: [0], symlinkSync: [0, 1], truncateSync: [0], unlinkSync: [0], utimesSync: [0], writeFileSync: [0],
  };
  const mutations = new Set(["appendFileSync", "copyFileSync", "cpSync", "mkdirSync", "renameSync", "rmSync", "rmdirSync", "truncateSync", "unlinkSync", "writeFileSync"]);
  for (const [name, indices] of Object.entries(paths)) {
    patch(fs, name, original => function(this: unknown, ...args: any[]) {
      const scope = active.getStore();
      const checked = scope ? indices.map(index => checkPath(scope, args[index])) : [];
      const result = original.apply(this, args);
      if (scope && name === "openSync") scope.fds.add(result);
      if (scope && mutations.has(name)) for (const file of checked) if (file) scope.changed(file);
      return result;
    });
    reject(fs, name.slice(0, -4), "Async filesystem completion is not scheduled");
  }
  for (const name of ["readSync", "writeSync", "writevSync", "readvSync", "fstatSync", "fsyncSync", "fdatasyncSync", "ftruncateSync", "fchmodSync", "fchownSync", "futimesSync", "closeSync"]) {
    patch(fs, name, original => function(this: unknown, ...args: any[]) {
      const scope = active.getStore();
      if (scope) checkPath(scope, args[0]);
      const result = original.apply(this, args);
      if (scope && name === "closeSync") scope.fds.delete(args[0]);
      return result;
    });
    reject(fs, name.slice(0, -4), "Async filesystem completion is not scheduled");
  }
  for (const name of Object.keys(fsp)) reject(fsp, name, "Async filesystem completion is not scheduled");
  syncBuiltinESMExports();
}

/** Guards runtime actor work. Module loading and world setup happen before entering this boundary. */
export class HostGuard {
  readonly violations: string[] = [];
  private readonly failures: Error[] = [];
  private readonly scope: Scope;
  private disposed = false;
  constructor(root: string, changed: (file: string) => void) {
    this.scope = { root: path.resolve(root), canonicalRoot: real.realpath(root), violations: this.violations, failures: this.failures, changed, fds: new Set() };
    if (users++ === 0) install();
  }
  run<T>(action: () => T): T {
    if (this.disposed) throw new Error("World is disposed");
    return active.run(this.scope, action);
  }
  assertClean(): void { if (this.violations.length) throw new Error(`Host escape: ${this.violations.join("; ")}`, { cause: this.failures[0] }); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (--users === 0) { for (const restore of undo.reverse()) restore(); undo = []; syncBuiltinESMExports(); }
  }
}
