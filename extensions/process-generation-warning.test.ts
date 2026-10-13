import { afterEach, expect, it, vi } from "vitest";
import { nodeHostEnv, runWithHostEnv, type GenerationProbe } from "../src/env/host-env";
import { createProcessGenerationWarning } from "./process-generation-warning";

afterEach(() => vi.restoreAllMocks());

it.each([
  { kind: "found", generation: { pid: 42, osBirthToken: "birth", bootId: "boot" } },
  { kind: "unknown", reason: "generation_helper_unavailable" },
] satisfies GenerationProbe[])("does not claim the helper is missing for $kind evidence", probe => {
  const notify = vi.fn(), stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  runWithHostEnv({ ...nodeHostEnv, process: { ...nodeHostEnv.process, platform: "darwin", generation: () => probe } }, () => {
    createProcessGenerationWarning()({ ui: { notify } });
  });
  expect(notify).not.toHaveBeenCalled(); expect(stderr).not.toHaveBeenCalled();
});

it.each(["headless", "UI failure"])("uses one stderr diagnostic on %s and never fails startup", mode => {
  const notify = vi.fn(() => { throw new Error("UI unavailable"); });
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  runWithHostEnv({ ...nodeHostEnv, process: { ...nodeHostEnv.process, platform: "darwin",
    generation: () => ({ kind: "unknown", reason: "generation_helper_missing" }) } }, () => {
    const warn = createProcessGenerationWarning(), ctx = { hasUI: mode !== "headless", ui: { notify } };
    warn(ctx); warn(ctx);
    expect(stderr).toHaveBeenCalledOnce();
    expect(stderr.mock.calls[0][0]).toContain("npm run build:process-generation");
    stderr.mockImplementation(() => { throw new Error("stderr unavailable"); });
    expect(() => createProcessGenerationWarning()(ctx)).not.toThrow();
  });
  expect(stdout).not.toHaveBeenCalled();
});
