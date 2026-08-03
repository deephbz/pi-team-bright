import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BeadsTaskStore } from "./beads";
import type { TaskFile } from "./models";
import { teamDir } from "./paths";
import * as teamEvents from "./team-events";
import * as teams from "./teams";
import { applySemanticTaskUpdate, mutateTaskLink } from "./tasks";

const createdTeams: string[] = [];

function task(teamName: string, overrides: Partial<TaskFile> = {}): TaskFile {
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
});
