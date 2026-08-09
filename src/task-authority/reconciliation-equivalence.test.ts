import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskCard } from "../model-tool-contract/task-domain";
import { taskVersionRef } from "../model-tool-contract/task-version-ref";
import * as paths from "../utils/paths";
import {
  prepareOwnerTransitionIntent,
  readOwnerTransitionIntents,
  readTaskDeliveries,
  reconcileTaskChanges,
  recordTaskDeliveryRecovery,
  suppressTaskVersionForSession,
} from "../utils/task-delivery";
import * as teams from "../utils/teams";
import type {
  TaskReconciliationQuery,
  TaskReconciliationReadOutcome,
} from "./contracts";

const createdTeams: string[] = [];
let sequence = 0;

type CompleteTaskCard = Extract<TaskCard, { goal: string }>;

function card(overrides: Partial<CompleteTaskCard> = {}): CompleteTaskCard {
  return {
    id: overrides.id ?? "task-1",
    title: overrides.title ?? "Reconcile Task delivery",
    goal: overrides.goal ?? "Preserve delivery behavior across the Task query boundary.",
    current_context: overrides.current_context ?? "Reconciliation is ready.",
    status: overrides.status ?? "in_progress",
    ...(overrides.assignee ? { assignee: overrides.assignee } : {}),
    version: overrides.version ?? taskVersionRef("reconciliation-v1"),
  };
}

async function addMember(teamName: string, name: string, sessionFile: string) {
  const membershipId = teams.newMembershipId();
  await teams.addMember(teamName, {
    membershipId,
    agentId: `${name}@${teamName}`,
    name,
    agentType: "teammate",
    joinedAt: Date.now(),
    tmuxPaneId: "",
    sessionFile,
    cwd: process.cwd(),
    subscriptions: [],
  });
  return { membershipId, sessionFile };
}

async function fixture(suffix: string, extraMembers: string[] = []) {
  const teamName = `reconciliation-equivalence-${suffix}-${process.pid}-${Date.now()}-${sequence++}`;
  createdTeams.push(teamName);
  await teams.createTeam(
    teamName,
    `/tmp/${teamName}-lead.jsonl`,
    `lead@${teamName}`,
    "Task reconciliation equivalence fixture",
    undefined,
    undefined,
    `/tmp/${teamName}-beads`,
    `task_authority_${suffix}`,
    {
      schema: "pi-teams-beads-authority/1",
      backend: "dolt",
      database: "dolt",
      doltDatabase: `reconciliation_${suffix}`,
      projectId: `reconciliation-${suffix}`,
    },
  );
  const bindings: Record<string, { membershipId: string; sessionFile: string }> = {};
  for (const name of ["worker", ...extraMembers]) {
    bindings[name] = await addMember(teamName, name, `/tmp/${teamName}-${name}.jsonl`);
  }
  return { teamName, bindings };
}

function query(options: {
  current?: TaskReconciliationReadOutcome[];
  ownerEvidence?: TaskReconciliationQuery["readOwnerTransitionEvidence"];
} = {}): TaskReconciliationQuery & {
  readCurrentTasks: ReturnType<typeof vi.fn<TaskReconciliationQuery["readCurrentTasks"]>>;
  readOwnerTransitionEvidence: ReturnType<typeof vi.fn<TaskReconciliationQuery["readOwnerTransitionEvidence"]>>;
} {
  return {
    readCurrentTasks: vi.fn(async () => options.current ?? []),
    readOwnerTransitionEvidence: vi.fn(options.ownerEvidence ?? (async () => {
      throw new Error("Owner-transition evidence was not expected.");
    })),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const teamName of createdTeams.splice(0)) {
    fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(teamName), { recursive: true, force: true });
  }
});

