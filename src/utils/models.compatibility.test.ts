import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { THINKING_LEVELS as legacyThinkingLevels } from "./models";
import { THINKING_LEVELS as canonicalThinkingLevels } from "../team-authority/contracts";
import type { TeamConfig as CompatibilityTeamConfig } from "../team-authority/team-config-compatibility";
import type { TeamConfigSyncLiveness } from "../coordination/team-config-sync-liveness";
import type { TeamConfigTaskAuthority } from "../task-authority/team-config-task-authority";
import {
  TaskCardSchema as legacyTaskCardSchema,
  TASK_CARD_CONTEXT_MAX_LENGTH as legacyTaskCardContextMaxLength,
} from "../model-tool-contract/task-domain";
import {
  TaskVersionRefSchema as legacyTaskVersionRefSchema,
  taskVersionRef as legacyTaskVersionRef,
} from "../model-tool-contract/task-version-ref";
import {
  TaskCardSchema as canonicalTaskCardSchema,
  TASK_CARD_CONTEXT_MAX_LENGTH as canonicalTaskCardContextMaxLength,
} from "../task-authority/task-domain";
import {
  TaskVersionRefSchema as canonicalTaskVersionRefSchema,
  taskVersionRef as canonicalTaskVersionRef,
} from "../task-authority/task-version-ref";
import type {
  AlertKind as LegacyAlertKind,
  AlertTeamEvent as LegacyAlertTeamEvent,
  BeadsAuthorityFingerprint as LegacyBeadsAuthorityFingerprint,
  IdentifiedInboxMessage as LegacyIdentifiedInboxMessage,
  InboxMessage as LegacyInboxMessage,
  LogicalWorker as LegacyLogicalWorker,
  Member as LegacyMember,
  TaskEventChange as LegacyTaskEventChange,
  TaskRelation as LegacyTaskRelation,
  TaskRelationType as LegacyTaskRelationType,
  TaskStatus as LegacyTaskStatus,
  TaskTeamEvent as LegacyTaskTeamEvent,
  TeamConfig as LegacyTeamConfig,
  TeamEvent as LegacyTeamEvent,
  TeamEventInput as LegacyTeamEventInput,
  TeamEventType as LegacyTeamEventType,
  TerminalTarget as LegacyTerminalTarget,
  ThinkingLevel as LegacyThinkingLevel,
  WorkerEventPhase as LegacyWorkerEventPhase,
  WorkerRuntimeGenerationEvidence as LegacyWorkerRuntimeGenerationEvidence,
  WorkerTeamEvent as LegacyWorkerTeamEvent,
} from "./models";
import type {
  BeadsAuthorityFingerprint,
  LogicalWorker,
  Member,
  TeamConfig,
  TerminalTarget,
  ThinkingLevel,
} from "../team-authority/contracts";
import type { AlertKind } from "../alert-authority/contracts";
import type { IdentifiedInboxMessage, InboxMessage } from "../alert-authority/delivery-contracts";
import type { TaskRelation, TaskRelationType, TaskStatus } from "../task-authority/contracts";
import type { TaskVersionRef } from "../task-authority/task-version-ref";
import type {
  AlertTeamEvent,
  TaskEventChange,
  TaskTeamEvent,
  TeamEvent,
  TeamEventInput,
  TeamEventType,
  WorkerEventPhase,
  WorkerRuntimeGenerationEvidence,
  WorkerTeamEvent,
} from "../coordination/contracts";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type Expect<Value extends true> = Value;

