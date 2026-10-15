/** Throwaway freeze-gen benchmark. Probes only its own sleep children; never reads Team state. */
import { spawn, execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { probeProcessGeneration } from "../../src/env/process-generation";
import type { GenerationProbe } from "../../src/env/host-env";

async function main() {
  const mode = process.argv[2] ?? "sync";
  const rounds = Number(process.argv[3] ?? 10);
  const children = Array.from({ length: 50 }, () => spawn("/bin/sleep", ["120"], { stdio: "ignore" }));
  try {
    await Promise.all(children.map(child => new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); })));
    const asyncProbe: ((pid: number) => Promise<GenerationProbe>) | undefined = mode === "sync" ? undefined : require("../../src/env/async-process-generation").readProcessGeneration;
    const samples: unknown[] = [];
    for (const count of [17, 50]) {
      const pids = children.slice(0, count).map(child => child.pid!);
      for (let round = 0; round < rounds; round++) {
        for (const variant of (asyncProbe ? ["sync", "async"] : ["sync"])) {
          const uptime = execFileSync("uptime", { encoding: "utf8" }).trim();
          const start = performance.now();
          const timer = new Promise<number>(resolve => setTimeout(() => resolve(performance.now() - start), 0));
          const probes: GenerationProbe[] = variant === "sync" ? pids.map(probeProcessGeneration) : await Promise.all(pids.map(asyncProbe!));
          const wallMs = performance.now() - start;
          const timerLagMs = await timer;
          if (probes.some((probe, i) => probe.kind !== "found" || probe.generation.pid !== pids[i])) throw new Error("Own child generation was not found");
          samples.push({ count, round, variant, uptime, expectedHelperInvocations: variant === "sync" ? count : 1, wallMs, timerLagMs, found: probes.length });
        }
      }
    }
    console.log(JSON.stringify({ prototype: "freeze-gen", node: process.version, platform: process.platform, rounds, samples }, null, 2));
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise(resolve => child.once("exit", resolve))));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
