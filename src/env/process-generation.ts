import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { GenerationProbe } from "./host-env";

/** Field 22 follows a parenthesized comm which can itself contain spaces and ')'. */
export function linuxStartToken(stat: string): string | undefined {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  return /^\d+$/.test(fields[19] ?? "") ? fields[19] : undefined;
}

export function probeProcessGeneration(pid: number): GenerationProbe {
  if (!Number.isSafeInteger(pid) || pid <= 1) return { kind: "unknown", reason: "invalid_pid" };
  try {
    if (process.platform === "linux") {
      const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const osBirthToken = linuxStartToken(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
      return bootId && osBirthToken ? { kind: "found", generation: { pid, osBirthToken, bootId } }
        : { kind: "unknown", reason: "malformed_proc_stat" };
    }
    if (process.platform === "darwin") {
      const helper = path.resolve(__dirname, "../../native/bin/process-generation");
      const result = spawnSync(helper, [String(pid)], { encoding: "utf8", timeout: 2000 });
      if (result.error || result.status !== 0) return { kind: "unknown", reason: "generation_helper_unavailable" };
      const [id, state, osBirthToken, bootId] = result.stdout.trim().split(/\s+/);
      if (id !== String(pid)) return { kind: "unknown", reason: "malformed_generation_reply" };
      if (state === "absent") return { kind: "absent" };
      if (state === "found" && /^\d+:\d+$/.test(osBirthToken ?? "") && /^\d+:\d+$/.test(bootId ?? "")) {
        return { kind: "found", generation: { pid, osBirthToken, bootId } };
      }
    }
    return { kind: "unknown", reason: "generation_verifier_unavailable" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? { kind: "absent" }
      : { kind: "unknown", reason: code ?? "generation_read_failed" };
  }
}
