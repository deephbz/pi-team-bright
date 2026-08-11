import { expect, test } from "vitest";
import { captureToolCase, type RegisteredTool } from "./harness";

test("reuses the prior sequential oracle state and still reads post-call state", async () => {
  let snapshots = 0;
  let executedWith: AbortSignal | undefined;
  const signal = AbortSignal.abort();
  const tool: RegisteredTool = {
    name: "qa_fixture_tool",
    async execute(_id, _args, receivedSignal) {
      executedWith = receivedSignal;
      return { content: [{ type: "text", text: "ok" }], details: { kind: "captured" } };
    },
  };

  const priorState = { revision: "before" };
  const result = await captureToolCase({
    id: "reuse-prior-state",
    scenario: "fixture",
    actor: "team-lead",
    tool,
    args: {},
    context: {},
    qaBrief: {
      situation: "A prior fixture call already read authority state.",
      agentNextDecision: "Use the captured result.",
      humanQuestion: "Did the capture preserve its boundaries?",
      requiredAgentFacts: [],
      machineEvidence: [],
      agentNoiseCandidates: [],
    },
    before: priorState,
    snapshot: async () => ({ revision: `after-${++snapshots}` }),
    signal,
  });

  expect(snapshots).toBe(1);
  expect(result.oracle).toEqual({ before: priorState, after: { revision: "after-1" } });
  expect(executedWith).toBe(signal);
});
