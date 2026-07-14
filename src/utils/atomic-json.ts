import crypto from "node:crypto";
import fs from "node:fs";
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
export function writeJsonAtomic(file: string, value: unknown): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const existing = fs.existsSync(file) ? fs.statSync(file) : undefined;
  if (existing && !existing.isFile()) throw new Error(`Cannot replace ${file}: existing path is not a regular file.`);
  const mode = existing ? existing.mode & 0o7777 : 0o600;
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.tmp`);
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
