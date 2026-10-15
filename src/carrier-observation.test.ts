import { expect, it } from "vitest";
import { deriveCarrierView } from "./carrier-observation";
import type { GenerationProbe } from "./env/host-env";
import type { Member } from "./team-authority/contracts";

it("a surviving shell never establishes process liveness, while shutdown is stopping intent", () => {
  const member = { name: "worker", membershipId: "m", sessionFile: "/session", terminalTarget: { backend: "herdr", kind: "pane", targetId: "p" } } as Member;
  const status = { teamName: "team", agentName: "worker", membershipId: "m", pid: 123, startedAt: 1, osBirthToken: "a", bootId: "b" };
  const live: GenerationProbe = { kind: "found", generation: { pid: 123, osBirthToken: "a", bootId: "b" } };
  expect(deriveCarrierView(member, null, 3, live).process).toBe("unknown");
  expect(deriveCarrierView(member, status, 3, live).process).toBe("live");
  const stopped = { ...status, lastStop: { piReason: "quit" as const, observedAt: 2, suspectedHumanStop: true as const } };
  expect(deriveCarrierView(member, stopped, 3, live).process).toBe("stopping");
  expect(deriveCarrierView(member, stopped, 3, { kind: "absent" }).process).toBe("gone");
});
