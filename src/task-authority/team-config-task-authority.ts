/** Versioned external identity evidence for one Beads 1.1 authority. */
export interface BeadsAuthorityFingerprint {
  schema: "pi-teams-beads-authority/1";
  backend: "dolt";
  database: "dolt";
  doltDatabase: string;
  projectId: string;
}

/** Task-authority binding persisted on the Team record. */
export interface TeamConfigTaskAuthority {
  /** Task authority. Omitted means the historical local JSON store. */
  taskBackend?: "legacy" | "beads";
  /** Stable opaque authority identity; independent of workspace path spelling. */
  taskAuthorityId?: string;
  /** Canonical external evidence binding the opaque identity to one Beads DB. */
  taskAuthorityFingerprint?: BeadsAuthorityFingerprint;
  /** Absolute working directory containing the team's initialized Beads repo. */
  taskWorkspace?: string;
  /** Durable evidence for the one-way legacy -> Beads cutover. */
  taskCutover?: {
    inventoryPath: string;
    inventorySha256: string;
    markerPath?: string;
    cutoverAt: string;
  };
}
