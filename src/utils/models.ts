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

export type TaskStatus = "open" | "in_progress" | "blocked" | "closed";

export type TaskRelationType = "parent" | "blocked_by" | "related";

export interface TaskRelation {
  relation: TaskRelationType;
  targetId: string;
}

/**
 * PiTeams' deliberately small Task projection. Beads owns persistence,
 * history, graph validation, and concurrency; this type exposes only the
 * coordinates an agent needs to collaborate safely.
 */
export interface TaskFile {
  id: string;
  title: string;
  description: string;
  /** Observable success criteria used by the assignee to self-verify the work. */
  acceptanceCriteria: string;
  design?: string;
  status: TaskStatus;
  assignee?: string;
  notes?: string;
  relations: TaskRelation[];
  /** Exact authority revision used for optimistic concurrency and review. */
  version: string;
  /** Evidence identifying the authority that produced this projection. */
  provenance: {
    authority: "beads";
    teamName: string;
  };
}

/** Compact query projection; re-read the full Task before a conditional write. */
export type TaskListItem = Omit<TaskFile, "version">;

export type TeamEventType = "task" | "worker" | "alert";

export type TaskEventChange = "created" | "assigned" | "design" | "note" | "status" | "relation";

export interface TaskTeamEvent {
  type: "task";
  cursor: string;
  ref: {
    authorityId: string;
    taskId: string;
    version: string;
  };
  change: TaskEventChange;
  actor: string;
  at: string;
}

export type WorkerEventPhase = "prepared" | "session_bound" | "stopped" | "failed";

export interface WorkerTeamEvent {
  type: "worker";
  cursor: string;
  worker: string;
  membershipId: string;
  phase: WorkerEventPhase;
  at: string;
}

export type AlertKind = "clarification" | "attention" | "announcement";

export interface AlertTeamEvent {
  type: "alert";
  cursor: string;
  alertId: string;
  from: string;
  to: string | "*";
  taskRef?: {
    taskId: string;
    version?: string;
  };
  kind: AlertKind;
  text: string;
  at: string;
}

/** Ordered observation of committed state; it is not a second Task or Worker authority. */
export type TeamEvent = TaskTeamEvent | WorkerTeamEvent | AlertTeamEvent;

export type TeamEventInput =
  | Omit<TaskTeamEvent, "cursor" | "at">
  | Omit<WorkerTeamEvent, "cursor" | "at">
  | Omit<AlertTeamEvent, "cursor" | "at">;

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
