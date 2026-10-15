import { hostEnv } from "../env/host-env";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

function fsyncDirectory(directory: string): void {
  try {
    const fd = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Directory fsync is not available on every supported filesystem.
  }
}

/** Replace one JSON authority/projection file without exposing partial JSON. */
export async function writeJsonAtomicAsync(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file);
  await fsp.mkdir(directory, { recursive: true });
  let existing: Awaited<ReturnType<typeof fsp.stat>> | undefined;
  try { existing = await fsp.stat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing && !existing.isFile()) throw new Error(`Cannot replace ${file}: existing path is not a regular file.`);
  const mode = existing ? Number(existing.mode) & 0o7777 : 0o600;
  const temp = path.join(directory, `.${path.basename(file)}.${hostEnv().process.pid}.${hostEnv().clock.now()}.${hostEnv().random.bytes(6).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    handle = await fsp.open(temp, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
    if (mode !== 0o600) await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.rename(temp, file);
    try {
      const directoryHandle = await fsp.open(directory, "r");
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } catch { /* Directory fsync is not available on every supported filesystem. */ }
  } catch (error) {
    if (handle) try { await handle.close(); } catch {}
    try { await fsp.unlink(temp); } catch {}
    throw error;
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const existing = fs.existsSync(file) ? fs.statSync(file) : undefined;
  if (existing && !existing.isFile()) throw new Error(`Cannot replace ${file}: existing path is not a regular file.`);
  const mode = existing ? existing.mode & 0o7777 : 0o600;
  const temp = path.join(directory, `.${path.basename(file)}.${hostEnv().process.pid}.${hostEnv().clock.now()}.${hostEnv().random.bytes(6).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
    if (mode !== 0o600) fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    fsyncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}
