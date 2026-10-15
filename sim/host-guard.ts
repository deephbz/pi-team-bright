import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import timers from "node:timers";
import timerPromises from "node:timers/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import type { DurableFileHandle, DurableFileSystem } from "../src/env/host-env";

interface DescriptorOwner { file: string; actor: string; generation: object }
interface Scope {
  root: string;
  canonicalRoot: string;
  actor?: string;
  generation?: object;
  violations: string[];
  failures: Error[];
  changed: (file: string) => void;
  fds: Map<number, DescriptorOwner>;
  afterFsync: (file: string) => void;
  generationForActor: (actor: string) => object | undefined;
  generationIsLive: (actor: string, generation: object) => boolean;
  scheduleFs: (actor: string, generation: object, label: string, action: () => unknown, onCancel?: () => unknown) => Promise<unknown>;
}
interface EffectOptions {
  paths?: readonly unknown[];
  descriptors?: readonly number[];
  openPathIndex?: number;
  closeDescriptor?: number;
  syncDescriptor?: number;
  mutatePaths?: boolean;
  mutateDescriptors?: boolean;
}
interface SimulatedFileHandle extends DurableFileHandle { readonly fd: number }
const active = new AsyncLocalStorage<Scope>();
const real = {
  exists: fs.existsSync,
  realpath: fs.realpathSync,
  lstat: fs.lstatSync,
  close: fs.closeSync,
  access: fs.accessSync,
  appendFile: fs.appendFileSync,
  chmod: fs.chmodSync,
  chown: fs.chownSync,
  copyFile: fs.copyFileSync,
  cp: fs.cpSync,
  link: fs.linkSync,
  mkdir: fs.mkdirSync,
  mkdtemp: fs.mkdtempSync,
  open: fs.openSync,
  opendir: fs.opendirSync,
  readdir: fs.readdirSync,
  readFile: fs.readFileSync,
  readlink: fs.readlinkSync,
  rename: fs.renameSync,
  rm: fs.rmSync,
  rmdir: fs.rmdirSync,
  stat: fs.statSync,
  symlink: fs.symlinkSync,
  truncate: fs.truncateSync,
  unlink: fs.unlinkSync,
  utimes: fs.utimesSync,
  writeFile: fs.writeFileSync,
  read: fs.readSync,
  write: fs.writeSync,
  writev: fs.writevSync,
  readv: fs.readvSync,
  fstat: fs.fstatSync,
  fsync: fs.fsyncSync,
  fdatasync: fs.fdatasyncSync,
  ftruncate: fs.ftruncateSync,
  fchmod: fs.fchmodSync,
  fchown: fs.fchownSync,
  futimes: fs.futimesSync,
};
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
function assertGeneration(scope: Scope): { actor: string; generation: object } {
  const { actor, generation } = scope;
  if (!actor || !generation) return fail(scope, "Filesystem effect has no actor generation");
  if (!scope.generationIsLive(actor, generation)) return fail(scope, "Stale actor generation attempted a filesystem effect");
  return { actor, generation };
}
function checkPath(scope: Scope, input: unknown): string {
  const name = input instanceof URL ? fileURLToPath(input) : Buffer.isBuffer(input) ? input.toString() : input;
  if (typeof name !== "string") return fail(scope, "Unsupported filesystem path");
  const target = path.resolve(name);
  if (!inside(scope.root, target) && !inside(scope.canonicalRoot, target)) return fail(scope, "Filesystem access outside world root");
  let ancestor = target;
  while (!real.exists(ancestor)) {
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
function checkDescriptor(scope: Scope, fd: number, current: { actor: string; generation: object }): string {
  const owner = scope.fds.get(fd);
  if (!owner) return fail(scope, "Unowned filesystem descriptor");
  if (owner.actor !== current.actor || owner.generation !== current.generation) {
    return fail(scope, "Filesystem descriptor belongs to another actor generation");
  }
  return checkPath(scope, owner.file);
}

/** The single policy boundary for every guarded synchronous filesystem effect. */
function performFsEffect<T>(scope: Scope, options: EffectOptions, action: () => T): T {
  const current = assertGeneration(scope);
  const files = (options.paths ?? []).map(file => checkPath(scope, file));
  const descriptorFiles = (options.descriptors ?? []).map(fd => checkDescriptor(scope, fd, current));
  const result = action();
  if (options.openPathIndex !== undefined) {
    const fd = result as number;
    const file = files[options.openPathIndex];
    if (file === undefined) return fail(scope, "Opened descriptor has no guarded path");
    scope.fds.set(fd, { file, ...current });
  }
  if (options.closeDescriptor !== undefined) scope.fds.delete(options.closeDescriptor);
  if (options.syncDescriptor !== undefined) scope.afterFsync(scope.fds.get(options.syncDescriptor)!.file);
  if (options.mutatePaths) for (const file of files) scope.changed(file);
  if (options.mutateDescriptors) for (const file of descriptorFiles) scope.changed(file);
  return result;
}
function patch(object: object, key: string, wrap: (original: (...args: any[]) => any) => (...args: any[]) => any): void {
  const target = object as Record<string, unknown>;
  const original = target[key];
  if (typeof original !== "function") return;
  target[key] = wrap(original as (...args: any[]) => any);
  undo.push(() => { target[key] = original; });
}
function reject(object: object, key: string, reason: string): void {
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
      if (!scope) return original.apply(this, args);
      const paths = indices.flatMap(index => typeof args[index] === "number" ? [] : [args[index]]);
      const descriptors = indices.flatMap(index => typeof args[index] === "number" ? [args[index] as number] : []);
      const openPathIndex = name === "openSync" ? 0 : undefined;
      return performFsEffect(scope, {
        paths,
        descriptors,
        ...(openPathIndex === undefined ? {} : { openPathIndex }),
        mutatePaths: mutations.has(name),
        mutateDescriptors: mutations.has(name) && descriptors.length > 0,
      }, () => original.apply(this, args));
    });
    reject(fs, name.slice(0, -4), "Async filesystem completion is not scheduled");
  }
  const descriptorOperations: Record<string, { mutation?: boolean; sync?: boolean; close?: boolean }> = {
    readSync: {}, writeSync: { mutation: true }, writevSync: { mutation: true }, readvSync: {}, fstatSync: {},
    fsyncSync: { sync: true }, fdatasyncSync: { sync: true }, ftruncateSync: { mutation: true },
    fchmodSync: { mutation: true }, fchownSync: { mutation: true }, futimesSync: { mutation: true }, closeSync: { close: true },
  };
  for (const [name, operation] of Object.entries(descriptorOperations)) {
    patch(fs, name, original => function(this: unknown, ...args: any[]) {
      const scope = active.getStore();
      if (!scope) return original.apply(this, args);
      const fd = args[0] as number;
      return performFsEffect(scope, {
        descriptors: [fd],
        ...(operation.close ? { closeDescriptor: fd } : {}),
        ...(operation.sync ? { syncDescriptor: fd } : {}),
        mutateDescriptors: operation.mutation,
      }, () => original.apply(this, args));
    });
    reject(fs, name.slice(0, -4), "Async filesystem completion is not scheduled");
  }
  const scheduled: Record<string, (scope: Scope, args: unknown[]) => Promise<unknown>> = {
    mkdir: (scope, [file, options]) => scheduledEffect(scope, "fs.promises.mkdir", { paths: [file], mutatePaths: true }, () => real.mkdir(file as fs.PathLike, options as fs.MakeDirectoryOptions)),
    stat: (scope, [file]) => scheduledEffect(scope, "fs.promises.stat", { paths: [file] }, () => real.stat(file as fs.PathLike)),
    open: async (scope, [file, flags, mode]) => {
      const fd = await scheduledEffect(scope, "fs.promises.open", { paths: [file], openPathIndex: 0 }, () => real.open(file as fs.PathLike, flags as string, mode as number | undefined));
      return scheduledFileHandle(scope, fd);
    },
    writeFile: (scope, [file, data, options]) => scheduledEffect(scope, "fs.promises.writeFile", { paths: [file], mutatePaths: true }, () => real.writeFile(file as fs.PathLike, data as string | Uint8Array, options as fs.WriteFileOptions)),
    rename: (scope, [from, to, beforeCommit]) => scheduledEffect(scope, "fs.promises.rename", { paths: [from, to], mutatePaths: true }, () => {
      if (typeof beforeCommit === "function") (beforeCommit as () => void)();
      return real.rename(from as fs.PathLike, to as fs.PathLike);
    }),
    unlink: (scope, [file]) => scheduledEffect(scope, "fs.promises.unlink", { paths: [file], mutatePaths: true }, () => real.unlink(file as fs.PathLike)),
    chmod: (scope, [file, mode]) => scheduledEffect(scope, "fs.promises.chmod", { paths: [file], mutatePaths: true }, () => real.chmod(file as fs.PathLike, mode as fs.Mode)),
    appendFile: (scope, [file, data, options]) => scheduledEffect(scope, "fs.promises.appendFile", { paths: [file], mutatePaths: true }, () => real.appendFile(file as fs.PathLike, data as string | Uint8Array, options as fs.WriteFileOptions)),
  };
  for (const [name, invoke] of Object.entries(scheduled)) patch(fsp, name, original => function(this: unknown, ...args: unknown[]) {
    const scope = active.getStore();
    if (!scope) return original.apply(this, args);
    return invoke(scope, args);
  });
  for (const name of Object.keys(fsp)) if (!(name in scheduled)) reject(fsp, name, "Async filesystem completion is not scheduled");
  syncBuiltinESMExports();
}

