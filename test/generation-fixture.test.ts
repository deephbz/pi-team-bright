import { expect, it, vi } from "vitest";
import { hostEnv } from "../src/env/host-env";

it("keeps single and batch generation probes synthetic after spy restore and module reset", async () => {
  const probe = hostEnv().process;
  const override = vi.spyOn(probe, "generation").mockReturnValue({ kind: "absent" });
  expect((await probe.generations!([process.pid])).get(process.pid)).toEqual({ kind: "absent" });
  override.mockRestore();
  vi.resetModules();
  const reloaded = (await import("../src/env/host-env")).hostEnv().process;
  for (const processProbe of [probe, reloaded]) {
    expect(processProbe.generation(process.pid)).toEqual({ kind: "found", generation: {
      pid: process.pid, osBirthToken: "fixture-birth", bootId: "fixture-boot",
    } });
    expect((await processProbe.generations!([process.pid])).get(process.pid)).toEqual(processProbe.generation(process.pid));
    expect(processProbe.generation(2147483647)).toEqual({ kind: "unknown", reason: "unit_fixture_unconfigured_pid" });
  }
});
