import { describe, expect, it } from "vitest";
import { linuxStartToken } from "./process-generation";
import { nodeHostEnv, runWithHostEnv, type GenerationProbe } from "./host-env";
import { admitRuntimeStartup, verifyRuntimeGeneration } from "../utils/runtime";

describe("OS generation identity", () => {
  it("parses field 22 after comm containing spaces and closing parentheses", () => {
    expect(linuxStartToken(`123 (a ) b) S ${Array(18).fill("0").join(" ")} 91827 0`)).toBe("91827");
  });
  it("rejects same-second PID reuse and preserves uncertainty", () => {
    const status = { teamName: "team", agentName: "worker", membershipId: "m", pid: 123, startedAt: 1, osBirthToken: "42:100", bootId: "boot" };
    const member = { name: "worker", membershipId: "m", sessionFile: "/session" };
    const check = (result: GenerationProbe, expected: string) => runWithHostEnv({ ...nodeHostEnv, process: { ...nodeHostEnv.process, generation: () => result } }, () => {
      expect(verifyRuntimeGeneration(status)).toBe(expected);
      expect(verifyRuntimeGeneration({ pid: 123 })).toBe("unknown");
      if (expected === "gone") expect(admitRuntimeStartup(member, "/session", status, 456).kind).toBe("admitted");
      else expect(admitRuntimeStartup(member, "/session", status, 456).kind).toBe("refused");
    });
    check({ kind: "found", generation: { pid: 123, osBirthToken: "42:101", bootId: "boot" } }, "gone");
    check({ kind: "found", generation: { pid: 123, osBirthToken: "42:100", bootId: "boot" } }, "live");
    check({ kind: "absent" }, "gone");
    check({ kind: "unknown", reason: "permission" }, "unknown");
  });
});
