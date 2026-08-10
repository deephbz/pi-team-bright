import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const readConfig = vi.fn();
const assertCurrentSessionBinding = vi.fn();
const withCurrentSessionBinding = vi.fn();

vi.mock("../utils/teams", () => ({
  readConfig: (...args: unknown[]) => readConfig(...args),
  assertCurrentSessionBinding: (...args: unknown[]) => assertCurrentSessionBinding(...args),
  withCurrentSessionBinding: (...args: unknown[]) => withCurrentSessionBinding(...args),
}));

import { DurableTaskAuthorityTeam } from "./durable-task-authority-team";

const complete = {
  name: "task-authority-team",
  taskBackend: "beads",
  taskWorkspace: "/tmp/task-authority-team",
  taskAuthorityId: "task-authority-1",
  taskAuthorityFingerprint: { schema: "pi-teams-beads-authority/1" },
};

afterEach(() => {
  calls.length = 0;
  vi.resetAllMocks();
});

describe("DurableTaskAuthorityTeam", () => {
  it("projects only a complete authority binding and refuses missing or incomplete configuration", async () => {
    const team = new DurableTaskAuthorityTeam();
    readConfig.mockResolvedValue(complete);
    await expect(team.binding(complete.name)).resolves.toEqual({
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
      await expect(team.binding(complete.name)).rejects.toThrow(`Team ${complete.name} has no complete Beads Task authority binding.`);
    }
  });

  it("uses the exact actor Session and Membership lease before it exposes a backend binding", async () => {
    const team = new DurableTaskAuthorityTeam();
    readConfig.mockImplementation(async () => { calls.push("binding"); return complete; });
    assertCurrentSessionBinding.mockImplementation(async () => {
      calls.push("assert");
      return { membershipId: "member-1" };
    });
    withCurrentSessionBinding.mockImplementation(async (_team: string, _actor: string, _session: string, membership: string, action: () => Promise<unknown>) => {
      calls.push(`lease:${membership}`);
      return action();
    });

    await expect(team.withCurrentActor({
      teamName: complete.name,
      actor: "worker",
      sessionFile: "/tmp/worker.jsonl",
    }, async (binding) => {
      calls.push("backend");
      return binding.workspace;
    })).resolves.toBe(complete.taskWorkspace);
    expect(calls).toEqual(["assert", "lease:member-1", "binding", "backend"]);
    expect(withCurrentSessionBinding).toHaveBeenCalledWith(complete.name, "worker", "/tmp/worker.jsonl", "member-1", expect.any(Function));

    calls.length = 0;
    assertCurrentSessionBinding.mockClear();
    await team.withCurrentActor({
      teamName: complete.name,
      actor: "worker",
      sessionFile: "/tmp/worker.jsonl",
      membershipId: "captured-member",
    }, async () => { calls.push("backend"); });
    expect(assertCurrentSessionBinding).not.toHaveBeenCalled();
    expect(calls).toEqual(["lease:captured-member", "binding", "backend"]);
  });

  it("keeps Team coordinates outside Task contracts and injects one production authority port", () => {
    const root = process.cwd();
    const source = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
    const contracts = source("src/task-authority/contracts.ts");
    const adapter = source("src/model-tool-contract/beads-task-adapter.ts");
    const authority = source("src/model-tool-contract/beads-authority-adapter.ts");
    const extension = source("extensions/index.ts");

    expect(contracts).not.toMatch(/(?:import|export).*TeamConfig/);
    expect(adapter).toContain("teamPort: TaskAuthorityTeamPort,");
    expect(adapter).toContain("publicationPort: TaskMutationPublicationPort,\n  teamPort: TaskAuthorityTeamPort,");
    expect(adapter).toContain("createTask(teamName, input, publicationPort, { actor,");
    expect(adapter).toContain("}, publicationPort, teamPort)");
    expect(adapter).toContain("}, { ...options, ...(actorFence ? { authoritySessionFile: actorFence.sessionFile, authorityMembershipId: actorFence.membershipId } : {}), taskCardProjector: projectTaskCard }, publicationPort, teamPort)");
    const authorityStart = authority.indexOf("async function withAgentMutationAuthority");
    const authorityEnd = authority.indexOf("export interface SemanticTaskUpdate", authorityStart);
    expect(authorityStart).toBeGreaterThanOrEqual(0);
    expect(authorityEnd).toBeGreaterThan(authorityStart);
    const authorityBody = authority.slice(authorityStart, authorityEnd);
    expect(authorityBody).not.toMatch(/if\s*\(teamPort\)/);
    expect(authorityBody).not.toContain("withCurrentSessionBinding");
    expect(extension.match(/const taskAuthorityTeam = new DurableTaskAuthorityTeam\(\);/g)).toHaveLength(1);
    expect(extension.match(/createPublishingBeadsTaskAdapterFactory\(new DurableTaskMutationPublication\(\), taskAuthorityTeam\)/g)).toHaveLength(1);
  });
});