function scheduleCurrent<T>(label: string, options: EffectOptions, action: () => T): Promise<T> {
  const scope = active.getStore();
  if (!scope) return Promise.reject(new Error(`Durable filesystem operation has no actor scope: ${label}`));
  return scheduledEffect(scope, label, options, action);
}

function scheduledEffect<T>(scope: Scope, label: string, options: EffectOptions, action: () => T): Promise<T> {
  let current: { actor: string; generation: object };
  try { current = assertGeneration(scope); } catch (error) { return Promise.reject(error); }
  return scope.scheduleFs(current.actor, current.generation, label, () => performFsEffect(scope, options, action), () => Object.assign(new Error("Scheduled filesystem operation cancelled with its actor"), { code: "ECANCELED" })) as Promise<T>;
}
function scheduledFileHandle(scope: Scope, fd: number): SimulatedFileHandle {
  const run = <T>(name: string, action: () => T, options: EffectOptions = { descriptors: [fd] }): Promise<T> =>
    scheduledEffect(scope, `fs.FileHandle.${name}`, options, action);
  return {
    fd,
    writeFile: data => run("writeFile", () => real.writeFile(fd, data), { descriptors: [fd], mutateDescriptors: true }),
    write: async (buffer, offset, length, position) => {
      const bytesWritten = await run("write", () => real.write(fd, buffer, offset, length, position), { descriptors: [fd], mutateDescriptors: true });
      return { bytesWritten, buffer };
    },
    read: async (buffer, offset, length, position) => {
      const bytesRead = await run("read", () => real.read(fd, buffer, offset, length, position));
      return { bytesRead, buffer };
    },
    sync: () => run("sync", () => real.fsync(fd), { descriptors: [fd], syncDescriptor: fd }),
    stat: () => run("stat", () => real.fstat(fd)),
    truncate: length => run("truncate", () => real.ftruncate(fd, length), { descriptors: [fd], mutateDescriptors: true }),
    chmod: mode => run("chmod", () => real.fchmod(fd, mode), { descriptors: [fd], mutateDescriptors: true }),
    close: () => run("close", () => real.close(fd), { descriptors: [fd], closeDescriptor: fd }),
  };
}

