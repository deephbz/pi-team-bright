import { beforeEach, expect, it, vi } from "vitest";
import { nodeHostEnv, runWithHostEnv } from "../env/host-env";
const f = vi.hoisted(() => ({ member: {} as any, status: {} as any, rows: [] as any[], beforeLease: undefined as undefined | (() => void), write: vi.fn() }));
vi.mock("../utils/teams", () => ({ currentMembership: async () => structuredClone(f.member), withCurrentMembershipLease: async (_: string, id: string, fn: any) => { f.beforeLease?.(); return fn(f.member); } }));
vi.mock("../utils/runtime", () => ({ readRuntimeStatus: async () => structuredClone(f.status), writeRuntimeStatus: (...args: unknown[]) => f.write(...args) }));
vi.mock("../carrier-observation", () => ({ herdrList: async () => f.rows }));
import { adoptLegacyGeneration } from "./legacy-generation-adoption";
beforeEach(() => {
  f.member = { membershipId: "m", sessionFile: "/session", terminalTarget: { targetId: "pane" } };
  f.status = { membershipId: "m", pid: 42, startedAt: 100 };
  f.rows = [{ name: "team-worker", pane_id: "pane", agent_session: "/session" }];
  f.beforeLease = undefined; f.write.mockReset();
});
const adopt = (generation = vi.fn(() => ({ kind: "found" as const, generation: { pid: 42, osBirthToken: "birth", bootId: "boot" } }))) => runWithHostEnv({ ...nodeHostEnv, process: { ...nodeHostEnv.process, generation } }, () => adoptLegacyGeneration("team", "worker", "m"));
it("adopts a tokenless generation only after exact Herdr and process checks", async () => {
  expect(await adopt()).toBe(true);
  expect(f.write).toHaveBeenCalledWith("team", "worker", { osBirthToken: "birth", bootId: "boot" }, "m");
});
it.each(["session", "pane", "stop", "generation"])("refuses adoption when %s changes during verification", async field => {
  f.beforeLease = () => {
    if (field === "session") f.member.sessionFile = "/successor";
    if (field === "pane") f.member.terminalTarget.targetId = "successor";
    if (field === "stop") f.status.lastStop = { piReason: "quit" };
    if (field === "generation") f.status.startedAt++;
  };
  expect(await adopt()).toBe(false); expect(f.write).not.toHaveBeenCalled();
});
it("refuses a mismatched Herdr Session or reused PID", async () => {
  f.rows[0].agent_session = "/other";
  expect(await adopt()).toBe(false);
  f.rows[0].agent_session = "/session";
  const probe = vi.fn().mockReturnValueOnce({ kind: "found", generation: { pid: 42, osBirthToken: "old", bootId: "boot" } }).mockReturnValue({ kind: "found", generation: { pid: 42, osBirthToken: "new", bootId: "boot" } });
  expect(await adopt(probe)).toBe(false); expect(f.write).not.toHaveBeenCalled();
});
