import { afterEach, expect, it, vi } from "vitest";
import { probeProcessGeneration, probeProcessGenerations } from "./process-generation";
import { admitRuntimeStartup } from "../utils/runtime";
import { nodeHostEnv, runWithHostEnv } from "./host-env";

const fixture = vi.hoisted(() => ({ code: "ENOENT" }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<any>(),
  spawnSync: () => ({ error: Object.assign(new Error("fixture"), { code: fixture.code }), status: null, stdout: "" }),
  execFile: (_file: string, _args: string[], _options: unknown, callback: Function) => callback(Object.assign(new Error("fixture"), { code: fixture.code }), ""),
}));
const platform = process.platform;
afterEach(() => { Object.defineProperty(process, "platform", { value: platform }); fixture.code = "ENOENT"; });

it("missing macOS helper stays unknown in single and batch probes and names the startup remedy", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const expected = { kind: "unknown", reason: "generation_helper_missing" };
  expect(probeProcessGeneration(123)).toEqual(expected);
  expect((await probeProcessGenerations([123])).get(123)).toEqual(expected);
  runWithHostEnv({ ...nodeHostEnv, process: { ...nodeHostEnv.process, generation: probeProcessGeneration } }, () => {
    const result = admitRuntimeStartup({ name: "worker", membershipId: "m", sessionFile: "/session" }, "/session",
      { teamName: "team", agentName: "worker", membershipId: "m", pid: 123, startedAt: 1, osBirthToken: "1:2", bootId: "3:4" }, 456);
    expect(result).toMatchObject({ kind: "refused", nextActionHint: "ask_human" });
    if (result.kind !== "refused") throw new Error("Missing helper must refuse admission");
    expect(result.reason).toMatch(/macOS.*helper.*missing/i);
    expect(result.reason).toContain("npm run build:process-generation");
  });
});

it("does not label execution permission errors as a missing helper", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  fixture.code = "EACCES";
  expect(probeProcessGeneration(123)).toEqual({ kind: "unknown", reason: "generation_helper_unavailable" });
  expect((await probeProcessGenerations([123])).get(123)).toEqual({ kind: "unknown", reason: "generation_helper_unavailable" });
});
