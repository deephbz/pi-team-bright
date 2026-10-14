import type { ExactLeaderSessionId, ModelToolTeamCurrent, ModelToolWorkerCurrent, ModelToolTeamEvent, PendingObservation, TeamSyncPortResult } from "./model-tool-contracts";
import type { CanonicalTaskCard } from "../task-authority/task-domain";
import type { GraphTaskController } from "../task-authority/graph-control";
import type { ModelToolTaskJournalEntry } from "../task-authority/contracts";

export type InMemoryTeamRecord = { id: string; leaderSessionId: ExactLeaderSessionId; name: string; purpose: string; workers: Map<string, ModelToolWorkerCurrent> };
export type InMemoryTaskRecord = { controller: GraphTaskController; tasks: Map<string, CanonicalTaskCard>; journals: Map<string, ModelToolTaskJournalEntry[]> };
export type InMemoryAlertDelivery = { id: string; teamId: string; recipients: string[]; kind: "clarification" | "attention" | "announcement"; text: string };
export type InMemoryEvent = ModelToolTeamEvent & { teamId: string };

declare const teamStateBrand: unique symbol;
declare const taskStateBrand: unique symbol;
declare const alertStateBrand: unique symbol;
declare const coordinationStateBrand: unique symbol;
export type InMemoryTeamState = { readonly [teamStateBrand]: true; readonly teams: Map<string, InMemoryTeamRecord>; readonly names: Map<string, string>; readonly bindings: Map<ExactLeaderSessionId, string>; next: number };
export type InMemoryTaskState = { readonly [taskStateBrand]: true; readonly byTeam: Map<string, InMemoryTaskRecord>; nextTask: number; nextJournal: number };
export type InMemoryAlertState = { readonly [alertStateBrand]: true; nextAlert: number; deliveries: InMemoryAlertDelivery[] };
export type InMemorySupportRevisionClock = { revision: number };
export const inMemorySupportRevisionClock = (): InMemorySupportRevisionClock => ({ revision: 0 });
export type InMemoryCoordinationState = { readonly [coordinationStateBrand]: true; failPublications: { task: number; alert: number } };
export function inMemoryTeamState(): InMemoryTeamState { return { teams: new Map(), names: new Map(), bindings: new Map(), next: 1 } as InMemoryTeamState; }
export function inMemoryTaskState(): InMemoryTaskState { return { byTeam: new Map(), nextTask: 1, nextJournal: 1 } as InMemoryTaskState; }
export function inMemoryAlertState(): InMemoryAlertState { return { nextAlert: 1, deliveries: [] } as unknown as InMemoryAlertState; }
export function inMemoryCoordinationState(): InMemoryCoordinationState { return { failPublications: { task: 0, alert: 0 } } as unknown as InMemoryCoordinationState; }
