import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BeadsTaskStore, readBeadsAuthorityFingerprint, TASK_METADATA_KEY, TASK_METADATA_SCHEMA } from "./beads";
import { projectTaskCard } from "../model-tool-contract/beads-task-adapter";
import * as paths from "./paths";
import * as teams from "./teams";
import {
  enqueueTaskChangeForRecipient,
  readTaskDeliveries,
  readTaskDeliveryTombstones,
  suppressTaskVersionForSession,
  TaskChangeDelivery,
} from "./task-delivery";
import { applySemanticTaskUpdate as applyRawSemanticTaskUpdate } from "../model-tool-contract/beads-authority-adapter";
import { DurableTaskMutationPublication } from "../adapters/durable-task-mutation-publication";
import { taskVersionRef } from "../model-tool-contract/task-version-ref";
import type { TaskCard } from "../model-tool-contract/task-domain";
import { recordBdCall, withSemanticTrace } from "./trace";

const createdTeams: string[] = [];
const roots: string[] = [];
const publicationPort = new DurableTaskMutationPublication();
type SemanticUpdateArgs = Parameters<typeof applyRawSemanticTaskUpdate>;
const applySemanticTaskUpdate = (...args: [SemanticUpdateArgs[0], SemanticUpdateArgs[1], SemanticUpdateArgs[2], SemanticUpdateArgs[3]]) =>
  applyRawSemanticTaskUpdate(...args, publicationPort);
const hasBd = spawnSync("bd", ["--version"], { stdio: "ignore" }).status === 0;

function root(prefix: string): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), `pi-teams-round2-${prefix}-`));
  roots.push(value);
  return value;
}

function initBeads(): string {
  const workspace = root("beads");
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("bd", ["init", "--quiet", "--skip-agents", "--skip-hooks"], { cwd: workspace, stdio: "ignore" });
  return workspace;
}

