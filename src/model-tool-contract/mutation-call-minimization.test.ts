import { afterEach, describe, expect, it, vi } from "vitest";
import * as authority from "./beads-authority-adapter";
import * as teams from "../utils/teams";
import { DurableModelToolTeamPort } from "./durable-model-tool-port";
import { exactLeaderSessionId } from "./in-memory-team-port";
import { taskVersionRef } from "./task-version-ref";
import type { TaskAuthorityRecord } from "../utils/beads";
import { createPublishingBeadsTaskAdapterFactory, projectNonterminalTaskIds, projectTaskChanges } from "./beads-task-adapter";
import { DurableTaskMutationPublication } from "../adapters/durable-task-mutation-publication";
import { createTaskAuthorityTeamPort } from "../../test/support/task-authority-team-port";
import { createDurableCoordinationQueries } from "../adapters/durable-coordination-queries";
import { createDurableCoordinationNudgeStore } from "../adapters/durable-coordination-nudge-store";
import { DurableCoordinationHiddenObservation } from "../adapters/durable-coordination-hidden-observation";
import { CoordinationObservationService, createDurableCoordinationObservationStore } from "../coordination/observation-service";

const createdTeams: string[] = [];
const readPort = {
  readTaskAuthorityRecordEnvelope: vi.fn(),
  readTaskAuthorityRecordEnvelopes: vi.fn(),
  listTaskIds: vi.fn(),
};
const taskAdapterFactory = createPublishingBeadsTaskAdapterFactory(
  new DurableTaskMutationPublication(),
  createTaskAuthorityTeamPort(),
  readPort,
);

function task(teamName: string, id: string, version = `beads_${id}_v1`, status: TaskAuthorityRecord["status"] = "open"): TaskAuthorityRecord {
  return {
    id,
    title: `${id} title`,
    description: "Compatibility description.",
    acceptanceCriteria: "Compatibility acceptance.",
    status,
    relations: [],
    version,
    provenance: { authority: "beads", teamName },
  };
}

async function durablePort(suffix: string): Promise<{ name: string; port: DurableModelToolTeamPort; session: ReturnType<typeof exactLeaderSessionId> }> {
  const name = `mutation-call-minimization-${suffix}-${process.pid}-${Date.now()}-${createdTeams.length}`;
  const sessionFile = `/tmp/${name}-lead.jsonl`;
  createdTeams.push(name);
  await teams.createTeam(name, sessionFile, "lead-agent", "Mutation call minimization.", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined);
  const queries = createDurableCoordinationQueries(taskAdapterFactory);
  const hidden = new DurableCoordinationHiddenObservation();
  const port = new DurableModelToolTeamPort({ ensureWorker: vi.fn() } as any, undefined, taskAdapterFactory, undefined, new CoordinationObservationService(queries, { projectNonterminalTaskIds, projectTaskChanges }, createDurableCoordinationObservationStore(hidden), undefined, createDurableCoordinationNudgeStore(hidden)));
  const session = exactLeaderSessionId(`session-${name}`);
  port.setLeaderSessionFile(session, sessionFile);
  return { name, port, session };
}

afterEach(() => {
  vi.restoreAllMocks();
  readPort.readTaskAuthorityRecordEnvelope.mockReset();
  readPort.readTaskAuthorityRecordEnvelopes.mockReset();
  readPort.listTaskIds.mockReset();
  createdTeams.splice(0);
});

describe("model mutation Beads call minimization", () => {
  it("does not add an outer source read when task_link has no expected version", async () => {
    const { name, port, session } = await durablePort("link");
    const read = readPort.readTaskAuthorityRecordEnvelope.mockRejectedValue(new Error("unused outer source read"));
    const mutate = vi.spyOn(authority, "mutateTaskLink").mockResolvedValue({
      task: task(name, "task-a", "beads_task-a_v2"),
      changed: true,
      appliedOperations: ["add:related:task-b"],
      deliveryDegraded: false,
      deliveryWarnings: [],
    });

    const result = await port.linkTask(session, {
      taskId: "task-a",
      relation: "related",
      targetId: "task-b",
      action: "add",
    });

    expect(result).toMatchObject({ kind: "linked", changed: true, version: taskVersionRef("beads_task-a_v2") });
    expect(read).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledOnce();
    expect(mutate.mock.calls[0]?.[3]).toMatchObject({ expectedVersion: undefined });
  });

  it("resolves one public version ref to raw CAS inside the adapter", async () => {
    const teamName = "link-adapter-test";
    const record = {
      task: task(teamName, "task-a", "beads_task-a_v3"),
      taskMetadata: { schema: "pi-teams-task/1", goal: "Link the Task.", current_context: "Ready." },
    } as any;
    const read = readPort.readTaskAuthorityRecordEnvelope.mockResolvedValue(record);
    const mutate = vi.spyOn(authority, "mutateTaskLink").mockResolvedValue({
      task: record.task,
      changed: true,
      appliedOperations: ["add:related:task-b"],
      deliveryDegraded: false,
      deliveryWarnings: [],
    });
    const adapter = taskAdapterFactory(teamName, "team-lead");
    const result = await adapter.link({ taskId: "task-a", relation: "related", targetId: "task-b", action: "add", expectedVersion: taskVersionRef("beads_task-a_v3") });
    expect(result).toMatchObject({ kind: "linked", version: taskVersionRef("beads_task-a_v3") });
    expect(read).toHaveBeenCalledOnce();
    expect(mutate.mock.calls[0]?.[3]).toMatchObject({ expectedVersion: "beads_task-a_v3" });
  });

});
