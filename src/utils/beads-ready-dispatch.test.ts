import { describe, expect, it, vi } from "vitest";
import { BeadsTaskStore, beadsLabel, type BdRunner } from "./beads";

function raw(teamName: string, id: string, assignee: string, status: "open" | "in_progress") {
  return {
    id,
    title: id,
    description: `Complete ${id}.`,
    acceptance_criteria: `Complete ${id}.`,
    design: "",
    notes: "",
    parent: "",
    status,
    assignee,
    labels: [beadsLabel(teamName)],
    metadata: {
      pi_teams_team: teamName,
      pi_teams_task: JSON.stringify({ schema: "pi-teams-task/1", goal: `Complete ${id}.`, current_context: "Ready." }),
    },
    updated_at: "2026-08-12T00:00:00.000Z",
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
    dependencies: [],
    dependents: [],
    comments: [],
  };
}

describe("Beads ready dispatch query", () => {
  it("hydrates at most one ready Task per free Worker instead of the whole Team", async () => {
    const teamName = "ready-query-team";
    const workspace = "/tmp/ready-query-team";
    const makerActive = raw(teamName, "task-maker-active", "maker", "in_progress");
    const makerReady = raw(teamName, "task-maker-ready", "maker", "open");
    const reviewerFirst = raw(teamName, "task-reviewer-a", "reviewer", "open");
    const reviewerSecond = raw(teamName, "task-reviewer-b", "reviewer", "open");
    const run = vi.fn<BdRunner["run"]>(async (args) => {
      if (args.includes("--status")) return { stdout: JSON.stringify([makerActive]), stderr: "", exitCode: 0 };
      if (args.includes("--ready")) return { stdout: JSON.stringify([makerReady, reviewerSecond, reviewerFirst]), stderr: "", exitCode: 0 };
      if (args.includes("show")) return { stdout: JSON.stringify([reviewerFirst]), stderr: "", exitCode: 0 };
      throw new Error(`Unexpected bd command: ${args.join(" ")}`);
    });
    const store = new BeadsTaskStore({ teamName, workspace, runner: { run } });

    await expect(store.readReadyDispatchSnapshot()).resolves.toMatchObject({
      occupiedWorkers: ["maker"],
      readyTasks: [{ task: { id: reviewerFirst.id, assignee: "reviewer", status: "open" } }],
    });
    const commands = run.mock.calls.map(([args]) => args);
    expect(commands.filter((args) => args.includes("--ready"))).toHaveLength(1);
    expect(commands.filter((args) => args.includes("--status"))).toHaveLength(1);
    expect(commands.find((args) => args.includes("show"))).toEqual(expect.arrayContaining([
      "show", reviewerFirst.id, "--include-dependents",
    ]));
    expect(commands.find((args) => args.includes("show"))).not.toEqual(expect.arrayContaining([
      makerReady.id, reviewerSecond.id,
    ]));
  });
});
