import { vi } from "vitest";
import { nodeHostEnv, type GenerationProbe } from "../src/env/host-env";

/** Configure the async host boundary with per-PID scenario evidence. */
export function mockGenerations(probe: GenerationProbe | ((pid: number) => GenerationProbe)) {
  return vi.spyOn(nodeHostEnv.process, "generations").mockImplementation(async pids =>
    new Map(pids.map(pid => [pid, typeof probe === "function" ? probe(pid) : probe])));
}
