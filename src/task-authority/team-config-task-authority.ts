/** Historical identity evidence retained for decoding old Team records. */
export interface BeadsAuthorityFingerprint {
  schema: "pi-teams-beads-authority/1";
  backend: "dolt";
  database: "dolt";
  doltDatabase: string;
  projectId: string;
}

/** Retired Team fields. A valid graph is authoritative regardless of these values. */
export interface TeamConfigTaskAuthority {
  /** Used only to identify an unsupported graphless Team. */
  taskBackend?: "legacy" | "beads";
  /** Stable opaque authority identity; independent of workspace path spelling. */
  taskAuthorityId?: string;
  /** Canonical external evidence binding the opaque identity to one Beads DB. */
  taskAuthorityFingerprint?: BeadsAuthorityFingerprint;
  /** Absolute working directory containing the team's initialized Beads repo. */
  taskWorkspace?: string;
  /** Historical cutover evidence; current runtime never performs this operation. */
  taskCutover?: {
    inventoryPath: string;
    inventorySha256: string;
    markerPath?: string;
    cutoverAt: string;
  };
}
