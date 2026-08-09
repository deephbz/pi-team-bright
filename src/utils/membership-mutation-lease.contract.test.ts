import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BeadsTaskStore } from "./beads";
import type { Member } from "./models";
import type { TaskAuthorityRecord } from "./beads";
import * as paths from "./paths";
import { applySemanticTaskUpdate as applyRawSemanticTaskUpdate } from "../model-tool-contract/beads-authority-adapter";
import { DurableTaskMutationPublication } from "../adapters/durable-task-mutation-publication";
import * as teams from "./teams";

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

type Fixture = {
  teamName: string;
  lead: Member;
  alpha: Member;
  beta: Member;
};

const testTeams: string[] = [];
const testWorkspaces: string[] = [];
const publicationPort = new DurableTaskMutationPublication();
type SemanticUpdateArgs = Parameters<typeof applyRawSemanticTaskUpdate>;
const applySemanticTaskUpdate = (...args: [SemanticUpdateArgs[0], SemanticUpdateArgs[1], SemanticUpdateArgs[2], SemanticUpdateArgs[3]]) =>
  applyRawSemanticTaskUpdate(...args, publicationPort);

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for contract interleaving");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function member(teamName: string, name: string): Member {
  return {
    membershipId: teams.newMembershipId(),
    agentId: `${name}@${teamName}`,
    name,
    agentType: "teammate",
    joinedAt: Date.now(),
    tmuxPaneId: "",
    sessionFile: `/tmp/${teamName}-${name}.jsonl`,
    cwd: process.cwd(),
    subscriptions: [],
    isActive: true,
  };
}

async function fixture(suffix: string): Promise<Fixture> {
  const teamName = `membership-lease-${suffix}-${process.pid}-${Date.now()}-${testTeams.length}`;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-membership-lease-"));
  fs.mkdirSync(path.join(workspace, ".beads"));
  fs.writeFileSync(path.join(workspace, ".beads", "metadata.json"), JSON.stringify({
    database: "dolt",
    backend: "dolt",
    dolt_database: `membership_lease_${suffix}`,
    project_id: `membership-lease-${suffix}`,
  }));
  testTeams.push(teamName);
  testWorkspaces.push(workspace);
  const config = await teams.createTeam(
    teamName,
    `/tmp/${teamName}-lead.jsonl`,
    "lead-agent",
    "membership mutation lease contract",
    undefined,
    undefined,
    workspace,
    `task_authority_${teamName}`,
    { schema: "pi-teams-beads-authority/1", backend: "dolt", database: "dolt", doltDatabase: `membership_lease_${suffix}`, projectId: `membership-lease-${suffix}` },
  );
  const alpha = member(teamName, "alpha");
  const beta = member(teamName, "beta");
  await teams.addMember(teamName, alpha);
  await teams.addMember(teamName, beta);
  return { teamName, lead: config.members[0], alpha, beta };
}

function task(id: string, version = "v1"): TaskAuthorityRecord {
  return {
    id,
    title: id,
    description: "mutation lease contract task",
    acceptanceCriteria: "The mutation contract holds",
    status: "open",
    relations: [],
    version,
    provenance: { authority: "beads", teamName: "membership-lease-fixture" },
  };
}

function binding(member: Member) {
  return {
    actor: member.name,
    actingMembershipId: member.membershipId!,
    actingSessionFile: member.sessionFile!,
  };
}

function installSlowBackend() {
  const entered = new Set<string>();
  const activeByTask = new Set<string>();
  const gates = new Map<string, Deferred>();
  let peakBackendConcurrency = 0;
  const spy = vi.spyOn(BeadsTaskStore.prototype, "updateWithResult").mockImplementation(async (id) => {
    const gate = gates.get(id);
    if (!gate) throw new Error(`missing backend gate for ${id}`);
    entered.add(id);
    activeByTask.add(id);
    peakBackendConcurrency = Math.max(peakBackendConcurrency, activeByTask.size);
    await gate.promise;
    activeByTask.delete(id);
    return {
      before: task(id),
      after: { ...task(id, "v2"), status: "in_progress" },
      appliedOperations: ["set:status"],
    };
  });
  return {
    entered,
    gates,
    spy,
    peakBackendConcurrency: () => peakBackendConcurrency,
    add(id: string): Deferred {
      const gate = deferred();
      gates.set(id, gate);
      return gate;
    },
  };
}

