import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskFile } from "./models";
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
  const teamName = `owner-outbox-${suffix}-${process.pid}-${Date.now()}`;
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
    { schema: "pi-teams-beads-authority/1", backend: "dolt", database: "dolt", doltDatabase: `owner_outbox_${suffix}`, projectId: `owner-outbox-${suffix}` },
  );
  for (const name of ["old-owner", "new-owner", "third-owner"]) {
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
  const before: TaskFile = {
    id: "bd-task",
    subject: "Long work",
    description: "Exercise crash recovery",
    status: "in_progress",
    owner: "old-owner",
    blocks: [],
    blockedBy: [],
    version: "beads_v1",
  };
  return { teamName, before };
}

function after(before: TaskFile, owner: string, version: string): TaskFile {
  return { ...structuredClone(before), owner, version };
}

afterEach(() => {
  for (const teamName of created.splice(0)) {
    fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(teamName), { recursive: true, force: true });
  }
});

describe("owner-transition authority-linked outbox", () => {
  it("retains an in-flight precommit intent without delivering, then recovers after authority commit", async () => {
    const { teamName, before } = await fixture("barrier");
    const operationId = "owner-op-barrier";
    await prepareOwnerTransitionIntent({ operationId, teamName, before, afterOwner: "new-owner" });

    await reconcileOwnerTransitionOutbox(teamName, {
      readEvidence: async () => ({ task: before, operationId: undefined }),
    });
    expect(await readOwnerTransitionIntents(teamName)).toMatchObject([{ operationId, state: "prepared" }]);
    expect(await readTaskDeliveries(teamName, "old-owner")).toEqual([]);
    expect(await readTaskDeliveries(teamName, "new-owner")).toEqual([]);

    const committed = after(before, "new-owner", "beads_v2");
    await reconcileOwnerTransitionOutbox(teamName, {
      readEvidence: async () => ({ task: committed, operationId }),
    });
    expect(await readOwnerTransitionIntents(teamName)).toMatchObject([{ operationId, state: "committed" }]);
    expect(await readTaskDeliveries(teamName, "old-owner")).toMatchObject([{ changeKind: "ownership_lost", taskSnapshot: committed }]);
    expect(await readTaskDeliveries(teamName, "new-owner")).toMatchObject([{ changeKind: "assigned", taskSnapshot: committed }]);
  });

  it("recovers both exact recipients after commit-before-enqueue", async () => {
    const { teamName, before } = await fixture("postcommit");
    const operationId = "owner-op-postcommit";
    const committed = after(before, "new-owner", "beads_v2");
    await prepareOwnerTransitionIntent({ operationId, teamName, before, afterOwner: "new-owner" });

    await reconcileOwnerTransitionOutbox(teamName, {
      readEvidence: async () => ({ task: committed, operationId }),
    });

    const config = await teams.readConfig(teamName);
    const oldBinding = config.members.find((member) => member.name === "old-owner");
    const newBinding = config.members.find((member) => member.name === "new-owner");
    expect(await readTaskDeliveries(teamName, "old-owner")).toMatchObject([{
      recipientMembershipId: oldBinding?.membershipId,
      recipientSessionFile: oldBinding?.sessionFile,
      changeKind: "ownership_lost",
    }]);
    expect(await readTaskDeliveries(teamName, "new-owner")).toMatchObject([{
      recipientMembershipId: newBinding?.membershipId,
      recipientSessionFile: newBinding?.sessionFile,
      changeKind: "assigned",
    }]);
  });

  it("retries only the missing recipient after a cut following the first enqueue", async () => {
    const { teamName, before } = await fixture("half-enqueue");
    const operationId = "owner-op-half-enqueue";
    const committed = after(before, "new-owner", "beads_v2");
    await prepareOwnerTransitionIntent({ operationId, teamName, before, afterOwner: "new-owner" });
    let calls = 0;
    const warnings = await completeOwnerTransitionIntent(teamName, operationId, committed, {
      enqueueExact: async (config, task, target) => {
        calls += 1;
        if (calls === 2) throw new Error("deterministic cut after first enqueue");
        return enqueueTaskChangeForExactRecipient(config, task, target);
      },
    });
    expect(warnings).toHaveLength(1);
    expect(await readTaskDeliveries(teamName, "old-owner")).toHaveLength(1);
    expect(await readTaskDeliveries(teamName, "new-owner")).toHaveLength(0);

    await reconcileOwnerTransitionOutbox(teamName, {
      readEvidence: async () => ({ task: committed, operationId }),
    });
    expect(await readTaskDeliveries(teamName, "old-owner")).toHaveLength(1);
    expect(await readTaskDeliveries(teamName, "new-owner")).toHaveLength(1);
    expect((await readOwnerTransitionIntents(teamName))[0].resolvedTargetKeys).toHaveLength(2);
  });

  it("settles the prior marker before a later owner change overwrites authority metadata", async () => {
    const { teamName, before } = await fixture("later-owner");
    const firstOperation = "owner-op-first";
    const secondOperation = "owner-op-second";
    const firstCommitted = after(before, "new-owner", "beads_v2");
    const secondCommitted = after(firstCommitted, "third-owner", "beads_v3");
    await prepareOwnerTransitionIntent({
      operationId: firstOperation,
      teamName,
      before,
      afterOwner: "new-owner",
    });

    await prepareOwnerTransitionIntent({
      operationId: secondOperation,
      teamName,
      before: firstCommitted,
      afterOwner: "third-owner",
      previousOperationId: firstOperation,
    });
    expect(await readTaskDeliveries(teamName, "old-owner")).toMatchObject([{ changeKind: "ownership_lost" }]);
    expect(await readTaskDeliveries(teamName, "new-owner")).toMatchObject([{ changeKind: "assigned" }]);

    await reconcileOwnerTransitionOutbox(teamName, {
      readEvidence: async () => ({ task: secondCommitted, operationId: secondOperation }),
    });
    expect(await readTaskDeliveries(teamName, "new-owner")).toMatchObject([
      { changeKind: "assigned", taskSnapshot: { version: "beads_v2" } },
      { changeKind: "ownership_lost", taskSnapshot: { version: "beads_v3" } },
    ]);
    expect(await readTaskDeliveries(teamName, "third-owner")).toMatchObject([{ changeKind: "assigned" }]);
    expect(await readOwnerTransitionIntents(teamName)).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: firstOperation, state: "committed" }),
      expect.objectContaining({ operationId: secondOperation, state: "committed" }),
    ]));
  });

  it("uses a same-owner retry marker to recover the prior committed operation without creating another", async () => {
    const { teamName, before } = await fixture("same-owner-retry");
    const firstOperation = "owner-op-retry-original";
    const retryOperation = "owner-op-retry-unused";
    const committed = after(before, "new-owner", "beads_v2");
    await prepareOwnerTransitionIntent({
      operationId: firstOperation,
      teamName,
      before,
      afterOwner: "new-owner",
    });

    const shouldEmbedRetry = await prepareOwnerTransitionIntent({
      operationId: retryOperation,
      teamName,
      before: committed,
      afterOwner: "new-owner",
      previousOperationId: firstOperation,
    });

    expect(shouldEmbedRetry).toBe(false);
    expect(await readOwnerTransitionIntents(teamName)).toMatchObject([{
      operationId: firstOperation,
      state: "committed",
      committedTaskSnapshot: { owner: "new-owner", version: "beads_v2" },
    }]);
    expect(await readTaskDeliveries(teamName, "old-owner")).toMatchObject([{ changeKind: "ownership_lost" }]);
    expect(await readTaskDeliveries(teamName, "new-owner")).toMatchObject([{ changeKind: "assigned" }]);
  });

  it("deduplicates concurrent recipient dispatchers settling the same committed intent", async () => {
    const { teamName, before } = await fixture("concurrent-dispatchers");
    const operationId = "owner-op-concurrent-dispatchers";
    const committed = after(before, "new-owner", "beads-v2");
    await prepareOwnerTransitionIntent({ operationId, teamName, before, afterOwner: "new-owner" });
    const readEvidence = async () => ({ task: committed, operationId });

    await Promise.all([
      reconcileOwnerTransitionOutbox(teamName, { readEvidence }),
      reconcileOwnerTransitionOutbox(teamName, { readEvidence }),
    ]);

    expect(await readTaskDeliveries(teamName, "old-owner")).toHaveLength(1);
    expect(await readTaskDeliveries(teamName, "new-owner")).toHaveLength(1);
    expect((await readOwnerTransitionIntents(teamName))[0].resolvedTargetKeys).toHaveLength(2);
  });
});
