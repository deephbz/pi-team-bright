import { afterEach, expect, it, vi } from "vitest";
import { probeProcessGenerations } from "./process-generation";
import { admitRuntimeStartup } from "../utils/runtime";

// The platform and helper execution errors are synthetic. No native helper is required.
const fixture = vi.hoisted(() => ({ code: "ENOENT" }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<any>(),
  execFile: (_file: string, _args: string[], _options: unknown, callback: Function) => callback(Object.assign(new Error("fixture"), { code: fixture.code }), ""),
}));
const platform = process.platform;
afterEach(() => { Object.defineProperty(process, "platform", { value: platform }); fixture.code = "ENOENT"; });

it("missing macOS helper stays unknown and refuses different-pid admission with the build remedy", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const probe = (await probeProcessGenerations([123])).get(123)!;
  expect(probe).toEqual({ kind: "unknown", reason: "generation_helper_missing" });
  const result = admitRuntimeStartup({ name: "worker", membershipId: "m", sessionFile: "/session" }, "/session",
    { teamName: "team", agentName: "worker", membershipId: "m", pid: 123, startedAt: 1, osBirthToken: "1:2", bootId: "3:4" }, 456, probe);
  expect(result).toMatchObject({ kind: "refused", nextActionHint: "ask_human" });
  if (result.kind !== "refused") throw new Error("Missing helper must refuse admission");
  expect(result.reason).toMatch(/macOS.*helper.*missing/i);
  expect(result.reason).toContain("npm run build:process-generation");
});

it.each([true, false])("admits same-pid bound re-entry without the helper (tokened=%s)", async tokened => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const probe = (await probeProcessGenerations([123])).get(123)!;
  const member = { name: "worker", membershipId: "m", sessionFile: "/session" };
  const status = { teamName: "team", agentName: "worker", membershipId: "m", pid: 123, startedAt: 1,
    ...(tokened ? { osBirthToken: "1:2", bootId: "3:4" } : {}) };
  expect(admitRuntimeStartup(member, "/session", status, 123, probe)).toEqual({ kind: "admitted", action: "already_current" });
  expect(admitRuntimeStartup(member, "/other-session", status, 123, probe)).toMatchObject({ kind: "refused" });
  expect(admitRuntimeStartup(member, "/session", { ...status, membershipId: "other" }, 123, probe)).toMatchObject({ kind: "refused" });
});

it.each([123, 456])("keeps prepared claims fenced without the helper (caller pid=%s)", async pid => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const probe = (await probeProcessGenerations([123])).get(123)!;
  const result = admitRuntimeStartup({ name: "worker", membershipId: "m", pendingLaunchId: "launch" }, "/session",
    { teamName: "team", agentName: "worker", membershipId: "m", pid: 123, startedAt: 1 }, pid, probe, "launch");
  expect(result).toMatchObject({ kind: "refused", nextActionHint: "ask_human" });
  if (result.kind !== "refused") throw new Error("A prepared claim has no bound Session for re-entry");
  expect(result.reason).toContain("npm run build:process-generation");
});

it("does not label execution permission errors as a missing helper", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  fixture.code = "EACCES";
  expect((await probeProcessGenerations([123])).get(123)).toEqual({ kind: "unknown", reason: "generation_helper_unavailable" });
});