async function mutation(f: Fixture, actor: Member, taskId: string) {
  return applySemanticTaskUpdate(
    f.teamName,
    taskId,
    { status: "in_progress" },
    binding(actor),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const teamName of testTeams.splice(0)) {
    fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(teamName), { recursive: true, force: true });
  }
  for (const workspace of testWorkspaces.splice(0)) {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

describe("Membership-scoped mutation lease contract", () => {
  it("allows different Memberships to mutate concurrently, serializes one Membership, and never holds TeamConfig across a slow backend", async () => {
    const f = await fixture("concurrency");
    const backend = installSlowBackend();
    const alphaFirstGate = backend.add("alpha-first");
    const alphaSecondGate = backend.add("alpha-second");
    const betaGate = backend.add("beta-first");

    const alphaFirst = mutation(f, f.alpha, "alpha-first");
    await waitFor(() => backend.entered.has("alpha-first"));

    const alphaSecond = mutation(f, f.alpha, "alpha-second");
    const betaFirst = mutation(f, f.beta, "beta-first");
    await waitFor(() => backend.entered.has("beta-first"));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(backend.entered.has("alpha-second")).toBe(false);
    expect(backend.peakBackendConcurrency()).toBe(2);

    // A slow external authority call must not starve unrelated TeamConfig
    // reads. Lifecycle for the leased Membership is protected by its own
    // lease, not by holding the config lock across backend I/O.
    const configRead = await Promise.race([
      teams.readConfig(f.teamName).then(() => "read" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 300)),
    ]);
    expect(configRead).toBe("read");

    alphaFirstGate.resolve();
    betaGate.resolve();
    await Promise.all([alphaFirst, betaFirst]);
    await waitFor(() => backend.entered.has("alpha-second"));
    alphaSecondGate.resolve();
    await alphaSecond;
  });

  it("makes same-name replacement wait for the old mutation, then rejects the stale Membership and Session before backend I/O", async () => {
    const f = await fixture("replacement");
    const backend = installSlowBackend();
    const oldGate = backend.add("old-in-flight");
    const oldMutation = mutation(f, f.alpha, "old-in-flight");
    await waitFor(() => backend.entered.has("old-in-flight"));

    let replacementFinished = false;
    const replacement = (async () => {
      await teams.withCurrentMembershipLease(f.teamName, f.alpha.membershipId!, async () => {
        await teams.deactivateMembership(f.teamName, f.alpha.membershipId!, "replaced");
      });
      await teams.addMember(f.teamName, member(f.teamName, "alpha"));
      replacementFinished = true;
    })();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(replacementFinished).toBe(false);

    oldGate.resolve();
    await oldMutation;
    await replacement;
    const backendCallsBeforeStaleAttempt = backend.spy.mock.calls.length;

    await expect(mutation(f, f.alpha, "stale-after-replacement"))
      .rejects.toThrow(/stale processes cannot mutate authority state/i);
    expect(backend.spy).toHaveBeenCalledTimes(backendCallsBeforeStaleAttempt);

    const config = await teams.readConfig(f.teamName);
    const alphaGenerations = config.members.filter((candidate) => candidate.name === "alpha");
    expect(alphaGenerations).toHaveLength(2);
    expect(alphaGenerations.filter((candidate) => candidate.isActive !== false)).toHaveLength(1);
    expect(alphaGenerations.find((candidate) => candidate.membershipId === f.alpha.membershipId))
      .toMatchObject({ isActive: false, deactivationReason: "replaced" });
  });

  it("makes shutdown wait for in-flight Membership mutations, then invalidates every stopped writer", async () => {
    const f = await fixture("shutdown");
    const backend = installSlowBackend();
    const betaGate = backend.add("beta-in-flight");
    const betaMutation = mutation(f, f.beta, "beta-in-flight");
    await waitFor(() => backend.entered.has("beta-in-flight"));

    let shutdownFinished = false;
    const shutdown = (async () => {
      const current = (await teams.readConfig(f.teamName)).members.filter((candidate) => candidate.isActive !== false);
      return Promise.all(current.map((candidate) => teams.withCurrentMembershipLease(
        f.teamName,
        candidate.membershipId!,
        async () => teams.deactivateMembership(f.teamName, candidate.membershipId!, "team_shutdown"),
      )));
    })().then((result) => {
      shutdownFinished = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(shutdownFinished).toBe(false);

    betaGate.resolve();
    await betaMutation;
    const result = await shutdown;
    expect(result.map((candidate) => candidate?.membershipId)).toEqual(expect.arrayContaining([
      f.lead.membershipId,
      f.alpha.membershipId,
      f.beta.membershipId,
    ]));
    const backendCallsBeforeStaleAttempt = backend.spy.mock.calls.length;

    await expect(mutation(f, f.beta, "stale-after-shutdown"))
      .rejects.toThrow(/stale processes cannot mutate authority state/i);
    expect(backend.spy).toHaveBeenCalledTimes(backendCallsBeforeStaleAttempt);
    expect((await teams.readConfig(f.teamName)).members.every((candidate) => candidate.isActive === false)).toBe(true);
  });

  it("bounds lease waiting and never runs a timed-out contender", async () => {
    const f = await fixture("bounded-wait");
    const entered = deferred();
    const release = deferred();
    const holder = teams.withMembershipMutationLease(f.teamName, f.alpha.membershipId!, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    const contender = vi.fn(async () => undefined);
    await expect(teams.withMembershipMutationLease(
      f.teamName,
      f.alpha.membershipId!,
      contender,
      { retries: 2 },
    )).rejects.toThrow(/could not acquire lock/i);
    expect(contender).not.toHaveBeenCalled();

    release.resolve();
    await holder;
  });
});