type LegacyExportsRemainCanonical = [
  Expect<Equal<LegacyThinkingLevel, ThinkingLevel>>,
  Expect<Equal<LegacyTerminalTarget, TerminalTarget>>,
  Expect<Equal<LegacyMember, Member>>,
  Expect<Equal<LegacyBeadsAuthorityFingerprint, BeadsAuthorityFingerprint>>,
  Expect<Equal<LegacyLogicalWorker, LogicalWorker>>,
  Expect<Equal<LegacyTeamConfig, TeamConfig>>,
  Expect<Equal<TeamConfig, CompatibilityTeamConfig>>,
  Expect<TeamConfig extends TeamConfigSyncLiveness & TeamConfigTaskAuthority ? true : false>,
  Expect<Equal<LegacyTaskStatus, TaskStatus>>,
  Expect<Equal<LegacyTaskRelationType, TaskRelationType>>,
  Expect<Equal<LegacyTaskRelation, TaskRelation>>,
  Expect<Equal<LegacyTeamEventType, TeamEventType>>,
  Expect<Equal<LegacyTaskEventChange, TaskEventChange>>,
  Expect<Equal<LegacyTaskTeamEvent, TaskTeamEvent>>,
  Expect<Equal<LegacyWorkerEventPhase, WorkerEventPhase>>,
  Expect<Equal<LegacyWorkerRuntimeGenerationEvidence, WorkerRuntimeGenerationEvidence>>,
  Expect<Equal<LegacyWorkerTeamEvent, WorkerTeamEvent>>,
  Expect<Equal<LegacyAlertTeamEvent, AlertTeamEvent>>,
  Expect<Equal<LegacyAlertKind, AlertKind>>,
  Expect<Equal<LegacyTeamEvent, TeamEvent>>,
  Expect<Equal<LegacyTeamEventInput, TeamEventInput>>,
  Expect<Equal<Extract<TeamEvent, { type: "task" }>["ref"]["version"], TaskVersionRef>>,
  Expect<Equal<LegacyInboxMessage, InboxMessage>>,
  Expect<Equal<LegacyIdentifiedInboxMessage, IdentifiedInboxMessage>>,
];
void (null as unknown as LegacyExportsRemainCanonical);

function imports(relativePath: string): string[] {
  return [...readFileSync(path.join(process.cwd(), "src", relativePath), "utf8").matchAll(/from\s+["']([^"']+)["']/g)]
    .map((match) => match[1]);
}

describe("models compatibility and authority contract fences", () => {
  it("keeps historical runtime exports identical to their canonical contracts", () => {
    expect(legacyThinkingLevels).toBe(canonicalThinkingLevels);
    expect(legacyTaskCardSchema).toBe(canonicalTaskCardSchema);
    expect(legacyTaskCardContextMaxLength).toBe(canonicalTaskCardContextMaxLength);
    expect(legacyTaskVersionRefSchema).toBe(canonicalTaskVersionRefSchema);
    expect(legacyTaskVersionRef).toBe(canonicalTaskVersionRef);
  });

  it("keeps TeamConfig compatibility at a typed consumer-owned seam", () => {
    expect(imports("team-authority/contracts.ts")).toEqual([
      "../task-authority/team-config-task-authority",
      "./team-config-compatibility",
    ]);
    expect(imports("team-authority/team-config-compatibility.ts")).toEqual([
      "../coordination/team-config-sync-liveness",
      "../task-authority/team-config-task-authority",
      "../utils/team-pane-layout",
      "./contracts",
    ]);
    expect(imports("coordination/team-config-sync-liveness.ts")).toEqual([]);
    expect(imports("task-authority/team-config-task-authority.ts")).toEqual([]);
  });

  it("keeps authority contract imports free of Trio and authority implementations", () => {
    const taskContractImports = imports("task-authority/contracts.ts");
    expect(taskContractImports).toEqual(["./task-domain", "./task-version-ref"]);
    expect(taskContractImports).not.toContain("../utils/beads");
    expect(taskContractImports.every((specifier) => !specifier.includes("/utils/"))).toBe(true);
    expect(imports("task-authority/task-domain.ts")).toEqual(["typebox", "./task-version-ref"]);
    expect(imports("task-authority/task-version-ref.ts")).toEqual(["node:crypto", "typebox"]);
    expect(imports("alert-authority/delivery-contracts.ts")).toEqual([]);
    expect(imports("coordination/contracts.ts")).toEqual([]);
  });
});
