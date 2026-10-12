import { expect, it } from "vitest";
import { deriveCarrierView } from "./carrier-observation";
import { nodeHostEnv, runWithHostEnv } from "./env/host-env";
import type { Member } from "./team-authority/contracts";

it("a surviving shell never establishes process liveness, while shutdown is stopping intent", () => {
  const member = { name: "worker", membershipId: "m", sessionFile: "/session", terminalTarget: { backend: "herdr", kind: "pane", targetId: "p" } } as Member;
  const status = { teamName: "team", agentName: "worker", membershipId: "m", pid: 123, startedAt: 1, osBirthToken: "a", bootId: "b" };
  runWithHostEnv({ ...nodeHostEnv, process: { ...nodeHostEnv.process, generation: () => ({ kind: "found", generation: { pid: 123, osBirthToken: "a", bootId: "b" } }) } }, () => {
    expect(deriveCarrierView(member, null).process).toBe("unknown");
    expect(deriveCarrierView(member, status).process).toBe("live");
    expect(deriveCarrierView(member, { ...status, lastStop: { piReason: "quit", observedAt: 2, suspectedHumanStop: true } }).process).toBe("stopping");
  });
  runWithHostEnv({ ...nodeHostEnv, process: { ...nodeHostEnv.process, generation: () => ({ kind: "absent" }) } }, () => {
    expect(deriveCarrierView(member, { ...status, lastStop: { piReason: "quit", observedAt: 2, suspectedHumanStop: true } }).process).toBe("gone");
  });
});
