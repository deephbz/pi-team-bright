import { afterEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const readConfig = vi.fn();
const assertCurrentSessionBinding = vi.fn();
const withCurrentSessionBinding = vi.fn();

vi.mock("../../src/utils/teams", () => ({
  readConfig: (...args: unknown[]) => readConfig(...args),
  assertCurrentSessionBinding: (...args: unknown[]) => assertCurrentSessionBinding(...args),
  withCurrentSessionBinding: (...args: unknown[]) => withCurrentSessionBinding(...args),
}));

import { createTaskAuthorityTeamPort } from "./task-authority-team-port";

const complete = {
  name: "task-authority-team",
  taskBackend: "beads",
  taskWorkspace: "/tmp/task-authority-team",
  taskAuthorityId: "task-authority-1",
  taskAuthorityFingerprint: { schema: "pi-teams-beads-authority/1" },
};

const actor = {
  teamName: complete.name,
  actor: "worker",
  sessionFile: "/tmp/worker.jsonl",
};

afterEach(() => {
  calls.length = 0;
  vi.resetAllMocks();
});

describe("createTaskAuthorityTeamPort", () => {
  it("projects only a complete authority binding and preserves the durable refusal", async () => {
    const port = createTaskAuthorityTeamPort();
    readConfig.mockResolvedValue(complete);
    await expect(port.binding(complete.name)).resolves.toEqual({
      teamName: complete.name,
      workspace: complete.taskWorkspace,
      authorityFingerprint: complete.taskAuthorityFingerprint,
    });

    for (const config of [
      { ...complete, taskBackend: undefined },
      { ...complete, taskWorkspace: undefined },
      { ...complete, taskAuthorityId: undefined },
      { ...complete, taskAuthorityFingerprint: undefined },
    ]) {
      readConfig.mockResolvedValue(config);
      await expect(port.binding(complete.name)).rejects.toThrow(`Team ${complete.name} has no complete Beads Task authority binding.`);
    }
  });

  it("resolves an uncaptured Membership before acquiring its exact lease and binding", async () => {
    const port = createTaskAuthorityTeamPort();
    assertCurrentSessionBinding.mockImplementation(async () => {
      calls.push("assert");
      return { membershipId: "member-1" };
    });
    withCurrentSessionBinding.mockImplementation(async (_team, _actor, _session, membership, action) => {
      calls.push(`lease:${membership}`);
      return action();
    });
    readConfig.mockImplementation(async () => { calls.push("binding"); return complete; });

    await expect(port.withCurrentActor(actor, async (binding) => {
      calls.push("action");
      return binding.workspace;
    })).resolves.toBe(complete.taskWorkspace);

    expect(calls).toEqual(["assert", "lease:member-1", "binding", "action"]);
    expect(withCurrentSessionBinding).toHaveBeenCalledWith(complete.name, actor.actor, actor.sessionFile, "member-1", expect.any(Function));
  });

  it("uses a nonempty captured Membership ID as the exact lease without resolution", async () => {
    const port = createTaskAuthorityTeamPort();
    withCurrentSessionBinding.mockImplementation(async (_team, _actor, _session, membership, action) => {
      calls.push(`lease:${membership}`);
      return action();
    });
    readConfig.mockImplementation(async () => { calls.push("binding"); return complete; });

    await port.withCurrentActor({ ...actor, membershipId: "captured-member" }, async () => { calls.push("action"); });

    expect(assertCurrentSessionBinding).not.toHaveBeenCalled();
    expect(calls).toEqual(["lease:captured-member", "binding", "action"]);
  });

  it("falls back to current Membership resolution when the captured ID is empty", async () => {
    const port = createTaskAuthorityTeamPort();
    assertCurrentSessionBinding.mockResolvedValue({ membershipId: "resolved-member" });
    withCurrentSessionBinding.mockImplementation(async (_team, _actor, _session, membership, action) => {
      calls.push(`lease:${membership}`);
      return action();
    });
    readConfig.mockResolvedValue(complete);

    await port.withCurrentActor({ ...actor, membershipId: "" }, async () => undefined);

    expect(assertCurrentSessionBinding).toHaveBeenCalledWith(complete.name, actor.actor, actor.sessionFile);
    expect(withCurrentSessionBinding).toHaveBeenCalledWith(complete.name, actor.actor, actor.sessionFile, "resolved-member", expect.any(Function));
  });

  it("refuses a resolved Membership without an ID before a lease or action", async () => {
    const port = createTaskAuthorityTeamPort();
    assertCurrentSessionBinding.mockResolvedValue({ membershipId: "" });

    await expect(port.withCurrentActor(actor, async () => { calls.push("action"); })).rejects.toThrow(
      `Current Membership for ${actor.actor} on team ${complete.name} has no membershipId.`,
    );

    expect(withCurrentSessionBinding).not.toHaveBeenCalled();
    expect(readConfig).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("refuses a stale captured lease before binding or action", async () => {
    const port = createTaskAuthorityTeamPort();
    const refusal = new Error("stale lease");
    withCurrentSessionBinding.mockRejectedValue(refusal);

    await expect(port.withCurrentActor({ ...actor, membershipId: "replaced-worker" }, async () => { calls.push("action"); })).rejects.toBe(refusal);

    expect(assertCurrentSessionBinding).not.toHaveBeenCalled();
    expect(withCurrentSessionBinding).toHaveBeenCalledWith(complete.name, actor.actor, actor.sessionFile, "replaced-worker", expect.any(Function));
    expect(readConfig).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});
