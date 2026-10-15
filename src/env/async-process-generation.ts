import { hostEnv, type GenerationProbe, type HostProcess } from "./host-env";

type Batch = Map<number, Array<(probe: GenerationProbe) => void>>;
const pending = new WeakMap<HostProcess, Batch>();

/** freeze-gen prototype: coalesce same-turn reads, never reuse a completed observation. */
export function readProcessGeneration(pid: number): Promise<GenerationProbe> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return Promise.resolve({ kind: "unknown", reason: "invalid_pid" });
  const process = hostEnv().process;
  let batch = pending.get(process);
  if (!batch) {
    batch = new Map();
    pending.set(process, batch);
    const captured = batch;
    void Promise.resolve().then(async () => {
      // Later requests get fresh evidence even while this invocation is in flight.
      pending.delete(process);
      let probes: Map<number, GenerationProbe>;
      try {
        probes = process.generations ? await process.generations([...captured.keys()])
          : new Map([...captured.keys()].map(pid => [pid, process.generation(pid)]));
      } catch {
        probes = new Map();
      }
      for (const [pid, readers] of captured) {
        const probe = probes.get(pid) ?? { kind: "unknown" as const, reason: "generation_batch_unavailable" };
        for (const resolve of readers) resolve(probe);
      }
    });
  }
  return new Promise(resolve => {
    const readers = batch!.get(pid) ?? [];
    readers.push(resolve); batch!.set(pid, readers);
  });
}
