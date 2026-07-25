import crypto from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BeadsTaskStore, type BdRunner } from "./beads";
import type { Member, TeamConfig } from "./models";
import * as paths from "./paths";
import { enqueueTaskChangeForRecipient, readTaskDeliveries } from "./task-delivery";
import * as teams from "./teams";

const createdTeams: string[] = [];

function raw(description: string, updatedAt: string) {
  return {
    id: "task-aba",
    title: "A to B to A",
    description,
    status: "in_progress",
    assignee: "worker",
    labels: ["pi-teams:version-round3"],
    metadata: { pi_teams_team: "version-round3" },
    updated_at: updatedAt,
    dependencies: [],
    dependents: [],
    comments: [],
  };
}

function runner(responses: unknown[]): BdRunner {
  return {
    run: vi.fn(async () => ({
      stdout: JSON.stringify(responses.shift()),
      stderr: "",
      exitCode: 0,
    })),
  };
}

function configureDeliveryTeam(teamName: string, sessionFile: string): void {
  createdTeams.push(teamName);
  const worker: Member = {
    membershipId: `membership_worker_${crypto.randomUUID()}`,
    agentId: `worker@${teamName}`,
    name: "worker",
    agentType: "teammate",
    joinedAt: Date.now(),
    tmuxPaneId: "",
    sessionFile,
    cwd: process.cwd(),
    subscriptions: [],
    isActive: true,
  };
  const config: TeamConfig = {
    name: teamName,
    description: "A-B-A version delivery fixture",
    createdAt: Date.now(),
    leadAgentId: "lead",
    leadSessionId: "lead-session",
    members: [worker],
    taskBackend: "beads",
    taskWorkspace: `/tmp/${teamName}-declared-workspace`,
    taskAuthorityId: `task_authority_${crypto.randomUUID()}`,
    taskAuthorityFingerprint: { schema: "pi-teams-beads-authority/1", backend: "dolt", database: "dolt", doltDatabase: `version_${teamName}`, projectId: `version-${teamName}` },
  };
  fs.mkdirSync(paths.teamDir(teamName), { recursive: true });
  teams.writeConfigAtomic(paths.configPath(teamName), config);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const team of createdTeams.splice(0)) {
    fs.rmSync(paths.teamDir(team), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(team), { recursive: true, force: true });
  }
});

describe("Round 3 canonical Task revision and delivery dedupe", () => {
  it("normalizes sub-second versus whole-second timestamp representations of the same revision", async () => {
    const store = new BeadsTaskStore({
      teamName: "version-round3",
      workspace: "/tmp/version-round3",
      runner: runner([
        [raw("A", "2026-07-15T01:02:03.987654Z")],
        [raw("A", "2026-07-15T01:02:03Z")],
      ]),
      requireExpectedVersion: false,
    });

    const microseconds = await store.read("task-aba");
    const wholeSecond = await store.read("task-aba");
    expect(microseconds.version).toBe(wholeSecond.version);
  });

  it("hydrates several Task revisions with one Beads show command in requested order", async () => {
    const first = { ...raw("first", "2026-07-15T01:02:03Z"), id: "task-first" };
    const second = { ...raw("second", "2026-07-15T01:02:04Z"), id: "task-second" };
    const run = vi.fn(async (args: string[]) => ({
      stdout: JSON.stringify([first, second]),
      stderr: "",
      exitCode: 0,
    }));
    const store = new BeadsTaskStore({
      teamName: "version-round3",
      workspace: "/tmp/version-round3",
      runner: { run },
      requireExpectedVersion: false,
    });

    const tasks = await store.readMany(["task-first", "task-second", "task-first"]);

    expect(tasks.map((task) => task.id)).toEqual(["task-first", "task-second"]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toEqual([
      "--directory", "/tmp/version-round3", "--json",
      "show", "task-first", "task-second", "--long", "--include-comments", "--include-dependents",
    ]);
  });

  it("distinguishes A to B to later A and enqueues the second A as a new Task revision", async () => {
    const store = new BeadsTaskStore({
      teamName: "version-round3",
      workspace: "/tmp/version-round3",
      runner: runner([
        raw("A", "2026-07-15T01:02:03.900000Z"),
        [raw("A", "2026-07-15T01:02:03Z")],
        [raw("A", "2026-07-15T01:02:03Z")],
        raw("B", "2026-07-15T01:02:04Z"),
        [raw("B", "2026-07-15T01:02:04Z")],
        [raw("B", "2026-07-15T01:02:04Z")],
        raw("A", "2026-07-15T01:02:05Z"),
        [raw("A", "2026-07-15T01:02:05Z")],
      ]),
      requireExpectedVersion: false,
    });

    const firstA = await store.create({ title: "A to B to A", description: "A" });
    const middleB = await store.update(firstA.id, { description: "B" });
    const secondA = await store.update(firstA.id, { description: "A" });

    expect(firstA.version).not.toBe(middleB.version);
    expect(middleB.version).not.toBe(secondA.version);
    expect(secondA.version).not.toBe(firstA.version);

    const team = `version-r3-${process.pid}-${Date.now()}`;
    configureDeliveryTeam(team, `/tmp/${team}-worker.jsonl`);
    const deliveries = [
      await enqueueTaskChangeForRecipient(team, firstA, "worker", "task_changed"),
      await enqueueTaskChangeForRecipient(team, middleB, "worker", "task_changed"),
      await enqueueTaskChangeForRecipient(team, secondA, "worker", "task_changed"),
    ];
    expect(deliveries.every(Boolean)).toBe(true);
    expect(new Set(deliveries.map((delivery) => delivery!.deliveryId))).toHaveLength(3);
    expect((await readTaskDeliveries(team, "worker")).map((delivery) => delivery.ref.version)).toEqual([
      firstA.version,
      middleB.version,
      secondA.version,
    ]);
  });
});