/** The simulator schedules each typed DurableFileSystem operation with all interface arguments intact. */
export function createSimulatedDurableFileSystem(): DurableFileSystem {
  return {
    mkdir: (file, options) => scheduleCurrent("fs.promises.mkdir", { paths: [file], mutatePaths: true }, () => { real.mkdir(file, options); }),
    stat: file => scheduleCurrent("fs.promises.stat", { paths: [file] }, () => real.stat(file)),
    open: async (file, flags, mode) => {
      const scope = active.getStore()!;
      const fd = await scheduledEffect(scope, "fs.promises.open", { paths: [file], openPathIndex: 0 }, () => real.open(file, flags, mode));
      return scheduledFileHandle(scope, fd);
    },
    writeFile: (file, data, options) => scheduleCurrent("fs.promises.writeFile", { paths: [file], mutatePaths: true }, () => { real.writeFile(file, data, options); }),
    rename: (from, to, beforeCommit) => scheduleCurrent("fs.promises.rename", { paths: [from, to], mutatePaths: true }, () => {
      beforeCommit?.();
      return real.rename(from, to);
    }),
    unlink: file => scheduleCurrent("fs.promises.unlink", { paths: [file], mutatePaths: true }, () => real.unlink(file)),
  };
}

/** Guards runtime actor work. Module loading and world setup happen before entering this boundary. */
export class HostGuard {
  readonly violations: string[] = [];
  private readonly failures: Error[] = [];
  private readonly scope: Scope;
  private disposed = false;
  constructor(
    root: string,
    changed: (file: string) => void,
    afterFsync: (file: string) => void = () => {},
    generationForActor: (actor: string) => object | undefined = () => undefined,
    generationIsLive: (actor: string, generation: object) => boolean = () => false,
    scheduleFs: (actor: string, generation: object, label: string, action: () => unknown, onCancel?: () => unknown) => Promise<unknown> = (_actor, _generation, label) => Promise.reject(new Error(`Async filesystem completion has no scheduler: ${label}`)),
  ) {
    this.scope = { root: path.resolve(root), canonicalRoot: real.realpath(root), violations: this.violations, failures: this.failures, changed, fds: new Map(), afterFsync, generationForActor, generationIsLive, scheduleFs };
    if (users++ === 0) install();
  }
  run<T>(action: () => T, actor?: string): T {
    if (this.disposed) throw new Error("World is disposed");
    const generation = actor ? this.scope.generationForActor(actor) : undefined;
    return active.run({ ...this.scope, actor, generation }, action);
  }
  releaseGeneration(actor: string, generation: object): void {
    for (const [fd, owner] of this.scope.fds) {
      if (owner.actor !== actor || owner.generation !== generation) continue;
      try { real.close(fd); } catch {}
      this.scope.fds.delete(fd);
    }
  }
  assertClean(): void {
    if (this.violations.length) throw new Error(`Host escape: ${this.violations.join("; ")}`, { cause: this.failures[0] });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const fd of this.scope.fds.keys()) try { real.close(fd); } catch {}
    this.scope.fds.clear();
    if (--users === 0) { for (const restore of undo.reverse()) restore(); undo = []; syncBuiltinESMExports(); }
  }
}
