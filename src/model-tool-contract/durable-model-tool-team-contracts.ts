import type { BeadsAuthorityFingerprint } from "../team-authority/contracts";

export interface TeamTaskAuthorityBinding {
  workspace: string;
  authorityId: string;
  fingerprint: BeadsAuthorityFingerprint;
}

/** Consumer contract for Team creation's existing Task-workspace binding. */
export interface TeamTaskAuthorityResolver {
  resolve(teamName: string): Promise<TeamTaskAuthorityBinding>;
}
