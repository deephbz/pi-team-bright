import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BeadsTaskStore } from "./beads";
import type { TaskAuthorityRecord } from "./beads";
import { teamDir } from "./paths";
import * as eventJournal from "../coordination/event-journal";
import * as teamEvents from "./team-events";
import * as teams from "./teams";
import * as failureHints from "./task-event-failure-hints";
import { taskVersionRef } from "../model-tool-contract/task-version-ref";
import {
  applySemanticTaskUpdate as applyRawSemanticTaskUpdate,
  mutateTaskLink as mutateRawTaskLink,
} from "../model-tool-contract/beads-authority-adapter";
import { DurableTaskMutationPublication } from "../adapters/durable-task-mutation-publication";
import { createTaskAuthorityTeamPort } from "../../test/support/task-authority-team-port";

const createdTeams: string[] = [];
const publicationPort = new DurableTaskMutationPublication();
const taskAuthorityTeamPort = createTaskAuthorityTeamPort();
type SemanticUpdateArgs = Parameters<typeof applyRawSemanticTaskUpdate>;
type TaskLinkArgs = Parameters<typeof mutateRawTaskLink>;
const applySemanticTaskUpdate = (...args: [SemanticUpdateArgs[0], SemanticUpdateArgs[1], SemanticUpdateArgs[2], SemanticUpdateArgs[3]]) =>
  applyRawSemanticTaskUpdate(...args, publicationPort, taskAuthorityTeamPort);
const mutateTaskLink = (...args: [TaskLinkArgs[0], TaskLinkArgs[1], TaskLinkArgs[2], TaskLinkArgs[3]]) =>
  mutateRawTaskLink(...args, publicationPort, taskAuthorityTeamPort);

function task(teamName: string, overrides: Partial<TaskAuthorityRecord> = {}): TaskAuthorityRecord {
  return {
    id: "task-1",
    title: "Verify publication",
    description: "Verify typed Task-event publication.",
    acceptanceCriteria: "The event has structured evidence.",
    status: "open",
    relations: [],
    version: "beads_v1",
    provenance: { authority: "beads", teamName },
    ...overrides,
  };
}

async function fixture(): Promise<string> {
  const name = `task-event-publication-${process.pid}-${Date.now()}`;
  const workspace = path.join("/tmp", name);
  createdTeams.push(name);
  fs.mkdirSync(path.join(workspace, ".beads"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".beads", "metadata.json"), JSON.stringify({
    backend: "dolt",
    database: "dolt",
    dolt_database: name,
    project_id: name,
  }));
  await teams.createTeam(name, "lead-session", "lead", "", undefined, undefined, workspace, "task-authority", {
    schema: "pi-teams-beads-authority/1",
    backend: "dolt",
    database: "dolt",
    doltDatabase: name,
    projectId: name,
  });
  return name;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of createdTeams.splice(0)) {
    fs.rmSync(teamDir(name), { recursive: true, force: true });
    fs.rmSync(path.join("/tmp", name), { recursive: true, force: true });
  }
});

describe("Task-event publication", () => {
  it("writes typed evidence for current Task updates and links", async () => {
    const teamName = await fixture();
    const before = task(teamName);
    const afterStatus = task(teamName, { status: "in_progress", version: "beads_v2" });
    const afterLink = task(teamName, {
      status: "in_progress",
      version: "beads_v3",
      relations: [{ relation: "related", targetId: "task-2" }],
    });
    vi.spyOn(BeadsTaskStore.prototype, "updateWithResult").mockResolvedValue({
      before,
      after: afterStatus,
      appliedOperations: ["set:status"],
    });
    vi.spyOn(BeadsTaskStore.prototype, "mutateLinkWithResult").mockResolvedValue({
      before: afterStatus,
      after: afterLink,
      appliedOperations: ["add:related"],
    });

    await applySemanticTaskUpdate(teamName, before.id, { status: "in_progress" }, { actor: "team-lead" });
    await mutateTaskLink(teamName, before.id, { relation: "related", targetId: "task-2", action: "add" }, {
      actor: "team-lead",
      expectedVersion: afterStatus.version,
    });

    const events = teamEvents.readTeamEvents(teamName, { afterCursor: "0" }).events;
    expect(events).toHaveLength(2);
    expect(events.map(teamEvents.projectTaskEventEvidence)).toEqual([
      expect.objectContaining({ kind: "status", text: "Task status changed to in_progress.", actor: "team-lead" }),
      expect.objectContaining({ kind: "relation", text: "Task relation add related task-2.", actor: "team-lead" }),
    ]);
  });

  it("records payload-light hints for Worker and leader event-append failures", async () => {
    const teamName = await fixture();
    const workerBefore = task(teamName, { id: "worker-task", assignee: "worker" });
    const workerAfter = task(teamName, { id: "worker-task", assignee: "worker", version: "worker-v2", status: "in_progress" });
    const leaderBefore = task(teamName, { id: "leader-task" });
    const leaderAfter = task(teamName, { id: "leader-task", version: "leader-v2", status: "in_progress" });
    vi.spyOn(BeadsTaskStore.prototype, "updateWithResult")
      .mockResolvedValueOnce({ before: workerBefore, after: workerAfter, appliedOperations: ["set:status"] })
      .mockResolvedValueOnce({ before: leaderBefore, after: leaderAfter, appliedOperations: ["set:status"] });
    vi.spyOn(eventJournal, "appendTaskEvidenceEvent").mockRejectedValue(new Error("event journal unavailable"));

    const worker = await applySemanticTaskUpdate(teamName, workerBefore.id, { status: "in_progress" }, { actor: "worker" });
    const leader = await applySemanticTaskUpdate(teamName, leaderBefore.id, { status: "in_progress" }, { actor: "team-lead" });
    expect(worker.deliveryWarnings).toEqual(expect.arrayContaining([expect.stringContaining("Team event was not recorded")]));
    expect(leader.deliveryWarnings).toEqual(expect.arrayContaining([expect.stringContaining("Team event was not recorded")]));
    const epochId = (await teams.readConfig(teamName)).epochId!;
    expect(failureHints.readTaskEventFailureHints(teamName, {
      teamEpochId: epochId,
      taskReferences: [
        { taskId: workerAfter.id, taskVersion: taskVersionRef(workerAfter.version) },
        { taskId: leaderAfter.id, taskVersion: taskVersionRef(leaderAfter.version) },
      ],
    })).toEqual([
      { hint: expect.objectContaining({ taskId: workerAfter.id, actor: "worker" }), actorKind: "non-leader/external" },
      { hint: expect.objectContaining({ taskId: leaderAfter.id, actor: "team-lead" }), actorKind: "team-lead" },
    ]);
  });

  it("warns when failed-event hint persistence also fails", async () => {
    const teamName = await fixture();
    const before = task(teamName);
    const after = task(teamName, { status: "in_progress", version: "hint-failure-v2" });
    vi.spyOn(BeadsTaskStore.prototype, "updateWithResult").mockResolvedValue({ before, after, appliedOperations: ["set:status"] });
    vi.spyOn(eventJournal, "appendTaskEvidenceEvent").mockRejectedValue(new Error("event journal unavailable"));
    vi.spyOn(failureHints, "appendTaskEventFailureHint").mockRejectedValue(new Error("hint store unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await applySemanticTaskUpdate(teamName, before.id, { status: "in_progress" }, { actor: "team-lead" });
    expect(result.deliveryWarnings).toEqual(expect.arrayContaining([expect.stringContaining("hint persistence also failed")]));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("hint persistence also failed"));
  });
});
