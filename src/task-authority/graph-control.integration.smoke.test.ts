import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableGraphTaskAuthority } from "../adapters/durable-graph-task-authority";
import { DurableTaskMutationPublication } from "../adapters/durable-task-mutation-publication";
import { configPath, graphTaskAuthorityPath, teamDir } from "../utils/paths";
import { readTaskDeliveries } from "../utils/task-delivery";
import { writeConfigAtomic } from "../utils/teams";
import { DurableGraphTaskOrchestration } from "./graph-orchestration";
import type { GraphTaskCard } from "./graph-control-schemas";
import type { TeamConfig } from "../team-authority/contracts";
import type { TaskVersionRef } from "./task-version-ref";

const teamName = `graph-smoke-${process.pid}`;
const aliases = {
  default: "openai-codex/gpt-5.6-codex:medium",
  capable: "openai-codex/gpt-5.6-codex:max",
};

function config(): TeamConfig {
  const workers = ["planner", "builder", "reviewer", "verifier"];
  return {
    name: teamName,
    description: "Graph integration smoke.",
    createdAt: 0,
    leadAgentId: "lead",
    leadSessionId: "lead-session",
    epochId: "graph-smoke-epoch",
    logicalWorkers: workers.map((name) => ({ name, scope: `Own ${name} work.` })),
    members: workers.map((name, index) => ({
      membershipId: `membership-${name}`,
      agentId: `agent-${name}`,
      name,
      agentType: "teammate",
      joinedAt: index,
      sessionFile: path.join(teamDir(teamName), `${name}-session.jsonl`),
      cwd: process.cwd(),
      subscriptions: [],
    })),
  };
}

function byId(tasks: GraphTaskCard[], id: string): GraphTaskCard {
  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`Missing smoke Task ${id}.`);
  return task;
}

async function transition(
  orchestration: DurableGraphTaskOrchestration,
  task: GraphTaskCard,
  name: "claim" | "goal_achieved" | "goal_failed",
  operation: string,
  evidence?: string,
) {
  return orchestration.transition(teamName, {
    taskId: task.id,
    operationId: operation,
    expectedVersion: task.version as TaskVersionRef,
    transition: name,
    worker: task.assignee,
    ...(evidence ? { evidence } : {}),
  }, task.assignee);
}

async function achieve(orchestration: DurableGraphTaskOrchestration, taskId: string, sequence: number): Promise<void> {
  let task = byId(await orchestration.readTasks(teamName), taskId);
  expect((await transition(orchestration, task, "claim", `${taskId}-claim-${sequence}`)).kind).toBe("updated");
  task = byId(await orchestration.readTasks(teamName), taskId);
  expect((await transition(orchestration, task, "goal_achieved", `${taskId}-pass-${sequence}`, `${taskId} external criterion passed.`)).kind).toBe("updated");
}

afterEach(() => fs.rmSync(teamDir(teamName), { recursive: true, force: true }));

describe("durable graph-control integration", () => {
  it("recovers Attempts and dispatch while a failed review stays closed to verification", async () => {
    fs.mkdirSync(teamDir(teamName), { recursive: true });
    writeConfigAtomic(configPath(teamName), config());
    const publication = new DurableTaskMutationPublication();
    const orchestration = new DurableGraphTaskOrchestration(
      new DurableGraphTaskAuthority(() => aliases),
      publication,
      publication,
      publication,
    );

    const applied = await orchestration.applyGraph(teamName, {
      operationId: "apply-smoke-graph",
      tasks: [
        { key: "plan", title: "Plan", goal: "Produce an accepted plan.", assignee: "planner" },
        { key: "implement", title: "Implement", goal: "Implement the accepted plan.", assignee: "builder", modelAlias: "capable", needs: ["plan"] },
        { key: "review", title: "Review", goal: "Accept only when criteria pass.", assignee: "reviewer", needs: ["implement"], onGoalFailed: { target: "implement", maxTraversals: 1 } },
        { key: "verify", title: "Verify", goal: "Verify the accepted result.", assignee: "verifier", needs: ["review"] },
      ],
    });
    expect(applied).toMatchObject({ kind: "applied", readyTaskIds: ["plan"] });
    expect((await readTaskDeliveries(teamName, "planner")).map((record) => record.ref.taskId)).toEqual(["plan"]);
    expect(await readTaskDeliveries(teamName, "builder")).toEqual([]);

    await achieve(orchestration, "plan", 1);
    await achieve(orchestration, "implement", 1);
    let tasks = await orchestration.readTasks(teamName);
    expect(byId(tasks, "implement").current_attempt).toMatchObject({ resolved_model: aliases.capable });

    let review = byId(tasks, "review");
    await transition(orchestration, review, "claim", "review-claim-1");
    review = byId(await orchestration.readTasks(teamName), "review");
    const failed = await transition(orchestration, review, "goal_failed", "review-fail-1", "Criterion failed: repair is required.");
    expect(failed).toMatchObject({
      kind: "updated",
      failureTraversal: { sourceTaskId: "review", targetTaskId: "implement", traversal: 1 },
    });
    tasks = await orchestration.readTasks(teamName);
    expect(byId(tasks, "implement").status).toBe("ready");
    expect(byId(tasks, "review").status).toBe("dependency_waiting");
    expect(byId(tasks, "verify").status).toBe("dependency_waiting");
    expect(await readTaskDeliveries(teamName, "verifier")).toEqual([]);

    expect(fs.existsSync(graphTaskAuthorityPath(teamName))).toBe(true);
    const recovered = new DurableGraphTaskOrchestration(
      new DurableGraphTaskAuthority(() => { throw new Error("recovery must use captured aliases"); }),
      publication,
      publication,
      publication,
    );
    await achieve(recovered, "implement", 2);
    await achieve(recovered, "review", 2);
    tasks = await recovered.readTasks(teamName);
    expect(byId(tasks, "verify").status).toBe("ready");
    expect(byId(tasks, "review").current_attempt?.input_attempt_ids.implement).toBe(byId(tasks, "implement").accepted_attempt_id);
    expect((await readTaskDeliveries(teamName, "verifier")).map((record) => record.ref.taskId)).toEqual(["verify"]);
  });
});
