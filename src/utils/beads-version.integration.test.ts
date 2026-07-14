import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BeadsTaskStore, readBeadsAuthorityFingerprint } from "./beads";
import * as paths from "./paths";
import {
  enqueueTaskChangeForRecipient,
  readTaskDeliveries,
  reconcileTaskChanges,
  suppressTaskVersionForSession,
  TaskChangeDelivery,
} from "./task-delivery";
import * as teams from "./teams";

const hasBd = spawnSync("bd", ["--version"], { stdio: "ignore" }).status === 0;
const workspaces: string[] = [];
const teamNames: string[] = [];

function initBeads(): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-version-integration-"));
  workspaces.push(workspace);
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("bd", ["init", "--quiet", "--skip-agents", "--skip-hooks"], { cwd: workspace, stdio: "ignore" });
  return workspace;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const teamName of teamNames.splice(0)) {
    fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(teamName), { recursive: true, force: true });
  }
  for (const workspace of workspaces.splice(0)) fs.rmSync(workspace, { recursive: true, force: true });
});

describe.skipIf(!hasBd)("canonical Beads versions across projections", () => {
  it("keeps list/show versions identical and prevents restart duplicate or self-delivery", async () => {
    const workspace = initBeads();
    const teamName = `version-integration-${process.pid}-${Date.now()}`;
    const sessionFile = `/tmp/${teamName}-worker.jsonl`;
    teamNames.push(teamName);
    const fingerprint = readBeadsAuthorityFingerprint(workspace);
    await teams.createTeam(
      teamName,
      `/tmp/${teamName}-lead.jsonl`,
      "lead-agent",
      "",
      undefined,
      undefined,
      workspace,
      `task_authority_${teamName}`,
      fingerprint,
    );
    await teams.addMember(teamName, {
      agentId: `worker@${teamName}`,
      name: "worker",
      agentType: "teammate",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      sessionFile,
      cwd: process.cwd(),
      subscriptions: [],
      isActive: true,
    });

    const store = new BeadsTaskStore({
      teamName,
      workspace,
      authorityFingerprint: fingerprint,
      requireExpectedVersion: false,
    });
    const target = await store.create({ subject: "Target", description: "version source" });
    const initial = await store.read(target.id);
    const commented = await store.addProgress(target.id, { kind: "progress", text: "checkpoint", actor: "worker" });
    expect(commented.version).not.toBe(initial.version);

    const dependent = await store.create({ subject: "Dependent", description: "reverse edge" });
    await store.addDependency(dependent.id, target.id);
    const linked = await store.read(target.id);
    expect(linked.version).not.toBe(commented.version);

    const owned = await store.update(target.id, { owner: "worker", status: "in_progress" });
    const listed = (await store.list()).find((task) => task.id === target.id);
    expect(listed?.version).toBe(owned.version);

    const firstDelivery = await enqueueTaskChangeForRecipient(teamName, owned, "worker", "assigned");
    expect(firstDelivery).not.toBeNull();
    const beforeRestart = await readTaskDeliveries(teamName, "worker");
    expect(beforeRestart).toHaveLength(1);

    const restarted = new BeadsTaskStore({
      teamName,
      workspace,
      authorityFingerprint: fingerprint,
      requireExpectedVersion: false,
    });
    expect((await restarted.list()).find((task) => task.id === target.id)?.version).toBe((await restarted.read(target.id)).version);
    expect(await reconcileTaskChanges(teamName, "worker")).toBe(0);
    expect((await readTaskDeliveries(teamName, "worker")).map((record) => record.deliveryId)).toEqual([
      firstDelivery!.deliveryId,
    ]);

    // Settle the pre-existing delivery locally, then prove that a Task version
    // produced by this same Session is not echoed when delivery restarts.
    await suppressTaskVersionForSession(teamName, "worker", sessionFile, owned);
    const selfTask = await store.create({ subject: "Self mutation", description: "must not echo" });
    await store.addProgress(selfTask.id, { kind: "progress", text: "self checkpoint", actor: "worker" });
    const selfOwned = await store.update(selfTask.id, { owner: "worker", status: "in_progress" });
    await suppressTaskVersionForSession(teamName, "worker", sessionFile, selfOwned);

    const sendMessage = vi.fn();
    const delivery = new TaskChangeDelivery({ sendMessage, appendEntry: vi.fn() }, {
      teamName,
      recipient: "worker",
      sessionFile,
      pollMs: 60_000,
    });
    try {
      await delivery.start([]);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(await reconcileTaskChanges(teamName, "worker")).toBe(0);
    } finally {
      delivery.stop();
    }
  }, 90_000);
});
