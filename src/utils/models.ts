export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface Member {
  /** Unique identity for this one Team membership generation. */
  membershipId?: string;
  /** Single-use capability accepted only while this generation is unbound. */
  pendingLaunchId?: string;
  launchConsumedAt?: string;
  agentId: string;
  name: string;
  agentType: string;
  model?: string;
  joinedAt: number;
  tmuxPaneId: string;
  /** Durable Pi session identity, recorded after the teammate's first start. */
  sessionFile?: string;
  windowId?: string;
  cwd: string;
  subscriptions: any[];
  prompt?: string;
  color?: string;
  thinking?: ThinkingLevel;
  backendType?: string;
  isActive?: boolean;
  /** Durable lifecycle evidence; inactive members remain historical identities. */
  deactivatedAt?: string;
  deactivationReason?: "team_shutdown" | "process_shutdown" | "replaced";
}

/** Versioned external identity evidence for one Beads 1.1 authority. */
export interface BeadsAuthorityFingerprint {
  schema: "pi-teams-beads-authority/1";
  backend: "dolt";
  database: "dolt";
  doltDatabase: string;
  projectId: string;
}

export interface TeamConfig {
  name: string;
  description: string;
  createdAt: number;
  leadAgentId: string;
  leadSessionId: string;
  members: Member[];
  defaultModel?: string;
  separateWindows?: boolean;
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

export interface TaskFile {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: "pending" | "planning" | "in_progress" | "blocked" | "completed" | "deleted";
  plan?: string;
  planFeedback?: string;
  blocks: string[];
  blockedBy: string[];
  owner?: string;
  metadata?: Record<string, any>;
  /** Store-native optimistic concurrency token, when the backend supplies one. */
  version?: string;
}

export interface InboxMessage {
  /** Communication-authority identity. Optional only for legacy on-disk records. */
  id?: string;
  /** Exact destination membership generation. Absent only on historical legacy records. */
  recipientMembershipId?: string;
  /** Exact sender membership generation when the sender is a current Team member. */
  senderMembershipId?: string;
  from: string;
  text: string;
  timestamp: string;
  read: boolean;
  summary?: string;
  color?: string;
}

/** An inbox Message after the storage boundary has assigned or migrated its ID. */
export interface IdentifiedInboxMessage extends InboxMessage {
  id: string;
}
