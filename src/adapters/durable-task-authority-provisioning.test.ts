import { afterEach, describe, expect, it, vi } from "vitest";

const assertWorkspaceRoot = vi.fn();
const storeAssertWorkspaceRoot = vi.fn();
const storeList = vi.fn();
const teamExists = vi.fn();
const readConfig = vi.fn();

vi.mock("../utils/beads", () => ({
  BeadsTaskStore: class {
    assertWorkspaceRoot = storeAssertWorkspaceRoot;
    list = storeList;
  },
  assertBeadsWorkspaceRoot: (...args: unknown[]) => assertWorkspaceRoot(...args),
  initializeBeadsWorkspace: vi.fn(),
  readBeadsAuthorityFingerprint: vi.fn(),
}));
vi.mock("../utils/teams", () => ({
  assertNoOrphanedBeadsCutover: vi.fn(),
  readConfig: (...args: unknown[]) => readConfig(...args),
  teamExists: (...args: unknown[]) => teamExists(...args),
}));
vi.mock("../utils/paths", () => ({ teamDir: vi.fn() }));

import { DurableTaskAuthorityProvisioning } from "./durable-task-authority-provisioning";

const fingerprint = {
  schema: "pi-teams-beads-authority/1" as const,
  backend: "dolt" as const,
  database: "dolt" as const,
  doltDatabase: "provisioning-test",
  projectId: "provisioning-test",
};

afterEach(() => vi.resetAllMocks());

describe("DurableTaskAuthorityProvisioning", () => {
  it("returns a frozen copy of an existing authority fingerprint", async () => {
    teamExists.mockReturnValue(true);
    readConfig.mockResolvedValue({
      taskBackend: "beads",
      taskWorkspace: "/tmp/provisioning-test",
      taskAuthorityId: "authority-test",
      taskAuthorityFingerprint: fingerprint,
    });
    storeAssertWorkspaceRoot.mockResolvedValue(undefined);
    storeList.mockResolvedValue([]);

    const snapshot = await new DurableTaskAuthorityProvisioning().resolve("team");

    expect(snapshot.fingerprint).toEqual(fingerprint);
    expect(snapshot.fingerprint).not.toBe(fingerprint);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.fingerprint)).toBe(true);
    expect(Reflect.set(snapshot.fingerprint, "projectId", "mutated")).toBe(false);
    expect(snapshot.fingerprint.projectId).toBe("provisioning-test");
    expect(fingerprint.projectId).toBe("provisioning-test");
  });
});
