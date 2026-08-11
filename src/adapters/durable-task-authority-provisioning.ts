import path from "node:path";
import crypto from "node:crypto";
import type { TaskAuthorityProvisioningPort, TaskAuthorityProvisioningSnapshot } from "../task-authority/contracts";
import {
  BeadsTaskStore,
  assertBeadsWorkspaceRoot,
  initializeBeadsWorkspace,
  readBeadsAuthorityFingerprint,
} from "../utils/beads";
import { assertNoOrphanedBeadsCutover, readConfig, teamExists } from "../utils/teams";
import { teamDir } from "../utils/paths";

export const BEADS_WORKSPACE_ENV = "PI_TEAMS_BEADS_WORKSPACE";

function immutableSnapshot(
  workspace: string,
  authorityId: string,
  fingerprint: TaskAuthorityProvisioningSnapshot["fingerprint"],
): TaskAuthorityProvisioningSnapshot {
  return Object.freeze({
    workspace,
    authorityId,
    fingerprint: Object.freeze({ ...fingerprint }),
  });
}

function configuredBeadsWorkspace(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const workspace = env[BEADS_WORKSPACE_ENV]?.trim();
  if (!workspace) return undefined;
  if (!path.isAbsolute(workspace)) throw new Error(`${BEADS_WORKSPACE_ENV} must be an absolute path: ${workspace}`);
  return workspace;
}

/** Durable Team adapter for Task authority creation and reconnection snapshots. */
export class DurableTaskAuthorityProvisioning implements TaskAuthorityProvisioningPort {
  async resolve(teamName: string): Promise<TaskAuthorityProvisioningSnapshot> {
    if (teamExists(teamName)) {
      const existing = await readConfig(teamName);
      if (existing.taskBackend !== "beads" || !existing.taskWorkspace) {
        const target = process.env[BEADS_WORKSPACE_ENV]?.trim() || "<absolute-beads-workspace>";
        throw new Error(`Team ${teamName} still uses legacy JSON Task authority. Run: npm run migrate:tasks -- ${teamName} ${target}`);
      }
      if (!existing.taskAuthorityId || !existing.taskAuthorityFingerprint) {
        throw new Error(`Team ${teamName} has an incomplete Beads Task authority binding; restore taskAuthorityId and taskAuthorityFingerprint through an explicit recovery review.`);
      }
      assertBeadsWorkspaceRoot(existing.taskWorkspace);
      const store = new BeadsTaskStore({
        teamName,
        workspace: existing.taskWorkspace,
        authorityFingerprint: existing.taskAuthorityFingerprint,
        requireExpectedVersion: true,
      });
      await store.assertWorkspaceRoot();
      await store.list();
      return immutableSnapshot(existing.taskWorkspace, existing.taskAuthorityId, existing.taskAuthorityFingerprint);
    }
    assertNoOrphanedBeadsCutover(teamName);
    const configuredWorkspace = configuredBeadsWorkspace();
    const workspace = configuredWorkspace || teamDir(teamName);
    const fingerprint = configuredWorkspace
      ? readBeadsAuthorityFingerprint(workspace)
      : await initializeBeadsWorkspace(workspace);
    const store = new BeadsTaskStore({ teamName, workspace, authorityFingerprint: fingerprint, requireExpectedVersion: true });
    await store.assertWorkspaceRoot();
    await store.list();
    return immutableSnapshot(workspace, `task_authority_${crypto.randomUUID()}`, fingerprint);
  }
}