describe("Task reconciliation port equivalence", () => {
  it("preserves self-suppression, later external change, exact current binding, and delivery-ID deduplication", async () => {
    const state = await fixture("identity");
    const sourceBinding = state.bindings.worker;
    const selfAuthored = card({ assignee: "worker", version: taskVersionRef("self-v1") });
    const taskQuery = query({ current: [{ kind: "found", task: selfAuthored }] });

    await suppressTaskVersionForSession(
      state.teamName,
      "worker",
      sourceBinding.sessionFile,
      selfAuthored,
    );
    expect(await reconcileTaskChanges(state.teamName, "worker", taskQuery)).toBe(0);
    expect(await readTaskDeliveries(state.teamName, "worker")).toEqual([]);

    const externallyChanged = card({
      ...selfAuthored,
      current_context: "A later external writer changed this Task.",
      version: taskVersionRef("external-v2"),
    });
    taskQuery.readCurrentTasks.mockResolvedValue([{ kind: "found", task: externallyChanged }]);
    expect(await reconcileTaskChanges(state.teamName, "worker", taskQuery)).toBe(1);
    const first = await readTaskDeliveries(state.teamName, "worker");
    expect(first).toEqual([expect.objectContaining({
      recipientMembershipId: sourceBinding.membershipId,
      recipientSessionFile: sourceBinding.sessionFile,
      changeKind: "task_changed",
      ref: { kind: "task", taskId: externallyChanged.id, version: externallyChanged.version },
      taskProjection: externallyChanged,
    })]);

    expect(await reconcileTaskChanges(state.teamName, "worker", taskQuery)).toBe(0);
    expect((await readTaskDeliveries(state.teamName, "worker")).map((item) => item.deliveryId)).toEqual([first[0].deliveryId]);

    await teams.deactivateMembership(state.teamName, sourceBinding.membershipId, "replaced");
    const replacement = await addMember(state.teamName, "worker", `/tmp/${state.teamName}-worker-replacement.jsonl`);
    expect(await reconcileTaskChanges(state.teamName, "worker", taskQuery)).toBe(1);
    const afterReplacement = await readTaskDeliveries(state.teamName, "worker");
    expect(afterReplacement).toHaveLength(2);
    expect(afterReplacement[1]).toMatchObject({
      recipientMembershipId: replacement.membershipId,
      recipientSessionFile: replacement.sessionFile,
      ref: { taskId: externallyChanged.id, version: externallyChanged.version },
    });
    expect(afterReplacement[1].deliveryId).not.toBe(first[0].deliveryId);
  });

  it("recovers an authority owner marker without sending its stale target to the replacement binding", async () => {
    const state = await fixture("owner-marker", ["old-assignee"]);
    const staleWorker = state.bindings.worker;
    const before = card({
      assignee: "old-assignee",
      version: taskVersionRef("owner-before"),
    });
    const committed = card({
      ...before,
      assignee: "worker",
      version: taskVersionRef("owner-committed"),
    });
    const operationId = "owner-transition-equivalence";
    await prepareOwnerTransitionIntent({
      operationId,
      teamName: state.teamName,
      before,
      afterOwner: "worker",
    });

    await teams.deactivateMembership(state.teamName, staleWorker.membershipId, "replaced");
    const replacement = await addMember(state.teamName, "worker", `/tmp/${state.teamName}-worker-current.jsonl`);
    const taskQuery = query({
      current: [{ kind: "found", task: committed }],
      ownerEvidence: async () => ({ task: committed, operationId }),
    });

    expect(await reconcileTaskChanges(state.teamName, "worker", taskQuery)).toBe(1);
    expect(taskQuery.readOwnerTransitionEvidence).toHaveBeenCalledOnce();
    expect(await readOwnerTransitionIntents(state.teamName)).toEqual([expect.objectContaining({
      operationId,
      state: "committed",
      committedTaskVersion: committed.version,
      resolvedTargetKeys: expect.arrayContaining([
        expect.stringContaining(`${staleWorker.membershipId}:${staleWorker.sessionFile}:assigned`),
      ]),
    })]);
    expect(await readTaskDeliveries(state.teamName, "old-assignee")).toEqual([expect.objectContaining({
      changeKind: "ownership_lost",
      taskProjection: committed,
    })]);
    expect(await readTaskDeliveries(state.teamName, "worker")).toEqual([expect.objectContaining({
      changeKind: "task_changed",
      recipientMembershipId: replacement.membershipId,
      recipientSessionFile: replacement.sessionFile,
      taskProjection: committed,
    })]);
  });

  it("replays recovery evidence once and refuses a metadata contract gap without changing delivery state", async () => {
    const state = await fixture("recovery-gap");
    const recoveredVersion = taskVersionRef("recovery-v1");
    const recovered = card({
      assignee: "worker",
      version: recoveredVersion,
    });
    await recordTaskDeliveryRecovery({
      teamName: state.teamName,
      taskId: recovered.id,
      taskVersion: recoveredVersion,
      recipients: ["worker"],
      changeKind: "task_changed",
      recordedAt: "2026-08-09T00:00:00.000Z",
      reason: "enqueue-failed",
      taskProjection: recovered,
    });
    const emptyQuery = query();

    expect(await reconcileTaskChanges(state.teamName, "worker", emptyQuery)).toBe(1);
    const delivered = await readTaskDeliveries(state.teamName, "worker");
    expect(delivered).toEqual([expect.objectContaining({
      ref: expect.objectContaining({ taskId: recovered.id, version: recovered.version }),
      taskProjection: recovered,
    })]);
    expect(await reconcileTaskChanges(state.teamName, "worker", emptyQuery)).toBe(0);
    expect((await readTaskDeliveries(state.teamName, "worker")).map((item) => item.deliveryId)).toEqual([delivered[0].deliveryId]);
    expect(JSON.parse(fs.readFileSync(paths.taskDeliveryRecoveryPath(state.teamName), "utf8"))).toEqual([
      expect.objectContaining({ resolvedRecipients: ["worker"] }),
    ]);

    const gapQuery = query({
      current: [{
        kind: "contract_gap",
        reason: "task_metadata_invalid",
        taskId: "task-gap",
        version: taskVersionRef("gap-v1"),
        message: "Canonical Task metadata is invalid.",
      }],
    });
    await expect(reconcileTaskChanges(state.teamName, "worker", gapQuery)).rejects.toMatchObject({
      name: "upgrade_required",
      message: expect.stringContaining("task-gap"),
    });
    expect(await readTaskDeliveries(state.teamName, "worker")).toEqual(delivered);
  });

  it("keeps the Task delivery consumer independent from Beads and the Beads adapter independent from the trio port", () => {
    const delivery = fs.readFileSync(path.join(process.cwd(), "src/utils/task-delivery.ts"), "utf8");
    const beadsAdapter = fs.readFileSync(path.join(process.cwd(), "src/model-tool-contract/beads-task-adapter.ts"), "utf8");

    expect(delivery).toMatch(/import type \{ TaskReconciliationQuery \} from "\.\.\/task-authority\/contracts"/);
    expect(delivery).not.toMatch(/(?:from|import\()[^\n]*beads-(?:task|authority)-adapter/);
    expect(beadsAdapter).not.toMatch(/from "\.\/in-memory-team-port"/);
  });
});