async function teamFixture(suffix: string, workspace = `/tmp/round2-${suffix}`) {
  const name = `round2-${suffix}-${process.pid}-${Date.now()}`;
  createdTeams.push(name);
  const fingerprint = fs.existsSync(path.join(workspace, ".beads", "metadata.json"))
    ? readBeadsAuthorityFingerprint(workspace)
    : { schema: "pi-teams-beads-authority/1" as const, backend: "dolt" as const, database: "dolt" as const, doltDatabase: `round2_${suffix}`, projectId: `round2-${suffix}` };
  await teams.createTeam(name, "lead", "lead", "", undefined, undefined, workspace, `task_authority_${suffix}`, fingerprint);
  const add = async (member: string, sessionFile: string) => teams.addMember(name, {
    agentId: `${member}@${name}`,
    name: member,
    agentType: "teammate",
    joinedAt: Date.now(),
    tmuxPaneId: "",
    sessionFile,
    cwd: process.cwd(),
    subscriptions: [],
    isActive: true,
  });
  return { name, add };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.PI_TEAMS_TRACE_JSONL;
  for (const name of createdTeams.splice(0)) fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe("Round 2 Task delivery contracts", () => {
  it("binds self-suppression to the exact current Session and Task version", async () => {
    const { name, add } = await teamFixture("suppression");
    const firstSession = "/tmp/worker-first.jsonl";
    await add("worker", firstSession);
    const task: TaskCard = { id: "t1", title: "s", goal: "verified", current_context: "Ready.", status: "in_progress", assignee: "worker", version: taskVersionRef("v1") };
    await suppressTaskVersionForSession(name, "worker", firstSession, task);
    expect(await enqueueTaskChangeForRecipient(name, task, "worker", "status_changed")).toBeNull();

    await teams.updateMember(name, "worker", { sessionFile: "/tmp/worker-second.jsonl" });
    const next = await enqueueTaskChangeForRecipient(name, task, "worker", "status_changed");
    expect(next?.recipientSessionFile).toBe("/tmp/worker-second.jsonl");
  });

  it("reconciles once at delivery start but never on periodic spool scans", async () => {
    vi.useFakeTimers();
    const { name, add } = await teamFixture("restart-only");
    await add("worker", "/tmp/restart-only.jsonl");
    const reconcile = vi.fn(async () => 0);
    const delivery = new TaskChangeDelivery({ sendMessage: vi.fn(), appendEntry: vi.fn() }, {
      teamName: name,
      recipient: "worker",
      sessionFile: "/tmp/restart-only.jsonl",
      pollMs: 10,
      reconcile,
    });
    await delivery.start([]);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(reconcile).toHaveBeenCalledTimes(1);
    delivery.stop();
  });

  it("compacts settled spool records while retaining every pending change and suppression tombstone", async () => {
    const { name, add } = await teamFixture("compaction");
    const sessionFile = "/tmp/compaction-worker.jsonl";
    await add("worker", sessionFile);
    for (let index = 0; index < 150; index += 1) {
      await enqueueTaskChangeForRecipient(name, {
        id: `t${index}`,
        title: `task ${index}`,
        goal: "The delivery remains pending",
        current_context: "Ready.",
        status: "in_progress",
        assignee: "worker",
        version: taskVersionRef(`v${index}`),
      }, "worker", "task_changed");
    }
    expect(await readTaskDeliveries(name, "worker")).toHaveLength(150);
    const sent = vi.fn();
    const delivery = new TaskChangeDelivery({ sendMessage: sent, appendEntry: vi.fn() }, {
      teamName: name,
      recipient: "worker",
      sessionFile,
      reconcile: async () => 0,
    });
    await delivery.start([]);
    const batch = sent.mock.calls[0][0];
    await delivery.observeContext([{ role: "custom", customType: batch.customType, details: batch.details }]);
    await delivery.commitPresentedAfterSuccessfulTurn("stop");
    expect(await readTaskDeliveries(name, "worker")).toHaveLength(128);
    expect(await readTaskDeliveryTombstones(name, "worker")).toHaveLength(150);
    delivery.stop();
  }, 30_000);

  it.skipIf(!hasBd)("notifies both previous and new owners from before/after evidence", async () => {
    const workspace = initBeads();
    const { name, add } = await teamFixture("owners", workspace);
    await add("alice", "/tmp/alice.jsonl");
    await add("bob", "/tmp/bob.jsonl");
    const store = new BeadsTaskStore({ teamName: name, workspace, requireExpectedVersion: false });
    const created = await store.create({ title: "handoff", description: "assignee change", internalMetadata: { [TASK_METADATA_KEY]: { schema: TASK_METADATA_SCHEMA, goal: "assignee change", current_context: "Ready." } } });
    const owned = await store.update(created.id, { assignee: "alice", status: "in_progress" });
    const result = await applySemanticTaskUpdate(name, owned.id, { assignee: "bob", status: "in_progress" }, { actor: "team-lead", taskCardProjector: projectTaskCard });

    expect(result.before.assignee).toBe("alice");
    expect(result.task.assignee).toBe("bob");
    expect(result.appliedOperations).toEqual(expect.arrayContaining(["set:assignee", "set:status"]));
    expect((await readTaskDeliveries(name, "alice"))[0]?.changeKind).toBe("ownership_lost");
    expect((await readTaskDeliveries(name, "bob"))[0]?.changeKind).toBe("assigned");
  }, 60_000);

  it.skipIf(!hasBd)("rejects a stale same-name Session before any Task mutation", async () => {
    const workspace = initBeads();
    const { name, add } = await teamFixture("stale-session", workspace);
    await add("worker", "/tmp/current-worker.jsonl");
    const store = new BeadsTaskStore({ teamName: name, workspace, requireExpectedVersion: false });
    const created = await store.create({ title: "guard", description: "no post-commit identity failure" });
    const owned = await store.update(created.id, { assignee: "worker", status: "in_progress" });
    await expect(applySemanticTaskUpdate(name, owned.id, { status: "open" }, {
      actor: "worker",
      actingSessionFile: "/tmp/stale-worker.jsonl",
    })).rejects.toThrow(/not the current binding/);
    expect((await store.read(owned.id)).status).toBe("in_progress");
  }, 60_000);

  it.skipIf(!hasBd)("returns one canonical digest version across create and immediate read", async () => {
    const workspace = initBeads();
    const { name } = await teamFixture("canonical-version", workspace);
    const store = new BeadsTaskStore({ teamName: name, workspace, requireExpectedVersion: false });
    const created = await store.create({ title: "version", description: "canonical" });
    const reread = await store.read(created.id);
    expect(created.version).toMatch(/^beads_[a-f0-9]{64}$/);
    expect(reread.version).toBe(created.version);
  }, 60_000);

  it.skipIf(!hasBd)("keeps agent-facing assignee/status and progress updates at three Beads calls", async () => {
    const workspace = initBeads();
    const { name } = await teamFixture("amplification", workspace);
    const store = new BeadsTaskStore({ teamName: name, workspace, requireExpectedVersion: false });
    const created = await store.create({ title: "amplification", description: "measure semantic tool cost", internalMetadata: { [TASK_METADATA_KEY]: { schema: TASK_METADATA_SCHEMA, goal: "measure semantic tool cost", current_context: "Ready." } } });
    const trace = path.join(root("amplification-trace"), "trace.jsonl");
    process.env.PI_TEAMS_TRACE_JSONL = trace;

    await applySemanticTaskUpdate(name, created.id, { assignee: "offline-assignee", status: "in_progress" }, { actor: "team-lead", taskCardProjector: projectTaskCard });
    await applySemanticTaskUpdate(name, created.id, { appendNote: "one journal intent" }, { actor: "team-lead", taskCardProjector: projectTaskCard });

    const records = fs.readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ operation: "task_update", bdCallCount: 3, outcome: "ok" });
    expect(records[1]).toMatchObject({ operation: "task_update", bdCallCount: 3, outcome: "ok" });
  }, 60_000);
});

describe("Round 2 observability and lifecycle contracts", () => {
  it("writes one payload-free semantic trace with call and timing totals", async () => {
    const trace = path.join(root("trace"), "trace.jsonl");
    process.env.PI_TEAMS_TRACE_JSONL = trace;
    await withSemanticTrace("task_update", { teamName: "safe-team", taskId: "safe-task" }, async () => {
      recordBdCall("update", 7, "ok");
      return "secret payload that must not be traced";
    });
    const record = JSON.parse(fs.readFileSync(trace, "utf8"));
    expect(record).toMatchObject({ operation: "task_update", bdCallCount: 1, bdTotalMs: 7, outcome: "ok" });
    expect(record.bdCalls).toEqual([{ command: "update", durationMs: 7, outcome: "ok" }]);
    expect(JSON.stringify(record)).not.toContain("secret payload");
  });

  it("deactivates only current memberships while retaining Session history", async () => {
    const { name, add } = await teamFixture("shutdown");
    await add("worker", "/tmp/worker-history.jsonl");
    await teams.deactivateMember(name, "worker", "replaced");
    await add("worker", "/tmp/worker-current.jsonl");
    const result = await teams.deactivateCurrentMembers(name, "team_shutdown");
    expect(result.deactivated.map((member) => member.sessionFile)).toContain("/tmp/worker-current.jsonl");
    const config = await teams.readConfig(name);
    expect(config.members.filter((member) => member.name === "worker")).toHaveLength(2);
    expect(config.members.filter((member) => member.name === "worker").every((member) => member.isActive === false)).toBe(true);
  });
});
