import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { DurableGraphTaskAuthority } from "../../src/adapters/durable-graph-task-authority";
import { GraphControlRefusal, GraphTaskController, type GraphTaskDefinitionInput } from "../../src/task-authority/graph-control";
import { graphTaskAuthorityPath, teamDir } from "../../src/utils/paths";

const teams: string[] = [];
afterEach(() => {
  for (const team of teams.splice(0)) fs.rmSync(teamDir(team), { force: true, recursive: true });
});

const twoTaskGraph: GraphTaskDefinitionInput[] = [
  { key: "a", title: "A", goal: "Pass A.", assignee: "alice" },
  { key: "b", title: "B", goal: "Pass B.", assignee: "bob", needs: ["a"], onGoalFailed: { target: "a", maxTraversals: 1 } },
];

type Action = "claim-a" | "pass-a" | "claim-b" | "pass-b" | "fail-b" | "revise-a";
const alphabet: Action[] = ["claim-a", "pass-a", "claim-b", "pass-b", "fail-b", "revise-a"];

function checkAcceptedLineage(controller: GraphTaskController): void {
  const a = controller.readTask("a");
  const b = controller.readTask("b");
  const currentB = controller.readAttempts("b").find(attempt => attempt.current);
  if (b.state.kind === "in_progress" || b.state.kind === "goal_achieved" || b.state.kind === "goal_failed") {
    if (b.state.kind === "goal_failed" && "prerequisiteTaskIds" in b.state) return;
    expect(a.state.kind).toBe("goal_achieved");
    expect(currentB?.inputAttemptIds.a).toBe(a.acceptedAttemptId);
  }
  if (a.state.kind !== "goal_achieved") {
    expect(b.state.kind).not.toBe("goal_achieved");
    expect(currentB).toBeUndefined();
  }
}

function runTrace(trace: readonly Action[]): number {
  let controller = new GraphTaskController();
  controller.applyGraph({ operationId: "initial", tasks: twoTaskGraph });
  let accepted = 0;
  for (const [index, action] of trace.entries()) {
    const before = controller.snapshot();
    const taskId = action.endsWith("a") ? "a" : "b";
    const task = controller.readTask(taskId);
    try {
      if (action === "revise-a") {
        controller.applyGraph({
          operationId: `op-${index}`,
          expectedGraphVersion: controller.currentGraphVersion(),
          tasks: twoTaskGraph.map(definition => definition.key === "a"
            ? { ...definition, goal: `Pass A revision ${index}.` }
            : definition),
        });
      } else {
        const transition = action.startsWith("claim") ? "claim"
          : action.startsWith("fail") ? "goal_failed" : "goal_achieved";
        controller.transition({
          taskId,
          operationId: `op-${index}`,
          expectedVersion: task.version,
          transition,
          worker: task.assignee,
          ...(transition === "claim" ? {} : { evidence: `Observed ${action}.` }),
        });
      }
      accepted += 1;
    } catch (error) {
      expect(error).toBeInstanceOf(GraphControlRefusal);
      expect(controller.snapshot()).toEqual(before);
    }
    checkAcceptedLineage(controller);
    controller = GraphTaskController.recover(controller.snapshot());
    checkAcceptedLineage(controller);
  }
  return accepted;
}

describe("independent bounded graph adversary", () => {
  it("binds prerequisite Attempt lineage for a legal JavaScript special key", () => {
    const controller = new GraphTaskController();
    controller.applyGraph({ operationId: "initial", tasks: [
      { key: "__proto__", title: "Foundation", goal: "Pass.", assignee: "alice" },
      { key: "dependent", title: "Dependent", goal: "Use the foundation.", assignee: "bob", needs: ["__proto__"] },
    ] });
    const prerequisite = controller.readTask("__proto__");
    controller.transition({ taskId: "__proto__", operationId: "claim", expectedVersion: prerequisite.version, transition: "claim", worker: "alice" });
    controller.transition({
      taskId: "__proto__", operationId: "pass", expectedVersion: controller.readTask("__proto__").version,
      transition: "goal_achieved", worker: "alice", evidence: "Foundation passed.",
    });
    const dependent = controller.readTask("dependent");
    expect(dependent.state.kind).toBe("ready");
    controller.transition({ taskId: "dependent", operationId: "claim-dependent", expectedVersion: dependent.version, transition: "claim", worker: "bob" });
    const [attempt] = controller.readAttempts("dependent");
    expect(Object.hasOwn(attempt.inputAttemptIds, "__proto__")).toBe(true);
    expect(attempt.inputAttemptIds["__proto__"]).toBe(controller.readTask("__proto__").acceptedAttemptId);
  });

  it("keeps accepted dependency Attempt lineage across every length-four action word", () => {
    // All 6^4 words. Rejected words remain in the search because refusal must be atomic.
    let accepted = 0;
    for (let code = 0; code < alphabet.length ** 4; code += 1) {
      let value = code;
      const trace: Action[] = [];
      for (let step = 0; step < 4; step += 1) {
        trace.push(alphabet[value % alphabet.length]);
        value = Math.floor(value / alphabet.length);
      }
      accepted += runTrace(trace);
    }
    expect(accepted).toBeGreaterThan(500);
  });

  it("serializes conflicting durable claims and preserves a recoverable winner", async () => {
    const team = `formal-cas-${process.pid}-${Date.now()}`;
    teams.push(team);
    const authority = new DurableGraphTaskAuthority();
    await authority.applyGraph(team, { operationId: "initial", tasks: [twoTaskGraph[0]] });
    const before = (await authority.readTask(team, "a"))!;
    const commands = ["left", "right"].map(operationId => authority.transition(team, {
      taskId: "a", operationId, expectedVersion: before.version,
      transition: "claim", worker: "alice",
    }));
    const settled = await Promise.allSettled(commands);
    expect(settled.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter(result => result.status === "rejected")).toHaveLength(1);
    const recovered = GraphTaskController.recover(JSON.parse(fs.readFileSync(graphTaskAuthorityPath(team), "utf8")));
    expect(recovered.readTask("a").state.kind).toBe("in_progress");
    expect(recovered.readAttempts("a")).toHaveLength(1);
    expect(recovered.snapshot().receipts).toHaveLength(2);
  });
});
