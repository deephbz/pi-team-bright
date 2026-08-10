/**
 * Compatibility surface for historical internal imports.
 *
 * Authority-owned contracts live beside their owning authority. Keep this file
 * as re-exports until consumers can use those canonical paths directly.
 */
export { THINKING_LEVELS, } from "../team-authority/contracts";
export type { ThinkingLevel, TerminalTarget, Member, BeadsAuthorityFingerprint, LogicalWorker, TeamConfig, } from "../team-authority/contracts";
export type { TaskStatus, TaskRelationType, TaskRelation, } from "../task-authority/contracts";
export type { TeamEventType, TaskEventChange, TaskTeamEvent, WorkerEventPhase, WorkerRuntimeGenerationEvidence, WorkerTeamEvent, AlertTeamEvent, TeamEvent, TeamEventInput, } from "../coordination/contracts";
export type { AlertKind } from "../alert-authority/contracts";
export type { InboxMessage, IdentifiedInboxMessage, } from "../alert-authority/delivery-contracts";
