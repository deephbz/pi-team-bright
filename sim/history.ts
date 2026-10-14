import type { ExecOutcome, ExecResult, ProcessGeneration } from "../src/env/host-env";
import type { ActorRef, Fault, WorldStep } from "./trace-format";
export type { ActorRef, Fault, WorldStep } from "./trace-format";
export type { ExecOutcome, ExecResult, ProcessGeneration } from "../src/env/host-env";

/** Observable facts only. Optional wire fields remain absent on old PTB versions. */
export const HISTORY_VERSION = 1 as const;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type HistoryOrigin =
  | { kind: "ptb"; actor: ActorRef; toolCallId?: string; execCallId?: string }
  | { kind: "human" | "os"; input: number }
  | { kind: "setup" | "observer" };
export type ProcessIdentity =
  | { processKind: "worker_pi"; membershipId: string }
  | { processKind: "lead_pi" | "shell" | "other"; membershipId?: never };
/** Missing classification identifies legacy history. Launch identity does not prove admission. */
export type ProcessFact = { actorKey: string; generation: ProcessGeneration; command: string; parentPid?: number }
  & (ProcessIdentity | { processKind?: undefined; membershipId?: undefined });
export interface PaneFact { paneId: string; shellPid: number; agentPid?: number }
export interface ToolResultFact { content?: Json[]; details?: JsonObject; isError?: boolean }
export interface ObservationStamp { team: string; epoch: string; binding: string; from: number; through: number }
export interface CarrierJournalFact {
  field?: string;
  to?: string;
  generation?: JsonObject;
  cause?: JsonObject;
  paneId?: string;
  suspectedHumanStop?: boolean;
  nextActionHint?: string;
}
export interface JournalFact {
  raw: JsonObject;
  carrier?: CarrierJournalFact;
  type: string;
  cursor?: string;
  seq?: number;
  at?: string;
  phase?: string;
  cause?: string;
  paneId?: string;
  suspectedHumanStop?: boolean;
  worker?: string;
  membershipId?: string;
  generation?: JsonObject;
}
export interface LaunchFact {
  raw: JsonObject;
  membershipId?: string;
  worker?: string;
  pendingLaunchId?: string;
  launchConsumedAt?: string;
}
export interface RuntimeFact {
  raw: JsonObject;
  teamName?: string;
  agentName?: string;
  membershipId?: string;
  pid?: number;
  startedAt?: number;
  bootId?: string;
  osBirthToken?: string;
  lastHeartbeatAt?: number;
  ready?: boolean;
}
export type HistoryFact =
  | { kind: "step.begin"; operationId: number; label: string; actor?: ActorRef }
  | { kind: "step.end"; operationId: number; label: string; actor?: ActorRef }
  | { kind: "world.input"; input: number; step: WorldStep }
  | { kind: "process.birth"; process: ProcessFact }
  | { kind: "process.death"; process: ProcessFact }
  | { kind: "pane.create"; pane: PaneFact }
  | { kind: "pane.close"; pane: PaneFact }
  | { kind: "fault.set"; fault: Fault }
  | { kind: "fault.effect"; source: Fault["source"]; detail: string }
  | { kind: "fault.clear"; source: Fault["source"] }
  | { kind: "exec.call"; actor: ActorRef; callId: string; mode: "sync" | "async"; command: string; args: string[]; timeoutMs?: number }
  | { kind: "exec.result"; actor: ActorRef; callId: string; outcome: ExecOutcome | { kind: "threw"; message: string } }
  | { kind: "exec.effect"; actor: ActorRef; callId: string; result: ExecResult }
  | { kind: "tool.call"; actor: ActorRef; callId: string; name: string; args: JsonObject }
  | { kind: "tool.result"; actor: ActorRef; callId: string; name: string; result: ToolResultFact }
  | { kind: "tool.error"; actor: ActorRef; callId: string; name: string; message: string }
  | { kind: "journal.append"; team: string; path: string; line: number; event: JournalFact }
  | { kind: "journal.reset"; team: string; path: string }
  | { kind: "durable.runtime"; team: string; path: string; record: RuntimeFact | null }
  | { kind: "durable.launch"; team: string; path: string; source: "file" | "member"; record: LaunchFact | null }
  | { kind: "durable.team"; team: string; path: string; record: JsonObject | null }
  | { kind: "durable.record"; team: string; path: string; record: Json }
  | { kind: "authority.write"; path: string }
  | { kind: "authority.tracing" }
  | { kind: "disk.invalid"; team: string; path: string; text: string; message: string }
  | { kind: "lead.branch"; actor: ActorRef; sessionId: string; entryIds: string[] }
  | { kind: "lead.entry"; actor: ActorRef; sessionId: string; entryId: string; entry: JsonObject; stamp?: ObservationStamp; toolCallId?: string }
  | { kind: "ui.notify"; actor: ActorRef; message: string; level?: string }
  | { kind: "pi.message"; actor: ActorRef; message: JsonObject; options?: JsonObject }
  | { kind: "pi.userMessage"; actor: ActorRef; content: string }
  | { kind: "terminal.input"; pane: string; text: string }
  | { kind: "test.sample"; value: Json };
export type HistoryEntry = HistoryFact & { version: typeof HISTORY_VERSION; sequence: number; at: number; origin: HistoryOrigin };

export function actorRef(key: string): ActorRef {
  const slash = key.indexOf("/");
  return slash < 0 ? { team: "sim", actor: key } : { team: key.slice(0, slash), actor: key.slice(slash + 1) };
}
/** JSON matches the public wire. It drops absent properties without mutating the source. */
export function json(value: unknown): Json { return JSON.parse(JSON.stringify(value)) as Json; }
export function object(value: Json | undefined): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
