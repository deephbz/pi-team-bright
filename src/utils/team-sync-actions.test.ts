import { describe, expect, it } from "vitest";
import type { TeamCurrentProjection } from "./team-events";
import { selectTeamSyncNextActions, summarizeTeamSyncNextActions } from "./team-sync-actions";

function projection(input: Partial<TeamCurrentProjection> = {}): TeamCurrentProjection {
  return {
    team: { name: "dogfood", description: "", lifecycle: "active" },
    workers: [],
    tasks: [],
    ...input,
  };
}

describe("team_sync next-action selection", () => {
  it("pairs open unassigned Tasks with existing idle Workers before suggesting lifecycle churn", () => {
    const actions = selectTeamSyncNextActions({
      teamName: "dogfood",
      cursor: "12",
      completion: "snapshot",
      projection: projection({
        workers: [
          { name: "auditor", carrier: "session_bound", nonterminalTasks: [] },
          { name: "builder", carrier: "prepared", nonterminalTasks: [] },
        ],
        tasks: [
          { id: "pt-1", title: "Audit contract", status: "open", version: "v1" },
          { id: "pt-2", title: "Build fixture", status: "open", version: "v2" },
        ],
      }),
      hydratedTasks: [],
    });

    expect(actions).toEqual([
      {
        tool: "task_update",
        reason: expect.stringMatching(/Reuse existing idle Worker auditor.*Task pt-1/i),
        args: { team_name: "dogfood", task_id: "pt-1", assignee: "auditor", expected_version: "v1" },
      },
      {
        tool: "task_update",
        reason: expect.stringMatching(/Reuse existing idle Worker builder.*Task pt-2/i),
        args: { team_name: "dogfood", task_id: "pt-2", assignee: "builder", expected_version: "v2" },
      },
    ]);
    expect(actions.some(action => action.tool === "worker_stop")).toBe(false);
  });

  it("does not suggest stopping surplus idle Workers while any executable unassigned work exists", () => {
    const actions = selectTeamSyncNextActions({
      teamName: "dogfood",
      cursor: "3",
      completion: "events",
      projection: projection({
        workers: [
          { name: "auditor", carrier: "session_bound", nonterminalTasks: [] },
          { name: "builder", carrier: "session_bound", nonterminalTasks: [] },
        ],
        tasks: [{ id: "pt-1", title: "Audit", status: "open", version: "v1" }],
      }),
      hydratedTasks: [],
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      tool: "task_update",
      args: { task_id: "pt-1", assignee: "auditor" },
    });
    expect(actions.some(action => action.tool === "worker_stop")).toBe(false);
  });

  it("suggests worker_stop only when there is no open unassigned Task", () => {
    const actions = selectTeamSyncNextActions({
      teamName: "dogfood",
      cursor: "8",
      completion: "snapshot",
      projection: projection({
        workers: [{ name: "auditor", carrier: "session_bound", nonterminalTasks: [] }],
        tasks: [
          { id: "pt-closed", title: "Done", status: "closed", version: "v4" },
          { id: "pt-owned", title: "Owned", status: "open", assignee: "builder", version: "v2" },
        ],
      }),
      hydratedTasks: [],
    });

    expect(actions).toEqual([{
      tool: "worker_stop",
      reason: expect.stringMatching(/no open unassigned Task/i),
      args: { team_name: "dogfood", worker: "auditor" },
    }]);
  });

  it("preserves blocker recovery and cursor-wait recommendations", () => {
    const blocked = selectTeamSyncNextActions({
      teamName: "dogfood",
      cursor: "9",
      completion: "events",
      projection: projection(),
      hydratedTasks: [{ id: "pt-blocked", status: "blocked", version: "v9" }],
    });
    expect(blocked).toEqual([{
      tool: "task_update",
      reason: expect.stringMatching(/Before reassigning Task pt-blocked.*recorded blocker/i),
      args: { team_name: "dogfood", task_id: "pt-blocked", expected_version: "v9" },
    }]);

    const timedOut = selectTeamSyncNextActions({
      teamName: "dogfood",
      cursor: "10",
      completion: "timeout",
      projection: projection(),
      hydratedTasks: [],
    });
    expect(timedOut).toEqual([{
      tool: "team_sync",
      reason: expect.stringMatching(/Wait from this cursor/i),
      args: { team_name: "dogfood", cursor: "10" },
    }]);
  });

  it("keeps an explicit lead-owned blocker decision ahead of reassignment and releases the idle Worker", () => {
    const actions = selectTeamSyncNextActions({
      teamName: "dogfood",
      cursor: "12",
      completion: "events",
      projection: projection({
        workers: [{ name: "reviewer", carrier: "session_bound", nonterminalTasks: [] }],
        tasks: [
          { id: "decision", title: "Choose the release threshold", status: "open", version: "v1" },
          { id: "audit", title: "Audit the release", status: "blocked", version: "v2" },
        ],
      }),
      hydratedTasks: [{
        id: "audit",
        status: "blocked",
        version: "v2",
        notes: "Blocked on the scoring threshold; next action: team-lead chooses the threshold and reassigns the Task.",
        relations: [{ relation: "blocked_by", targetId: "decision" }],
      }],
    });

    expect(actions).toEqual([
      {
        tool: "task_update",
        reason: "Before reassigning Task audit, team-lead chooses the threshold.",
        args: { team_name: "dogfood", task_id: "audit", expected_version: "v2" },
      },
      {
        tool: "worker_stop",
        reason: "Worker reviewer is idle and can stop while the explicit lead-owned blocker decision remains.",
        args: { team_name: "dogfood", worker: "reviewer" },
      },
    ]);
    expect(summarizeTeamSyncNextActions(actions)).toBe(
      "Next: Before reassigning Task audit, team-lead chooses the threshold. Worker reviewer is idle and can stop while the explicit lead-owned blocker decision remains.",
    );
  });
});
