import { hostEnv } from "../env/host-env";
import path from "node:path";

async function fsyncDirectory(directory: string): Promise<void> {
  try {
    const handle = await hostEnv().durableFs.open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch {
    // Directory fsync is not available on every supported filesystem.
  }
}

/** Replace one JSON authority/projection file without exposing partial JSON. */
export async function writeJsonAtomicAsync(file: string, value: unknown, beforeCommit?: () => void): Promise<void> {
  const durableFs = hostEnv().durableFs;
  const directory = path.dirname(file);
  await durableFs.mkdir(directory, { recursive: true });
  let existing: Awaited<ReturnType<typeof durableFs.stat>> | undefined;
  try { existing = await durableFs.stat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing && !existing.isFile()) throw new Error(`Cannot replace ${file}: existing path is not a regular file.`);
  const mode = existing ? Number(existing.mode) & 0o7777 : 0o600;
  const temp = path.join(directory, `.${path.basename(file)}.${hostEnv().process.pid}.${hostEnv().clock.now()}.${hostEnv().random.bytes(6).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof durableFs.open>> | undefined;
  try {
    handle = await durableFs.open(temp, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
    if (mode !== 0o600) await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await durableFs.rename(temp, file, beforeCommit);
    await fsyncDirectory(directory);
  } catch (error) {
    if (handle) try { await handle.close(); } catch {}
    try { await durableFs.unlink(temp); } catch {}
    throw error;
  }
}
