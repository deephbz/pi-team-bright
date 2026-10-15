import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { GenerationProbe } from "./host-env";

export const MISSING_GENERATION_HELPER_MESSAGE = "The macOS process-generation helper is missing. Install Rust (rustc) and Xcode Command Line Tools, then run npm run build:process-generation in the installed @hypercarrier/pi-team-bright directory. Retry after the build.";
const helperFailure = (error: (Error & { code?: string | number | null }) | null | undefined): GenerationProbe => ({ kind: "unknown",
  reason: error?.code === "ENOENT" ? "generation_helper_missing" : "generation_helper_unavailable" });

/** Field 22 follows a parenthesized comm which can itself contain spaces and ')'. */
export function linuxStartToken(stat: string): string | undefined {
  if (!/^\d+ \(/.test(stat) || stat.lastIndexOf(")") < 0) return undefined;
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  return /^\d+$/.test(fields[19] ?? "") ? fields[19] : undefined;
}

function parseReply(pid: number, line: string): GenerationProbe {
  const [id, state, osBirthToken, bootId] = line.trim().split(/\s+/);
  if (id !== String(pid)) return { kind: "unknown", reason: "malformed_generation_reply" };
  if (state === "absent") return { kind: "absent" };
  if (state === "found" && /^\d+:\d+$/.test(osBirthToken ?? "") && /^\d+:\d+$/.test(bootId ?? "")) return { kind: "found", generation: { pid, osBirthToken, bootId } };
  return { kind: "unknown", reason: "generation_verifier_unavailable" };
}

/** A poll uses one bounded helper invocation for the whole Team. */
export async function probeProcessGenerations(pids: readonly number[]): Promise<Map<number, GenerationProbe>> {
  const unique = [...new Set(pids)].filter(pid => Number.isSafeInteger(pid) && pid > 1);
  if (!unique.length) return new Map();
  const platform = process.platform;
  if (platform === "linux") {
    let bootId: string;
    try { bootId = (await fs.promises.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(); }
    catch { return new Map(unique.map(pid => [pid, { kind: "unknown", reason: "boot_identity_unavailable" }])); }
    return new Map(await Promise.all(unique.map(async pid => {
      let probe: GenerationProbe;
      try {
        const token = linuxStartToken(await fs.promises.readFile(`/proc/${pid}/stat`, "utf8"));
        probe = bootId && token ? { kind: "found", generation: { pid, osBirthToken: token, bootId } }
          : { kind: "unknown", reason: "malformed_proc_stat" };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        probe = code === "ENOENT" || code === "ESRCH" ? { kind: "absent" } : { kind: "unknown", reason: code ?? "generation_read_failed" };
      }
      return [pid, probe] as const;
    })));
  }
  if (platform !== "darwin") return new Map(unique.map(pid => [pid, { kind: "unknown", reason: "generation_verifier_unavailable" }]));
  const helper = path.resolve(__dirname, "../../native/bin/process-generation");
  return new Promise(resolve => {
    execFile(helper, unique.map(String), { encoding: "utf8", timeout: 2000 }, (error, stdout) => {
      const lines = new Map(String(stdout ?? "").trim().split("\n").map(line => [Number(line.split(/\s+/)[0]), line]));
      resolve(new Map(unique.map(pid => [pid, error ? helperFailure(error) : parseReply(pid, lines.get(pid) ?? "")])));
    });
  });
}
