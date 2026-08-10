import { afterEach, describe, expect, it, vi } from "vitest";
import { BeadsTaskAdapter } from "../model-tool-contract/beads-task-adapter";
import { taskVersionRef } from "../task-authority/task-version-ref";
import type { TaskCard } from "../task-authority/task-domain";
import { DurableAssignedWorkGuard } from "./durable-assigned-work-guard";

function task(id: string, status: TaskCard["status"], assignee?: string): TaskCard {
  return {
    id,
    title: id,
    goal: `Keep ${id} readable.`,
    current_context: `Current state for ${id}.`,
    status,
    ...(assignee ? { assignee } : {}),
    version: taskVersionRef(`guard-${id}`),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("DurableAssignedWorkGuard", () => {
  it("projects only exact nonterminal assignments in the Task application's canonical order", async () => {
    const cards = [
      task("unassigned-open", "open"),
      task("other-blocked", "blocked", "other"),
      task("worker-blocked", "blocked", "worker"),
      task("worker-closed", "closed", "worker"),
      task("worker-open", "open", "worker"),
      task("other-in-progress", "in_progress", "other"),
      task("worker-in-progress", "in_progress", "worker"),
      task("unassigned-closed", "closed"),
    ];
    vi.spyOn(BeadsTaskAdapter.prototype, "list").mockResolvedValue(cards);
    const guard = new DurableAssignedWorkGuard();

    await expect(guard.nonterminalTaskIds("team", "worker")).resolves.toEqual([
      "worker-blocked",
      "worker-open",
      "worker-in-progress",
    ]);
    await expect(guard.nonterminalTaskIds("team")).resolves.toEqual([
      "unassigned-open",
      "other-blocked",
      "worker-blocked",
      "worker-open",
      "other-in-progress",
      "worker-in-progress",
    ]);
  });

  it("propagates Task application read failure without returning a partial guard projection", async () => {
    const failure = new Error("configured Task authority fingerprint no longer matches");
    vi.spyOn(BeadsTaskAdapter.prototype, "list").mockRejectedValue(failure);

    await expect(new DurableAssignedWorkGuard().nonterminalTaskIds("team", "worker")).rejects.toBe(failure);
  });
});
