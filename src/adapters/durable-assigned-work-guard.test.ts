import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadOnlyBeadsTaskAdapterFactory } from "../model-tool-contract/beads-task-adapter";
import { taskVersionRef } from "../task-authority/task-version-ref";
import type { TaskCard } from "../task-authority/task-domain";
import type { TaskAuthorityRecordEnvelope } from "../utils/beads";
import { DurableAssignedWorkGuard } from "./durable-assigned-work-guard";

function task(id: string, status: TaskCard["status"], assignee?: string): TaskCard & { goal: string } {
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

function authorityRecord(card: TaskCard & { goal: string }, teamName: string): TaskAuthorityRecordEnvelope {
  return {
    task: {
      id: card.id,
      title: card.title,
      description: "Compatibility",
      acceptanceCriteria: "Compatibility",
      status: card.status,
      ...(card.assignee ? { assignee: card.assignee } : {}),
      relations: [],
      version: card.version,
      provenance: { authority: "beads", teamName },
    },
    taskMetadata: {
      schema: "pi-teams-task/1",
      goal: card.goal,
      current_context: card.current_context,
    },
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
    const byId = new Map(cards.map((card) => [card.id, card]));
    const guard = new DurableAssignedWorkGuard(createReadOnlyBeadsTaskAdapterFactory({
      listTaskIds: vi.fn(async () => cards.map((card) => card.id)),
      readTaskAuthorityRecordEnvelope: vi.fn(async (teamName: string, id: string) => authorityRecord(byId.get(id)!, teamName)),
      readTaskAuthorityRecordEnvelopes: vi.fn(async (teamName: string, ids: readonly string[]) =>
        ids.map((id) => authorityRecord(byId.get(id)!, teamName))),
    }));

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
    await expect(new DurableAssignedWorkGuard(createReadOnlyBeadsTaskAdapterFactory({
      listTaskIds: vi.fn(async () => { throw failure; }),
      readTaskAuthorityRecordEnvelope: vi.fn(),
      readTaskAuthorityRecordEnvelopes: vi.fn(),
    })).nonterminalTaskIds("team", "worker")).rejects.toBe(failure);
  });
});
