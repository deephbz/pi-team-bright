import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { taskVersionRef } from "../model-tool-contract/task-version-ref";
import type { TaskCard } from "../model-tool-contract/task-domain";
import * as paths from "./paths";
import * as teams from "./teams";
import {
  completeOwnerTransitionIntent,
  enqueueTaskChangeForExactRecipient,
  prepareOwnerTransitionIntent,
  readOwnerTransitionIntents,
  readTaskDeliveries,
  reconcileOwnerTransitionOutbox,
} from "./task-delivery";

const created: string[] = [];

async function fixture(suffix: string) {
  const teamName = `assignee-outbox-${suffix}-${process.pid}-${Date.now()}`;
  created.push(teamName);
  paths.ensureDirs();
  await teams.createTeam(
    teamName,
    "lead-session",
    "lead-agent",
    "",
    undefined,
    undefined,
    `/tmp/${teamName}-beads`,
    `task_authority_${suffix}`,
    { schema: "pi-teams-beads-authority/1", backend: "dolt", database: "dolt", doltDatabase: `owner_outbox_${suffix}`, projectId: `assignee-outbox-${suffix}` },
  );
  for (const name of ["old-assignee", "new-assignee", "third-assignee"]) {
    await teams.addMember(teamName, {
      agentId: `${name}@${teamName}`,
      name,
      agentType: "teammate",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      sessionFile: `/tmp/${teamName}-${name}.jsonl`,
      cwd: process.cwd(),
      subscriptions: [],
    });
  }
  const before: TaskCard = {
    id: "bd-task",
    title: "Long work",
    goal: "Preserve ownership during crash recovery.",
    current_context: "Ownership transition is in progress.",
    status: "in_progress",
    assignee: "old-assignee",
    version: taskVersionRef("beads_v1"),
  };
  return { teamName, before };
}

function after(before: TaskCard, assignee: string, version: string): TaskCard {
  return { ...structuredClone(before), assignee, version: taskVersionRef(version) };
}

afterEach(() => {
  for (const teamName of created.splice(0)) {
    fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(teamName), { recursive: true, force: true });
  }
});

