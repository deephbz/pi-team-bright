import { afterEach, describe, expect, it, vi } from "vitest";

const readConfig = vi.fn();

vi.mock("../utils/teams", () => ({
  readConfig: (...args: unknown[]) => readConfig(...args),
}));

import { DurableTaskAuthorityReadTeam } from "./durable-task-authority-read-team";

const complete = {
  name: "read-team",
  taskBackend: "beads",
  taskWorkspace: "/tmp/read-team",
  taskAuthorityId: "authority-1",
  taskAuthorityFingerprint: { schema: "pi-teams-beads-authority/1" },
};

afterEach(() => vi.resetAllMocks());

describe("DurableTaskAuthorityReadTeam", () => {
  it("preserves legacy storeFor configuration refusals exactly", async () => {
    const team = new DurableTaskAuthorityReadTeam();
    const previous = process.env.PI_TEAMS_BEADS_WORKSPACE;
    process.env.PI_TEAMS_BEADS_WORKSPACE = "/tmp/migrate-here";
    try {
      for (const [config, message] of [
        [{ ...complete, taskBackend: "json" }, `Team ${complete.name} still uses legacy JSON Task authority. Run: npm run migrate:tasks -- ${complete.name} /tmp/migrate-here`],
        [{ ...complete, taskWorkspace: undefined }, `Team ${complete.name} is configured for Beads but has no taskWorkspace. Re-run migration configuration; legacy task files are not a fallback.`],
        [{ ...complete, taskAuthorityId: undefined }, `Team ${complete.name} has an incomplete Beads Task authority binding.`],
        [{ ...complete, taskAuthorityFingerprint: undefined }, `Team ${complete.name} has an incomplete Beads Task authority binding.`],
      ] as const) {
        readConfig.mockResolvedValueOnce(config);
        await expect(team.readBinding(complete.name)).rejects.toThrow(message);
      }
    } finally {
      if (previous === undefined) delete process.env.PI_TEAMS_BEADS_WORKSPACE;
      else process.env.PI_TEAMS_BEADS_WORKSPACE = previous;
    }
  });

  it("keeps the configured fingerprint object as the read binding identity", async () => {
    const team = new DurableTaskAuthorityReadTeam();
    readConfig.mockResolvedValue(complete);

    const binding = await team.readBinding(complete.name);

    expect(binding).toEqual({
      teamName: complete.name,
      workspace: complete.taskWorkspace,
      authorityFingerprint: complete.taskAuthorityFingerprint,
    });
    expect(binding.authorityFingerprint).toBe(complete.taskAuthorityFingerprint);
  });
});
