import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { probeProcessGenerations } from "./process-generation";

const platform = process.platform;
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", { value: platform }); });

it("reads Linux boot identity once and each distinct PID asynchronously with exact uncertainty", async () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  const read = vi.spyOn(fs.promises, "readFile").mockImplementation(async file => {
    if (String(file).endsWith("boot_id")) return "boot\n";
    if (String(file) === "/proc/42/stat") return `42 (a ) b) S ${Array(18).fill("0").join(" ")} 91827 0`;
    if (String(file) === "/proc/43/stat") throw Object.assign(new Error("gone"), { code: "ENOENT" });
    if (String(file) === "/proc/44/stat") throw Object.assign(new Error("denied"), { code: "EACCES" });
    return "malformed";
  });
  const probes = await probeProcessGenerations([42, 43, 44, 45, 42, 0]);
  expect(read).toHaveBeenCalledTimes(5);
  expect([...probes]).toEqual([
    [42, { kind: "found", generation: { pid: 42, osBirthToken: "91827", bootId: "boot" } }],
    [43, { kind: "absent" }], [44, { kind: "unknown", reason: "EACCES" }],
    [45, { kind: "unknown", reason: "malformed_proc_stat" }],
  ]);
});

it("keeps every Linux PID unknown when boot identity cannot be read", async () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  const read = vi.spyOn(fs.promises, "readFile").mockRejectedValue(new Error("offline"));
  expect([...await probeProcessGenerations([42, 43])].map(([, probe]) => probe)).toEqual([
    { kind: "unknown", reason: "boot_identity_unavailable" }, { kind: "unknown", reason: "boot_identity_unavailable" },
  ]);
  expect(read).toHaveBeenCalledOnce();
});