describe("assignee-transition authority-linked outbox", () => {
  it("retains an in-flight precommit intent without delivering, then recovers after authority commit", async () => {
    const { teamName, before } = await fixture("barrier");
    const operationId = "assignee-op-barrier";
    await prepareOwnerTransitionIntent({ operationId, teamName, before, afterOwner: "new-assignee" });

    await reconcileOwnerTransitionOutbox(teamName, {
      readEvidence: async () => ({ task: before, operationId: undefined }),
    });
    expect(await readOwnerTransitionIntents(teamName)).toMatchObject([{ operationId, state: "prepared" }]);
    expect(await readTaskDeliveries(teamName, "old-assignee")).toEqual([]);
    expect(await readTaskDeliveries(teamName, "new-assignee")).toEqual([]);

    const committed = after(before, "new-assignee", "beads_v2");
    await reconcileOwnerTransitionOutbox(teamName, {
      readEvidence: async () => ({ task: committed, operationId }),
    });
    expect(await readOwnerTransitionIntents(teamName)).toMatchObject([{ operationId, state: "committed" }]);
    expect(await readTaskDeliveries(teamName, "old-assignee")).toMatchObject([{ changeKind: "ownership_lost", taskProjection: { id: committed.id, assignee: "new-assignee", status: committed.status } }]);
    expect(await readTaskDeliveries(teamName, "new-assignee")).toMatchObject([{ changeKind: "assigned", taskProjection: { id: committed.id, assignee: "new-assignee", status: committed.status } }]);
  });

  it("recovers both exact recipients after commit-before-enqueue", async () => {
    const { teamName, before } = await fixture("postcommit");
    const operationId = "assignee-op-postcommit";
    const committed = after(before, "new-assignee", "beads_v2");
    await prepareOwnerTransitionIntent({ operationId, teamName, before, afterOwner: "new-assignee" });

    await reconcileOwnerTransitionOutbox(teamName, {
      readEvidence: async () => ({ task: committed, operationId }),
    });

    const config = await teams.readConfig(teamName);
    const oldBinding = config.members.find((member) => member.name === "old-assignee");
    const newBinding = config.members.find((member) => member.name === "new-assignee");
    expect(await readTaskDeliveries(teamName, "old-assignee")).toMatchObject([{
      recipientMembershipId: oldBinding?.membershipId,
      recipientSessionFile: oldBinding?.sessionFile,
      changeKind: "ownership_lost",
    }]);
    expect(await readTaskDeliveries(teamName, "new-assignee")).toMatchObject([{
      recipientMembershipId: newBinding?.membershipId,
      recipientSessionFile: newBinding?.sessionFile,
      changeKind: "assigned",
    }]);
  });

  it("retries only the missing recipient after a cut following the first enqueue", async () => {
    const { teamName, before } = await fixture("half-enqueue");
    const operationId = "assignee-op-half-enqueue";
    const committed = after(before, "new-assignee", "beads_v2");
    await prepareOwnerTransitionIntent({ operationId, teamName, before, afterOwner: "new-assignee" });
    let calls = 0;
    const warnings = await completeOwnerTransitionIntent(teamName, operationId, committed, {
      enqueueExact: async (config, task, target) => {
        calls += 1;
        if (calls === 2) throw new Error("deterministic cut after first enqueue");
        return enqueueTaskChangeForExactRecipient(config, task, target);
      },
    });
    expect(warnings).toHaveLength(1);
    expect(await readTaskDeliveries(teamName, "old-assignee")).toHaveLength(1);
    expect(await readTaskDeliveries(teamName, "new-assignee")).toHaveLength(0);

    await reconcileOwnerTransitionOutbox(teamName, {
      readEvidence: async () => ({ task: committed, operationId }),
    });
    expect(await readTaskDeliveries(teamName, "old-assignee")).toHaveLength(1);
    expect(await readTaskDeliveries(teamName, "new-assignee")).toHaveLength(1);
    expect((await readOwnerTransitionIntents(teamName))[0].resolvedTargetKeys).toHaveLength(2);
  });

  it("settles the prior marker before a later assignee change overwrites authority metadata", async () => {
    const { teamName, before } = await fixture("later-assignee");
    const firstOperation = "assignee-op-first";
    const secondOperation = "assignee-op-second";
    const firstCommitted = after(before, "new-assignee", "beads_v2");
    const secondCommitted = after(firstCommitted, "third-assignee", "beads_v3");
    await prepareOwnerTransitionIntent({
      operationId: firstOperation,
      teamName,
      before,
      afterOwner: "new-assignee",
    });

    await prepareOwnerTransitionIntent({
      operationId: secondOperation,
      teamName,
      before: firstCommitted,
      afterOwner: "third-assignee",
      previousOperationId: firstOperation,
    });
    expect(await readTaskDeliveries(teamName, "old-assignee")).toMatchObject([{ changeKind: "ownership_lost" }]);
    expect(await readTaskDeliveries(teamName, "new-assignee")).toMatchObject([{ changeKind: "assigned" }]);

    await reconcileOwnerTransitionOutbox(teamName, {
      readEvidence: async () => ({ task: secondCommitted, operationId: secondOperation }),
    });
    expect(await readTaskDeliveries(teamName, "new-assignee")).toMatchObject([
      { changeKind: "assigned", taskProjection: { id: firstCommitted.id, assignee: "new-assignee" } },
      { changeKind: "ownership_lost", taskProjection: { id: secondCommitted.id, assignee: "third-assignee" } },
    ]);
    expect(await readTaskDeliveries(teamName, "third-assignee")).toMatchObject([{ changeKind: "assigned" }]);
    expect(await readOwnerTransitionIntents(teamName)).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: firstOperation, state: "committed" }),
      expect.objectContaining({ operationId: secondOperation, state: "committed" }),
    ]));
  });

  it("uses a same-assignee retry marker to recover the prior committed operation without creating another", async () => {
    const { teamName, before } = await fixture("same-assignee-retry");
    const firstOperation = "assignee-op-retry-original";
    const retryOperation = "assignee-op-retry-unused";
    const committed = after(before, "new-assignee", "beads_v2");
    await prepareOwnerTransitionIntent({
      operationId: firstOperation,
      teamName,
      before,
      afterOwner: "new-assignee",
    });

    const shouldEmbedRetry = await prepareOwnerTransitionIntent({
      operationId: retryOperation,
      teamName,
      before: committed,
      afterOwner: "new-assignee",
      previousOperationId: firstOperation,
    });

    expect(shouldEmbedRetry).toBe(false);
    expect(await readOwnerTransitionIntents(teamName)).toMatchObject([{
      operationId: firstOperation,
      state: "committed",
      committedTaskProjection: { id: committed.id, assignee: "new-assignee" },
      committedTaskVersion: taskVersionRef("beads_v2"),
    }]);
    expect(await readTaskDeliveries(teamName, "old-assignee")).toMatchObject([{ changeKind: "ownership_lost" }]);
    expect(await readTaskDeliveries(teamName, "new-assignee")).toMatchObject([{ changeKind: "assigned" }]);
  });

  it("deduplicates concurrent recipient dispatchers settling the same committed intent", async () => {
    const { teamName, before } = await fixture("concurrent-dispatchers");
    const operationId = "assignee-op-concurrent-dispatchers";
    const committed = after(before, "new-assignee", "beads-v2");
    await prepareOwnerTransitionIntent({ operationId, teamName, before, afterOwner: "new-assignee" });
    const readEvidence = async () => ({ task: committed, operationId });

    await Promise.all([
      reconcileOwnerTransitionOutbox(teamName, { readEvidence }),
      reconcileOwnerTransitionOutbox(teamName, { readEvidence }),
    ]);

    expect(await readTaskDeliveries(teamName, "old-assignee")).toHaveLength(1);
    expect(await readTaskDeliveries(teamName, "new-assignee")).toHaveLength(1);
    expect((await readOwnerTransitionIntents(teamName))[0].resolvedTargetKeys).toHaveLength(2);
  });
});
