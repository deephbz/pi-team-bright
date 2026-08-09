import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { StringEnum } from "@earendil-works/pi-ai";
import * as paths from "../src/utils/paths";
import * as teams from "../src/utils/teams";
import * as tasks from "../src/utils/tasks";
import * as alerts from "../src/utils/alerts";
import * as teamEvents from "../src/utils/team-events";
import { createToolResultRenderer } from "../src/model-tool-contract/tui-projection";
import {
  DirectMessageDelivery,
  messagePollMs,
} from "../src/utils/message-delivery";
import {
  TaskChangeDelivery,
  taskPollMs,
} from "../src/utils/task-delivery";
import * as runtime from "../src/utils/runtime";
import { loadSyncLivenessSettings } from "../src/utils/sync-liveness-settings";
import { createSyncNudgeRecord, findSyncNudgeReservation, presentSyncNudge, readSyncNudges, reserveSyncNudge, SYNC_NUDGE_CUSTOM_TYPE, validateSyncNudgeRecord, syncNudgeContent, syncNudgeTuiLine } from "../src/utils/sync-nudge";
import { SyncNudgeConductor, type SyncNudgeDebt } from "../src/utils/sync-nudge-conductor";
import { loadWorkerResourcePolicy, materializeWorkerAggregate, ownsWorkerAggregate, projectWorkerTools, removeWorkerAggregate, resolveQualifiedWorkerDefaultModel, resolveWorkerLaunchResources, type WorkerResourcePolicy } from "../src/utils/worker-resource-projection";
import { clearTeamFooter, syncTeamFooter } from "../src/utils/team-footer";
import { IdentifiedInboxMessage, Member, TeamConfig } from "../src/utils/models";
import { getTerminalAdapter } from "../src/adapters/terminal-registry";
import { assertTeamTerminalTarget, hasPersistedTerminalTarget, memberTerminalTarget, terminalTarget } from "../src/utils/terminal-target";
import { assertTargetSupportedByTerminal, terminalForTeam } from "../src/utils/team-terminal";
import {
  admitTeamSession,
  placeSessionTerminal,
  type TeamIdentitySource,
  type TeamSessionAdmission,
} from "../src/utils/session-terminal";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { registerAutomaticSummaryPolicyProvider } from "../src/utils/automatic-summary-policy";
import { createWorkerLaunchBridge, launchObservationState, WorkerDefaultModelConfigurationError, type WorkerAggregate } from "../src/utils/worker-launch-bridge";
import { createPublishingBeadsTaskAdapterFactory } from "../src/model-tool-contract/beads-task-adapter";
import { DurableTaskMutationPublication } from "../src/adapters/durable-task-mutation-publication";
import { BeadsTaskReconciliationQuery } from "../src/task-authority/beads-reconciliation-query";

import { TaskVersionRefSchema } from "../src/model-tool-contract/catalog";
import { taskVersionRef } from "../src/model-tool-contract/task-version-ref";
import { DurableModelToolTeamPort, type ModelToolLifecycle } from "../src/model-tool-contract/durable-model-tool-port";
import { exactLeaderSessionId, registerModelToolJourney } from "../src/model-tool-contract/runtime";
import { TASK_CARD_CONTEXT_MAX_LENGTH, isTaskCardContext } from "../src/model-tool-contract/task-domain";
import { assembleToolResult } from "../src/model-tool-contract/result-projection";
import {
  diagnoseTeam,
  formatTeamStatus,
  getPiTeamsArgumentCompletions,
  knownTeamNames,
  parsePiTeamsCommand,
  PI_TEAMS_COMMAND_USAGE,
  type TeamSessionBindingStatus,
} from "../src/utils/team-status";

// Public-interface intent and source allocation: docs/current/README.md and
// docs/reference.md. Tool schemas and execution below are the contract source.

/**
 * Build the command used to relaunch pi for teammate processes.
 *
 * There are three common cases:
 * - npm/node install: pi runs as `node .../dist/cli.js`
 * - standalone compiled binary: process.execPath is the actual `pi` executable
 * - shim-based installs (e.g. Volta): process.execPath is `node` and argv[1]
 *   may be a shim path, so the safest relaunch command is plain `pi`
 */
function getPiLaunchArgv(): string[] {
  const argv1 = process.argv[1];
  const execPath = process.execPath;

  // Regular Node install: relaunch the actual CLI script with node.
  if (argv1) {
    const ext = path.extname(argv1).toLowerCase();
    const looksLikeScript = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(ext)
      || /(?:^|[/\\])dist[/\\]cli\.js$/i.test(argv1);

    if (looksLikeScript) {
      return ["node", argv1];
    }
  }

  // Standalone binary install: execPath is the pi executable itself.
  if (execPath) {
    const base = path.basename(execPath).toLowerCase();
    if (base !== "node" && base !== "node.exe" && base !== "bun" && base !== "bun.exe") {
      return [execPath];
    }
  }

  // Shim-based installs (like Volta) are safest to relaunch through PATH.
  return ["pi"];
}

export function buildPiArgv(base: string[], model?: string, thinking?: string, aggregatePrompt?: string, projectTrusted?: boolean): string[] {
  const argv = [...base];
  if (model) argv.push("--model", thinking ? `${model}:${thinking}` : model);
  else if (thinking) argv.push("--thinking", thinking);
  // Worker model-facing tools are projected in the Worker process. Do not pass
  // a CLI allowlist, because it cannot re-enable registered tools at runtime.
  if (aggregatePrompt) argv.push("--no-context-files", "--append-system-prompt", aggregatePrompt);
  if (projectTrusted !== undefined) argv.push(projectTrusted ? "--approve" : "--no-approve");
  return argv;
}

// Cache for available models
let availableModelsCache: Array<{ provider: string; model: string }> | null = null;
let modelsCacheTime = 0;
const MODELS_CACHE_TTL = 60000; // 1 minute

/**
 * Query available models from pi --list-models
 */
function getAvailableModels(): Array<{ provider: string; model: string }> {
  const now = Date.now();
  if (availableModelsCache && now - modelsCacheTime < MODELS_CACHE_TTL) {
    return availableModelsCache;
  }

  try {
    const result = spawnSync("pi", ["--list-models"], {
      encoding: "utf-8",
      timeout: 10000,
    });

    if (result.status !== 0 || !result.stdout) {
      return [];
    }

    const models: Array<{ provider: string; model: string }> = [];
    const lines = result.stdout.split("\n");

    for (const line of lines) {
      // Skip header line and empty lines
      if (!line.trim() || line.startsWith("provider")) continue;

      // Parse: provider model context max-out thinking images
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const provider = parts[0];
        const model = parts[1];
        if (provider && model) {
          models.push({ provider, model });
        }
      }
    }

    availableModelsCache = models;
    modelsCacheTime = now;
    return models;
  } catch (e) {
    return [];
  }
}

/**
 * Provider priority list - OAuth/subscription providers first (cheaper), then API-key providers
 */
const PROVIDER_PRIORITY = [
  // OAuth / Subscription providers (typically free/cheaper)
  "google-gemini-cli",  // Google Gemini CLI - OAuth, free tier
  "github-copilot",     // GitHub Copilot - subscription
  "kimi-sub",           // Kimi subscription
  // API key providers
  "anthropic",
  "openai",
  "google",
  "zai",
  "openrouter",
  "azure-openai",
  "amazon-bedrock",
  "mistral",
  "groq",
  "cerebras",
  "xai",
  "vercel-ai-gateway",
];

/**
 * Find the best matching provider for a given model name.
 * Returns the full provider/model string or null if not found.
 */
function resolveModelWithProvider(modelName: string): string | null {
  // If already has provider prefix, return as-is
  if (modelName.includes("/")) {
    return modelName;
  }

  const availableModels = getAvailableModels();
  if (availableModels.length === 0) {
    return null;
  }

  const lowerModelName = modelName.toLowerCase();

  // Find all exact matches (case-insensitive) and sort by provider priority
  const exactMatches = availableModels.filter(
    (m) => m.model.toLowerCase() === lowerModelName
  );

  if (exactMatches.length > 0) {
    // Sort by provider priority (lower index = higher priority)
    exactMatches.sort((a, b) => {
      const aIndex = PROVIDER_PRIORITY.indexOf(a.provider);
      const bIndex = PROVIDER_PRIORITY.indexOf(b.provider);
      // If provider not in priority list, put it at the end
      const aPriority = aIndex === -1 ? 999 : aIndex;
      const bPriority = bIndex === -1 ? 999 : bIndex;
      return aPriority - bPriority;
    });
    return `${exactMatches[0].provider}/${exactMatches[0].model}`;
  }

  // Try partial match (model name contains the search term)
  const partialMatches = availableModels.filter((m) =>
    m.model.toLowerCase().includes(lowerModelName)
  );

  if (partialMatches.length > 0) {
    for (const preferredProvider of PROVIDER_PRIORITY) {
      const match = partialMatches.find(
        (m) => m.provider === preferredProvider
      );
      if (match) {
        return `${match.provider}/${match.model}`;
      }
    }
    // Return first match if no preferred provider found
    return `${partialMatches[0].provider}/${partialMatches[0].model}`;
  }

  return null;
}

/** Admit and publish the lead process under its exact Membership lease. */
async function registerLeadSession(
  teamName: string,
  piSessionFile: string,
  update?: Pick<Partial<Member>, "terminalTarget" | "tmuxPaneId">,
  allowFirstRuntimeGeneration = false,
  expectedMembershipId?: string,
): Promise<runtime.RuntimeStartupAdmission> {
  const initial = expectedMembershipId
    ? undefined
    : await teams.currentMembership(teamName, "team-lead");
  return teams.withCurrentMembershipLease(teamName, expectedMembershipId ?? initial!.membershipId!, async (lead) => {
    const status = await runtime.readRuntimeStatus(teamName, "team-lead");
    const admission = allowFirstRuntimeGeneration && status === null
      ? { kind: "admitted" as const, action: "claim" as const }
      : runtime.admitRuntimeStartup(lead, piSessionFile, status);
    if (admission.kind === "refused" || admission.action === "already_current") return admission;
    const membershipId = lead.membershipId;
    if (!membershipId) throw new Error(`Current lead Membership for ${teamName} has no stable identity.`);
    const startedAt = Date.now();
    // Claim the candidate generation before every durable terminal/binding write.
    // If a later write fails, this fence remains until the candidate exits.
    await runtime.writeRuntimeStatus(teamName, "team-lead", { pid: process.pid, startedAt }, membershipId);
    if (update) await teams.updateMembership(teamName, membershipId, update);
    const recordPath = paths.leadSessionPath(teamName);
    const dir = path.dirname(recordPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(recordPath, JSON.stringify({ pid: process.pid, sessionFile: piSessionFile, startedAt }));
    return admission;
  });
}

export interface AgentSessionCleanupInspection {
  candidates: string[];
  cleaned: 0;
  reason: string;
}

/**
 * Age can identify review candidates, but cannot prove a Pi-core session is
 * orphaned. Report candidates without deleting until liveness evidence exists.
 */
export function inspectAgentSessionCleanup(
  maxAgeMs: number = 24 * 60 * 60 * 1000,
  agentTeamsDir: string = path.join(os.homedir(), ".pi", "agent", "teams"),
): AgentSessionCleanupInspection {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new Error("max_age_hours must be a finite non-negative number.");
  }
  const report: AgentSessionCleanupInspection = {
    candidates: [],
    cleaned: 0,
    reason: "Age alone cannot prove a Pi-core agent session is orphaned; no folders were deleted.",
  };
  if (!fs.existsSync(agentTeamsDir)) return report;
  const now = Date.now();

  for (const dir of fs.readdirSync(agentTeamsDir)) {
    const sessionDir = path.join(agentTeamsDir, dir);
    const configFile = path.join(sessionDir, "config.json");

    try {
      // Check if this is a directory with a config.json
      if (!fs.statSync(sessionDir).isDirectory()) continue;
      if (!fs.existsSync(configFile)) continue;

      // Read the config to check the creation time
      const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      const createdAt = config.createdAt ? new Date(config.createdAt).getTime() : 0;

      // Old age is only a review signal, never deletion authority.
      if (createdAt > 0 && (now - createdAt) > maxAgeMs) {
        report.candidates.push(dir);
      }
    } catch {
      // Ignore errors for individual folders
    }
  }

  return report;
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer?.(SYNC_NUDGE_CUSTOM_TYPE, (message: any) => {
    const record = validateSyncNudgeRecord(message.details);
    return record ? new Text(syncNudgeTuiLine(record), 0, 0) : undefined;
  });
  registerAutomaticSummaryPolicyProvider(pi);
  // Leader and Worker tools are separate role projections. The leader owns
  // the current model-tool journey; Workers own the three Task/Alert tools.
  const leaderToolNames = new Set([
    "team_create", "ensure_worker", "task_create", "task_read", "task_update", "team_sync",
    "worker_stop", "team_shutdown", "task_link", "alert_send",
  ]);
  const workerToolNames = new Set(["task_read", "task_update", "alert_send"]);
  // `team-lead` is a reserved leader identity, even when explicitly supplied
  // through the Worker launch environment.
  let isTeammate = !!process.env.PI_AGENT_NAME && process.env.PI_AGENT_NAME !== "team-lead";
  const workerToolDefinitions = new Map<string, ToolDefinition<any, any>>();
  const registerPublicTool = pi.registerTool.bind(pi);

  function registerProjectedWorkerTool(tool: ToolDefinition<any, any>): void {
    registerPublicTool({
      ...tool,
      execute: async (...callArgs: any[]) => (tool.execute as any)(...callArgs),
      renderResult: createToolResultRenderer(tool.name as any),
    } as any);
  }

  function registerWorkerTool<TParams extends TSchema, TDetails>(tool: ToolDefinition<TParams, TDetails>): void {
    workerToolDefinitions.set(tool.name, tool);
    if (isTeammate && workerToolNames.has(tool.name)) registerProjectedWorkerTool(tool);
  }

  function registerRecoveredWorkerTools(): void {
    for (const name of workerToolNames) {
      const tool = workerToolDefinitions.get(name);
      if (tool) registerProjectedWorkerTool(tool);
    }
  }

  let agentName = process.env.PI_AGENT_NAME || "team-lead";
  const envTeamName = process.env.PI_TEAM_NAME;
  const envLaunchId = process.env.PI_AGENT_LAUNCH_ID;

  // For leads without PI_TEAM_NAME, check if we're registered as lead for a team
  const detectedTeamName = envTeamName || teams.findLeadTeamForSession();
  let teamName = detectedTeamName;
  let currentMembershipId: string | undefined;

  const terminal = getTerminalAdapter();

  let directMessageDelivery: DirectMessageDelivery | null = null;
  let taskChangeDelivery: TaskChangeDelivery | null = null;
  let syncNudgeConductor: SyncNudgeConductor | null = null;
  let stopSyncNudgeMonitor: (() => void) | null = null;
  let leaderRunSettled = false;
  let leaderContext: any;
  let directMessageSessionEligible = true;
  let taskChangeSessionEligible = true;
  let footerModel: any;
  let workerResourcePolicy: WorkerResourcePolicy | undefined;
  let workerActiveToolBaseline: string[] | undefined;
  let alertToolRegistration: { description: string; parameters: unknown } | undefined;

  function projectTrust(ctx: any): boolean | undefined {
    try {
      const trust = ctx?.isProjectTrusted?.();
      return typeof trust === "boolean" ? trust : undefined;
    } catch {
      return undefined;
    }
  }

  function workerAggregate(cwd: string, ctx: any): WorkerAggregate {
    const resources = resolveWorkerLaunchResources({
      cwd,
      leaderCwd: ctx.cwd ?? process.cwd(),
      leaderProjectTrusted: projectTrust(ctx),
    });
    for (const message of resources.policy.diagnostics) ctx.ui?.notify?.(`Pi Team Bright Worker settings: ${message}`, "warning");
    return { path: resources.aggregatePath, projectTrusted: resources.projectTrusted, defaultModel: resources.policy.defaultModel };
  }

  const taskAdapterFactory = createPublishingBeadsTaskAdapterFactory(new DurableTaskMutationPublication());

  const workerLaunchBridge = createWorkerLaunchBridge({
    buildWorkerArgv: (model, thinking, aggregatePath, projectTrusted) => {
      const argv = buildPiArgv(getPiLaunchArgv(), model, thinking);
      // A Worker loads the exact Pi Team Bright source while retaining normal
      // unrelated extension and Skill discovery.
      argv.push("-e", process.env.PI_TEAM_BRIGHT_SHIPPED_EXTENSION || __filename);
      return buildPiArgv(argv, undefined, undefined, aggregatePath, projectTrusted);
    },
    resolveModel: resolveModelWithProvider,
    resolveSettingsModel: resolveQualifiedWorkerDefaultModel,
    // No leader context exists on this fallback path; the resolver applies the
    // authorized always-trust default instead of manufacturing false.
    workerAggregate: (cwd) => workerAggregate(cwd, { cwd }),
  });

  let modelToolLifecycleAdapter: ModelToolLifecycle | undefined;
  let modelToolJourney: ReturnType<typeof registerModelToolJourney> | undefined;
  if (!isTeammate) {
    const lifecycle: ModelToolLifecycle = {
      teamCreated: async (name, sessionFile) => modelToolLifecycleAdapter?.teamCreated?.(name, sessionFile),
      stopWorker: async (name, worker) => modelToolLifecycleAdapter
        ? modelToolLifecycleAdapter.stopWorker(name, worker)
        : { kind: "unavailable", reason: "carrier_unavailable", message: "Model-tool lifecycle adapter is not ready." },
      shutdownTeam: async (name) => modelToolLifecycleAdapter
        ? modelToolLifecycleAdapter.shutdownTeam(name)
        : { kind: "unavailable", reason: "team_authority_unavailable", message: "Model-tool lifecycle adapter is not ready." },
    };
    modelToolJourney = registerModelToolJourney(pi, new DurableModelToolTeamPort(workerLaunchBridge, lifecycle, taskAdapterFactory));
  }

  function modelToolBranchIds(ctx: ExtensionContext): string[] {
    return ctx.sessionManager.getBranch().map((entry) => entry.id);
  }

  function modelToolContainsExact(value: unknown, target: string): boolean {
    if (value === target) return true;
    if (Array.isArray(value)) return value.some((item) => modelToolContainsExact(item, target));
    if (value && typeof value === "object") return Object.values(value).some((item) => modelToolContainsExact(item, target));
    return false;
  }

  function modelToolPersistedToolResult(ctx: ExtensionContext, toolCallId: string, resultText: string): string | undefined {
    const entry = ctx.sessionManager.getBranch().find((candidate) => {
      if (candidate.type !== "message") return false;
      const message = candidate.message;
      return message.role === "toolResult"
        && message.toolCallId === toolCallId
        && message.content.some((part) => part.type === "text" && part.text === resultText);
    });
    return entry?.id;
  }

  if (modelToolJourney) {
    pi.on("tool_call", (event, ctx) => {
      if (isTeammate || !leaderToolNames.has(event.toolName)) return;
      modelToolJourney.port.setBranchContext(
        exactLeaderSessionId(ctx.sessionManager.getSessionId()),
        modelToolBranchIds(ctx),
      );
    });
    pi.on("before_provider_request", async (event, ctx) => {
      if (isTeammate) return;
      const sessionId = exactLeaderSessionId(ctx.sessionManager.getSessionId());
      const lineage = modelToolBranchIds(ctx);
      modelToolJourney.port.setBranchContext(sessionId, lineage);
      const pending = modelToolJourney.port.getPendingObservation?.(sessionId);
      if (!pending || !modelToolContainsExact(event.payload, pending.resultText)) return;
      const entryId = modelToolPersistedToolResult(ctx, pending.toolCallId, pending.resultText);
      if (!entryId) return;
      if (modelToolJourney.port.acknowledgePendingObservationAsync) {
        await modelToolJourney.port.acknowledgePendingObservationAsync(sessionId, entryId, lineage);
      } else {
        modelToolJourney.port.acknowledgePendingObservation(sessionId, entryId, lineage);
      }
    });
  }

  function configureWorkerResources(ctx: any): void {
    if (!isTeammate) return;
    const cwd = ctx.cwd ?? process.cwd();
    workerResourcePolicy = loadWorkerResourcePolicy({ cwd, projectTrusted: projectTrust(ctx) ?? true });
    // Capture this once, before this extension projects settings. Reload always
    // derives from it so removing settings restores Pi's active-tool baseline.
    workerActiveToolBaseline ??= pi.getActiveTools?.() ?? [];
    const registered = pi.getAllTools?.().map((tool: { name: string }) => tool.name) ?? workerActiveToolBaseline;
    // Settings may enable any discovered foreign tool, but never restore a Pi
    // Team Bright leader-only tool removed from the Worker projection.
    const workerEligibleRegistered = registered.filter((name) => !leaderToolNames.has(name) || workerToolNames.has(name));
    const workerSurface = [
      ...workerActiveToolBaseline.filter((name) => !leaderToolNames.has(name) || workerToolNames.has(name)),
      ...[...workerToolNames].filter((name) => workerEligibleRegistered.includes(name)),
    ];
    const projected = projectWorkerTools([...new Set(workerSurface)], workerEligibleRegistered, workerResourcePolicy);
    pi.setActiveTools?.(projected);
    for (const message of workerResourcePolicy.diagnostics) ctx.ui?.notify?.(`Pi Team Bright Worker settings: ${message}`, "warning");
  }

  function alertToolProjection() {
    const workerFields = {
      kind: StringEnum(["clarification", "attention"]),
      text: Type.String(),
      task_id: Type.Optional(Type.String()),
      task_version: Type.Optional(TaskVersionRefSchema),
    };
    const leaderFields = {
      team_name: Type.String(),
      kind: StringEnum(["clarification", "attention", "announcement"]),
      text: Type.String(),
      task_id: Type.Optional(Type.String()),
      task_version: Type.Optional(TaskVersionRefSchema),
    };
    return {
      description: isTeammate
        ? "Send exceptional clarification or attention to team-lead. Alerts never assign or complete work; update the Task when durable intent changes."
        : "Send exceptional clarification, attention, or a Team announcement. Alerts never assign or complete work; update the Task when durable intent changes.",
      parameters: isTeammate
        ? Type.Object(workerFields)
        : Type.Object({
            ...leaderFields,
            to: Type.String({ description: "Current Worker name, team-lead, or * for an announcement" }),
          }),
    };
  }

  function refreshAlertToolProjection(): void {
    if (!alertToolRegistration) return;
    // Pi 0.82 replaces the same-name registration. This also covers a Worker
    // resumed without launch environment identity.
    Object.assign(alertToolRegistration, alertToolProjection());
    registerWorkerTool(alertToolRegistration as any);
  }

  const registerCommand = (pi as any).registerCommand?.bind(pi);
  registerCommand?.("pi-team-bright", {
    description: "Pi Team Bright status/help — read-only Team and Beads authority diagnosis",
    getArgumentCompletions: getPiTeamsArgumentCompletions,
    handler: async (args: string, ctx: any) => {
      const command = parsePiTeamsCommand(args);
      const present = (text: string, level: "info" | "warning" | "error" = "info") => {
        if (ctx.hasUI !== false && ctx.ui?.notify) ctx.ui.notify(text, level);
        else process.stderr.write(`${text}\n`);
      };
      if (!command.ok) { present(command.usage, "warning"); return; }
      if (command.subcommand === "help") {
        present(`${PI_TEAMS_COMMAND_USAGE}\nstatus is the default and reads TeamConfig plus exact Beads-root diagnostics.`); return;
      }
      if (!teamName) {
        const known = knownTeamNames();
        present(`No current Team is bound to this Pi Session.${known.length ? ` Known Teams: ${known.slice(0, 8).join(", ")}.` : " Create a Team first with team_create."}`, "warning"); return;
      }
      const sessionFile = ctx.sessionManager?.getSessionFile?.();
      let sessionBinding: TeamSessionBindingStatus = sessionFile ? "stale" : "unavailable";
      let sessionDetail = sessionFile ? undefined : "durable Pi Session file unavailable";
      if (sessionFile) try {
        const member = await teams.assertCurrentSessionBinding(teamName, agentName, sessionFile);
        if (currentMembershipId && member.membershipId !== currentMembershipId) sessionDetail = "current Team membership differs from this runtime generation";
        else sessionBinding = "current";
      } catch (error) { sessionDetail = error instanceof Error ? error.message : String(error); }
      try {
        const report = await diagnoseTeam(teamName, { role: agentName, sessionBinding, sessionDetail });
        present(formatTeamStatus(report), report.taskAuthority.health === "verified" && sessionBinding === "current" ? "info" : "warning");
      } catch (error) { present(`Pi Team Bright status failed for ${teamName}. ${error instanceof Error ? error.message : String(error)}`, "error"); }
    },
  });

  async function refreshTeamFooter(ctx: any) {
    if (!ctx?.ui) return undefined;
    footerModel = ctx?.model ?? footerModel;
    return syncTeamFooter(pi, ctx, {
      teamName,
      role: agentName,
      membershipId: currentMembershipId,
    }, () => footerModel);
  }

  function taskMutationContent(
    task: Pick<{ id: string; status: string; assignee?: string; version: string }, "id" | "status" | "assignee" | "version">,
    appliedOperations: string[],
    warnings: string[] = [],
  ): string {
    const owner = task.assignee ? `assigned to ${task.assignee}` : "unassigned";
    const unchanged = appliedOperations.length === 0 ? " No Task state changed." : "";
    const blocked = task.status === "blocked"
      ? ` Blocker evidence is recorded${task.assignee ? "; the assignee remains responsible for the next update." : "; coordinator action is required before reassignment."}`
      : "";
    const warningText = warnings.length > 0 ? ` Delivery warnings: ${warnings.join("; ")}` : " Delivery warnings: none.";
    return `Task ${task.id} is ${task.status}, ${owner}, version ${task.version}.${unchanged}${blocked}${warningText}`;
  }

  function mutationReceipt(
    operation: string,
    resource: { kind: string; id: string; [key: string]: unknown },
    postState: Record<string, unknown>,
    warnings: string[] = [],
    nextAction?: string,
  ) {
    return {
      accepted: true as const,
      operation,
      resource,
      postState,
      warnings,
      ...(nextAction ? { nextAction } : {}),
    };
  }

  function stopSyncNudgeConductor() {
    syncNudgeConductor?.stop();
    syncNudgeConductor = null;
    stopSyncNudgeMonitor?.();
    stopSyncNudgeMonitor = null;
  }

  function syncNudgeMessageDelivered(ctx: any, record: { id: string; branchLineage: readonly string[] }): boolean {
    const branch = ctx?.sessionManager?.getBranch?.() ?? [];
    const ids = branch.map((entry: any) => entry.id);
    if (record.branchLineage.some((id, index) => ids[index] !== id)) return false;
    return branch.some((entry: any) => {
      if (entry.type !== "custom_message" || entry.customType !== SYNC_NUDGE_CUSTOM_TYPE) return false;
      const details = validateSyncNudgeRecord(entry.details);
      return details?.kind === "presented" && details.id === record.id
        && details.branchLineage.length === record.branchLineage.length
        && details.branchLineage.every((value, index) => value === record.branchLineage[index]);
    });
  }

  function startSyncNudgeConductor(ctx: any) {
    stopSyncNudgeConductor();
    if (isTeammate || !teamName || agentName !== "team-lead" || !modelToolJourney?.port.readSyncNudgeDebt) return;
    let config: TeamConfig;
    try { config = JSON.parse(fs.readFileSync(paths.configPath(teamName), "utf8")) as TeamConfig; } catch { return; }
    const policy = config.syncLiveness;
    if (!policy?.nudgeEnabled || policy.nudgeDelaySeconds === undefined) return;
    const delayMs = Math.max(0, policy.nudgeDelaySeconds * 1000);
    // Model-tool registration normally binds lazily on the first tool call.
    // Resume nudge reconciliation has no such call, so bind the exact current
    // Pi Session before it can ask the port for debt.
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    const sessionFile = ctx?.sessionManager?.getSessionFile?.();
    if (!sessionId || !sessionFile) return;
    modelToolJourney.port.setLeaderSessionFile?.(exactLeaderSessionId(sessionId), sessionFile);
    const debt = async (): Promise<SyncNudgeDebt> => {
      const sessionId = ctx?.sessionManager?.getSessionId?.();
      const branch = modelToolBranchIds(ctx);
      if (!sessionId || branch.length === 0) return { kind: "none" };
      return modelToolJourney!.port.readSyncNudgeDebt!(exactLeaderSessionId(sessionId), branch);
    };
    const busy = (): boolean => {
      const sessionId = ctx?.sessionManager?.getSessionId?.();
      return !leaderRunSettled || ctx?.isIdle?.() === false || !!ctx?.hasPendingMessages?.()
        || (!!sessionId && !!modelToolJourney?.port.getPendingObservation?.(exactLeaderSessionId(sessionId)));
    };
    syncNudgeConductor = new SyncNudgeConductor({
      clock: { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
      delayMs,
      readDebt: debt,
      isSettled: () => leaderRunSettled,
      isBusy: busy,
      alreadyPresented: (debtKey, branchLineage) => readSyncNudges(teamName!).some((record) => record.debtKey === debtKey && record.branchLineage.length === branchLineage.length && record.branchLineage.every((value, index) => value === branchLineage[index])),
      present: async (candidate) => {
        const sessionFile = ctx?.sessionManager?.getSessionFile?.();
        const sessionId = ctx?.sessionManager?.getSessionId?.();
        const branch = modelToolBranchIds(ctx);
        if (!sessionFile || !sessionId || branch.length === 0 || busy()) return;
        const current = await teams.readConfig(teamName!);
        if (current.epochId !== candidate.teamEpochId || current.leadSessionId !== sessionFile) return;
        const currentLead = await teams.assertCurrentSessionBinding(teamName!, "team-lead", sessionFile);
        if (currentLead.membershipId !== candidate.leaderMembershipId) return;
        const latest = await modelToolJourney!.port.readSyncNudgeDebt!(exactLeaderSessionId(sessionId), branch);
        if (latest.kind !== "eligible" || latest.debtKey !== candidate.debtKey || latest.branchId !== candidate.branchId || latest.leaderMembershipId !== candidate.leaderMembershipId || latest.branchLineage.length !== candidate.branchLineage.length || latest.branchLineage.some((value, index) => value !== candidate.branchLineage[index]) || busy()) return;
        const existing = findSyncNudgeReservation(teamName!, candidate.debtKey, candidate.branchLineage);
        if (existing && syncNudgeMessageDelivered(ctx, existing)) {
          presentSyncNudge(existing);
          return;
        }
        const record = existing ?? createSyncNudgeRecord({
          kind: "reserved",
          id: randomUUID(), teamName: teamName!, teamEpochId: candidate.teamEpochId,
          leaderSessionId: candidate.leaderSessionId, leaderMembershipId: candidate.leaderMembershipId,
          branchLineage: [...candidate.branchLineage], branchId: candidate.branchId, debtKey: candidate.debtKey,
          requestedView: candidate.requestedView, reservedAt: new Date().toISOString(), policyVersion: candidate.policyVersion,
        });
        if (!existing) reserveSyncNudge(record);
        const presented = createSyncNudgeRecord({ ...record, kind: "presented", presentedAt: new Date().toISOString() });
        // Reservation is internal. The model receives only the validated
        // presented semantic record; persistence follows exact Session proof.
        pi.sendMessage({ customType: SYNC_NUDGE_CUSTOM_TYPE, content: syncNudgeContent(presented), display: true, details: presented }, { triggerTurn: true, deliverAs: "followUp" });
        // Promote only after the durable Session contains this exact custom
        // message on the same full branch lineage.
        if (syncNudgeMessageDelivered(ctx, presented)) presentSyncNudge(record, presented.presentedAt);
      },
    });
    const eventDirectory = path.join(paths.teamDir(teamName), "events");
    fs.mkdirSync(eventDirectory, { recursive: true });
    const watcher = fs.watch(eventDirectory, () => syncNudgeConductor?.notify());
    watcher.on("error", () => syncNudgeConductor?.notify());
    const interval = setInterval(() => syncNudgeConductor?.notify(), Math.max(5_000, Math.min(30_000, Math.max(100, delayMs))));
    interval.unref?.();
    syncNudgeConductor.start();
    stopSyncNudgeMonitor = () => { watcher.close(); clearInterval(interval); };
  }

  function stopDeliveries() {
    stopSyncNudgeConductor();
    directMessageDelivery?.stop();
    directMessageDelivery = null;
    taskChangeDelivery?.stop();
    taskChangeDelivery = null;
  }

  async function assertCurrentSessionBinding(ctx: any, requestedTeam: string): Promise<Member> {
    const sessionFile = ctx?.sessionManager?.getSessionFile?.();
    if (!sessionFile) throw new Error("A durable Pi Session is required for every team-scoped tool operation.");
    return teams.assertCurrentSessionBinding(requestedTeam, agentName, sessionFile);
  }

  /** Resolve the one exact current Team and Worker identity for Worker tools. */
  async function resolveCurrentWorkerContext(ctx: any): Promise<{ teamName: string; member: Member }> {
    const sessionFile = ctx?.sessionManager?.getSessionFile?.();
    if (!sessionFile) throw new Error("A durable Pi Session is required for every Worker tool operation.");
    const binding = await teams.resolveCurrentTeammateSessionBinding(sessionFile);
    if (binding.status !== "bound") {
      throw new Error(`Current Worker Session binding is unavailable: ${binding.reason}.`);
    }
    return binding;
  }

  /** Mutating Team topology/lifecycle/templates is a coordinator capability. */
  async function assertLeadMutation(ctx: any, operation: string, requestedTeam?: string): Promise<Member | undefined> {
    if (agentName !== "team-lead") {
      throw new Error(`${operation} is lead-only; ask team-lead to perform this Team mutation.`);
    }
    if (!requestedTeam) return undefined;
    const member = await assertCurrentSessionBinding(ctx, requestedTeam);
    if (member.name !== "team-lead" || member.agentType !== "lead") {
      throw new Error(`${operation} is lead-only; current Membership ${member.name} is not the Team lead.`);
    }
    return member;
  }

  async function writeCurrentTeammateRuntime(ctx: any, updates: Partial<runtime.AgentRuntimeStatus>) {
    if (!isTeammate || !teamName) return;
    const sessionFile = ctx?.sessionManager?.getSessionFile?.();
    if (!sessionFile) throw new Error("A durable Pi Session is required for teammate runtime updates.");
    const member = await teams.assertCurrentSessionBinding(teamName, agentName, sessionFile);
    if (!member.membershipId || (currentMembershipId && currentMembershipId !== member.membershipId)) {
      throw new Error(`Runtime update rejected for stale Membership of ${agentName} on team ${teamName}.`);
    }
    currentMembershipId = member.membershipId;
    await runtime.writeRuntimeStatus(teamName, agentName, updates, member.membershipId);
  }

  async function startDirectMessageDelivery(ctx: any) {
    if (!teamName || !directMessageSessionEligible) return;
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    if (!sessionFile) return;
    const member = await teams.assertCurrentSessionBinding(teamName, agentName, sessionFile);
    if (!member.membershipId) throw new Error(`Current Membership for ${agentName} has no membershipId.`);
    currentMembershipId = member.membershipId;
    directMessageDelivery?.stop();
    directMessageDelivery = new DirectMessageDelivery(pi, {
      teamName,
      recipient: agentName,
      membershipId: member.membershipId,
      sessionFile,
      pollMs: messagePollMs(),
    });
    await directMessageDelivery.start(ctx.sessionManager?.buildContextEntries?.() ?? ctx.sessionManager?.getEntries?.() ?? []);
  }

  async function startTaskChangeDelivery(ctx: any) {
    if (!teamName || !taskChangeSessionEligible) return;
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    if (!sessionFile) return;
    const member = await teams.assertCurrentSessionBinding(teamName, agentName, sessionFile);
    if (!member.membershipId) throw new Error(`Current Membership for ${agentName} has no membershipId.`);
    taskChangeDelivery?.stop();
    taskChangeDelivery = new TaskChangeDelivery(pi, {
      teamName,
      recipient: agentName,
      membershipId: member.membershipId,
      sessionFile,
      pollMs: taskPollMs(),
      reconciliationQuery: new BeadsTaskReconciliationQuery(teamName),
    });
    await taskChangeDelivery.start(ctx.sessionManager?.buildContextEntries?.() ?? ctx.sessionManager?.getEntries?.() ?? []);
  }

  /**
   * A launcher that sets the teammate environment owns the contract it broke;
   * a Session recognized from its own file belongs to the operator's terminal.
   */
  const identitySource: TeamIdentitySource = process.env.PI_AGENT_NAME ? "launch_env" : "resumed_session";

  /**
   * Apply a refused admission. The process must end up unmistakably outside the
   * Team rather than live-but-unbound: it records durable evidence, drops every
   * Team identity so no tool can act as a Member, reports the remedy, and closes
   * a launcher-spawned process instead of leaving it idling in its pane.
   */
  async function refuseTeamSession(
    ctx: any,
    refusedTeam: string,
    role: string,
    admission: Extract<TeamSessionAdmission, { kind: "refused" }>,
    shutdownCandidate = false,
  ) {
    if (!shutdownCandidate) {
      await teams.currentMembership(refusedTeam, role)
        .then((candidate) => candidate.membershipId ? teamEvents.appendTeamEvent(refusedTeam, {
          type: "worker", worker: role, membershipId: candidate.membershipId, phase: "failed",
        }) : undefined)
        .catch(() => undefined);
    }
    stopDeliveries();
    isTeammate = false;
    teamName = null;
    currentMembershipId = undefined;
    ctx?.ui?.notify?.(admission.reason, "error");
    ctx?.ui?.setStatus?.("pi-teams", shutdownCandidate ? "startup admission refused" : "terminal backend mismatch");
    clearTeamFooter(ctx);
    if (admission.exitProcess || shutdownCandidate) ctx?.shutdown?.();
  }

  pi.on("session_start", async (event, ctx) => {
    paths.ensureDirs();
    stopDeliveries();
    leaderRunSettled = false;
    leaderContext = ctx;
    footerModel = ctx.model;
    clearTeamFooter(ctx);
    directMessageSessionEligible = event.reason !== "fork";
    taskChangeSessionEligible = event.reason !== "fork";

    if (event.reason === "fork") {
      // A fork is a new Session identity, not a continuation of the source
      // member. Keep it unbound until an explicit team_create/rebind action.
      isTeammate = false;
      agentName = "unbound-session";
      teamName = null;
      currentMembershipId = undefined;
      return;
    }

    // A fresh `pi -r` process has no teammate environment variables. A
    // teammate's first startup persists its Pi session file, which is enough
    // to restore its identity before the normal teammate lifecycle runs.
    const piSessionFile = ctx.sessionManager?.getSessionFile?.();
    if (!isTeammate && !teamName && piSessionFile) {
      const resumedMember = teams.findTeammateBySessionFile(piSessionFile);
      if (resumedMember) {
        isTeammate = true;
        agentName = resumedMember.member.name;
        teamName = resumedMember.teamName;
        currentMembershipId = resumedMember.member.membershipId;
        refreshAlertToolProjection();
        registerRecoveredWorkerTools();
      }
    }
    // A fresh lead process has no lead environment variables either. Match
    // its resumed Pi session to the durable lead record.
    if (!isTeammate && !teamName) {
      teamName = teams.findLeadTeamForSession(piSessionFile);
    }

    if (envTeamName && !teams.teamExists(envTeamName)) {
      throw new Error(
        `Explicit PI_TEAM_NAME '${envTeamName}' does not name a current team. ` +
        "Refusing implicit fallback or team-state creation; choose an existing team or create it explicitly.",
      );
    }

    if (isTeammate) {
      configureWorkerResources(ctx);
      if (teamName) {
        if (!piSessionFile) throw new Error("Teammate startup requires a durable Pi Session file.");
        const teamConfig = await teams.readConfig(teamName);
        const admission = admitTeamSession(
          teamConfig,
          agentName,
          placeSessionTerminal(teamConfig, terminal, process.env.TMUX_PANE),
          identitySource,
        );
        if (admission.kind === "refused") {
          await refuseTeamSession(ctx, teamName, agentName, admission);
          return;
        }
        const candidate = await teams.currentMembership(teamName, agentName);
        let startup: runtime.RuntimeStartupAdmission & { member?: Member };
        try {
          startup = await teams.withCurrentMembershipLease(teamName, candidate.membershipId!, async (current) => {
          const runtimeAdmission = runtime.admitRuntimeStartup(
            current,
            piSessionFile,
            await runtime.readRuntimeStatus(teamName!, agentName), process.pid, runtime.probePidPresence, envLaunchId,
          );
          if (runtimeAdmission.kind === "refused") return runtimeAdmission;
          if (runtimeAdmission.action === "already_current") return { kind: "admitted" as const, action: "already_current" as const, member: current };
          const startedAt = Date.now();
          // Claim the candidate before bindMemberSession can write a terminal
          // target. A failed later write leaves this exact PID fenced.
          await runtime.writeRuntimeStatus(teamName!, agentName, {
            pid: process.pid, startedAt, lastHeartbeatAt: startedAt, ready: false, lastError: undefined,
          }, current.membershipId);
          const bound = await teams.bindMemberSession(
            teamName!, agentName, piSessionFile, envLaunchId, admission.update ?? {}, current.membershipId,
          );
          await teamEvents.appendTeamEvent(teamName!, {
            type: "worker", worker: agentName, membershipId: bound.membershipId!, phase: "session_bound",
            generation: { membershipId: bound.membershipId!, pid: process.pid, startedAt },
          });
          return { kind: "admitted" as const, action: "claim" as const, member: bound };
          });
        } catch (error) {
          await refuseTeamSession(ctx, teamName, agentName, {
            kind: "refused",
            reason: `Startup for ${agentName} failed after candidate admission: ${error instanceof Error ? error.message : String(error)}. The candidate process was stopped; its runtime fence remains until PID exit.`,
            exitProcess: true,
          }, true);
          return;
        }
        if (startup.kind === "refused") {
          await refuseTeamSession(ctx, teamName, agentName, { kind: "refused", reason: startup.reason, exitProcess: true }, true);
          return;
        }
        currentMembershipId = startup.member!.membershipId;
      }
      ctx.ui.notify(`Teammate: ${agentName} (Team: ${teamName})`, "info");
      if (terminal) {
        const fullTitle = teamName ? `${teamName}: ${agentName}` : agentName;
        const setIt = () => {
          if ((ctx.ui as any).setTitle) (ctx.ui as any).setTitle(fullTitle);
          terminal.setTitle(fullTitle);
        };
        setIt();
        setTimeout(setIt, 500);
        setTimeout(setIt, 2000);
        setTimeout(setIt, 5000);
      }

      if (teamName) {
        await startDirectMessageDelivery(ctx);
        await startTaskChangeDelivery(ctx);
      }
    } else if (teamName) {
      if (!piSessionFile) throw new Error("Lead resume requires a durable Pi Session file.");
      // Lead reconnecting to an existing team, including a new `pi -r`
      // process. Refresh both volatile process identity and terminal location.
      if (teams.teamExists(teamName)) {
        const teamConfig = await teams.readConfig(teamName);
        const admission = admitTeamSession(
          teamConfig,
          "team-lead",
          placeSessionTerminal(teamConfig, terminal, process.env.TMUX_PANE),
          identitySource,
        );
        if (admission.kind === "refused") {
          await refuseTeamSession(ctx, teamName, "team-lead", admission);
          return;
        }
        const lead = await teams.assertCurrentSessionBinding(teamName, "team-lead", piSessionFile);
        let runtimeAdmission: runtime.RuntimeStartupAdmission;
        try {
          runtimeAdmission = await registerLeadSession(teamName, piSessionFile, admission.update, false, lead.membershipId);
        } catch (error) {
          await refuseTeamSession(ctx, teamName, "team-lead", {
            kind: "refused",
            reason: `Lead startup failed after candidate admission: ${error instanceof Error ? error.message : String(error)}. The candidate process was stopped; its runtime fence remains until PID exit.`,
            exitProcess: true,
          }, true);
          return;
        }
        if (runtimeAdmission.kind === "refused") {
          await refuseTeamSession(ctx, teamName, "team-lead", { kind: "refused", reason: runtimeAdmission.reason, exitProcess: true }, true);
          return;
        }
        currentMembershipId = lead.membershipId;
      }
      await startDirectMessageDelivery(ctx);
      await startTaskChangeDelivery(ctx);
    }
    if (!isTeammate) {
      // A resumed/reloaded idle Session has no active agent run. This is
      // positive settled evidence, unlike a fresh startup before agent_start.
      leaderRunSettled = event.reason === "resume" || event.reason === "reload";
      startSyncNudgeConductor(ctx);
    }
    await refreshTeamFooter(ctx);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (isTeammate && event.reason === "reload") {
      // Pi captures active tools after this hook and replaces this extension
      // closure. Restore the immutable baseline before that capture.
      if (workerActiveToolBaseline) pi.setActiveTools?.(workerActiveToolBaseline);
      const aggregate = process.env.PI_TEAM_BRIGHT_WORKER_AGGREGATE;
      if (aggregate && ownsWorkerAggregate(aggregate)) {
        const cwd = ctx.cwd ?? process.cwd();
        const policy = loadWorkerResourcePolicy({ cwd, projectTrusted: projectTrust(ctx) ?? true });
        // Keep the fixed CLI path, but overwrite it atomically even if both
        // entries disappeared. Pi reload then sees native global/ancestor/project content.
        materializeWorkerAggregate({ cwd, policy, target: aggregate, force: true });
      } else if (aggregate) {
        ctx.ui?.notify?.("Pi Team Bright Worker aggregate path is not package-owned; reload refresh skipped.", "warning");
      }
    } else if (isTeammate && process.env.PI_TEAM_BRIGHT_WORKER_AGGREGATE) {
      // Best effort only: this disposable file is never orchestration authority.
      removeWorkerAggregate(process.env.PI_TEAM_BRIGHT_WORKER_AGGREGATE);
    }
    stopDeliveries();
    clearTeamFooter(ctx);
  });

  pi.on("model_select", async (event) => {
    footerModel = event.model;
  });

  pi.on("context", async (event) => {
    await directMessageDelivery?.observeContext(event.messages);
    await taskChangeDelivery?.observeContext(event.messages);
  });

  pi.on("agent_start", async (_event, ctx) => {
    leaderRunSettled = false;
    syncNudgeConductor?.notify();
    if (isTeammate && teamName) {
      await writeCurrentTeammateRuntime(ctx, { runState: "active", lastHeartbeatAt: Date.now() });
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (isTeammate && teamName) {
      await writeCurrentTeammateRuntime(ctx, { runState: "settled", lastHeartbeatAt: Date.now() });
    } else {
      leaderRunSettled = true;
      syncNudgeConductor?.notify();
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    const stopReason = event.message?.role === "assistant" ? event.message.stopReason : undefined;
    if (stopReason === "error" || stopReason === "aborted") {
      if (isTeammate && teamName && currentMembershipId) {
        await teamEvents.appendTeamEvent(teamName, {
          type: "worker", worker: agentName, membershipId: currentMembershipId, phase: "failed",
        }).catch(() => undefined);
      }
      return;
    }
    if (isTeammate && teamName) {
      await writeCurrentTeammateRuntime(ctx, {
        ready: true,
        lastHeartbeatAt: Date.now(),
        lastError: undefined,
      });
    }
    await Promise.all([
      directMessageDelivery?.commitPresentedAfterSuccessfulTurn(stopReason),
      taskChangeDelivery?.commitPresentedAfterSuccessfulTurn(stopReason),
    ]);
  });

  pi.on("turn_start", async (_event, ctx) => {
    await refreshTeamFooter(ctx);
    if (isTeammate) {
      const fullTitle = teamName ? `${teamName}: ${agentName}` : agentName;
      if ((ctx.ui as any).setTitle) (ctx.ui as any).setTitle(fullTitle);
      if (terminal) terminal.setTitle(fullTitle);
      if (teamName) {
        await writeCurrentTeammateRuntime(ctx, {
          lastHeartbeatAt: Date.now(),
        });
      }
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (isTeammate) {
      if (teamName) {
        await writeCurrentTeammateRuntime(ctx, {
          lastHeartbeatAt: Date.now(),
        });
      }

      let modelInfo = "";
      let profileInfo = "";
      if (teamName) {
        try {
          const teamConfig = await teams.readConfig(teamName);
          const member = teamConfig.members.find(m => m.name === agentName);
          if (member?.prompt) profileInfo = `\nYour standing Worker profile: ${member.prompt}`;
          if (member && member.model) {
            modelInfo = `\nYou are currently using model: ${member.model}`;
            if (member.thinking) {
              modelInfo += ` with thinking level: ${member.thinking}`;
            }
            modelInfo += `. When reporting your model or thinking level, use these exact values.`;
          }
        } catch (e) {
          // Ignore
        }
      }

      const taskInstruction = taskChangeSessionEligible
        ? "Assigned Tasks are your work contracts. Canonical Task changes are delivered in context, but presentation never changes Task state. Stopped-epoch migration is explicit and never runs during normal runtime. Set an accepted Task in_progress when work starts. When you finish, call task_update yourself to set it closed and append verification evidence; never leave completion only in a TUI reply. If the work is blocked, call task_update with status blocked, concrete blocker evidence, and the next action. Use alert_send only for exceptional clarification or escalation; an alert never completes or blocks a Task. Re-read Task authority before a conflicting write."
        : "This fork is a new Session identity and receives none of the source Agent's pending Task changes.";
      return {
        systemPrompt: event.systemPrompt + `\n\nYou are Worker '${agentName}' on Team '${teamName}'.\nYour lead is 'team-lead'.${modelInfo}${profileInfo}\n${taskInstruction}`,
      };
    }
  });

  type TeammateStopEvidence = {
    kind: "terminal_pane_stopped" | "terminal_window_stopped" | "bound_process_already_exited";
    adapter?: string;
    target?: string;
    membershipId: string;
  };

  function exactRuntimeGeneration(member: Member, status: runtime.AgentRuntimeStatus | null): runtime.RuntimeGeneration | null {
    const generation = runtime.runtimeGeneration(status);
    return member.membershipId && generation?.membershipId === member.membershipId ? generation : null;
  }

  function exactBoundProcessAlreadyExited(generation: runtime.RuntimeGeneration | null): boolean {
    if (!generation || generation.pid === process.pid) return false;
    try {
      process.kill(generation.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }

  async function killTeammate(teamName: string, member: Member): Promise<TeammateStopEvidence> {
    if (member.name === "team-lead") throw new Error("The team leader has no teammate terminal stop operation.");
    if (!member.membershipId) throw new Error(`Cannot stop ${member.name}: its current Membership has no stable identity.`);

    // Runtime status is usable only when it names this exact Membership
    // generation. We never kill a PID from this durable record: after PID reuse,
    // the record cannot prove that the live OS process is still the teammate.
    // It can safely prove the weaker fact that the recorded process no longer
    // exists, which lets an operator finalize a manually closed Windows/Zellij
    // teammate without reviving the old unscoped *.pid behavior.
    const status = await runtime.readRuntimeStatus(teamName, member.name);
    const observedGeneration = exactRuntimeGeneration(member, status);
    if (exactBoundProcessAlreadyExited(observedGeneration)) {
      const deleted = await runtime.deleteRuntimeStatus(teamName, member.name, observedGeneration!);
      if (!deleted) {
        throw new Error(
          `Cannot confirm shutdown of ${member.name}: its runtime process generation changed after exit evidence. ` +
          "The Membership remains current; inspect the resumed process and retry.",
        );
      }
      return {
        kind: "bound_process_already_exited",
        membershipId: member.membershipId,
      };
    }

    const teamConfig = await teams.readConfig(teamName);
    const teamTerminal = terminalForTeam(teamConfig);
    const target = teamConfig.terminalBackend
      ? assertTeamTerminalTarget(teamConfig, member)
      : memberTerminalTarget(member, teamTerminal.name);
    if (!target) {
      throw new Error(
        `Cannot stop ${member.name}: this Membership has no terminal binding and no exact Membership-bound runtime record proves the process exited. ` +
        "The Membership remains current.",
      );
    }
    assertTargetSupportedByTerminal(teamTerminal, target);

    if (target.kind === "window") {
      teamTerminal.killWindow(target.targetId);
      if (teamTerminal.isWindowAlive(target.targetId)) {
        throw new Error(
          `Cannot confirm shutdown of ${member.name}: ${teamTerminal.name} did not stop window ${target.targetId}. ` +
          "The Membership remains current; close the process manually and retry.",
        );
      }
      if (observedGeneration) await runtime.deleteRuntimeStatus(teamName, member.name, observedGeneration);
      return {
        kind: "terminal_window_stopped",
        adapter: target.backend,
        target: target.targetId,
        membershipId: member.membershipId,
      };
    }

    teamTerminal.kill(target.targetId);
    if (teamTerminal.isAlive(target.targetId)) {
      throw new Error(
        `Cannot confirm shutdown of ${member.name}: ${teamTerminal.name} did not stop pane ${target.targetId}. ` +
        "The Membership remains current; close the process manually and retry.",
      );
    }
    if (observedGeneration) await runtime.deleteRuntimeStatus(teamName, member.name, observedGeneration);
    return {
      kind: "terminal_pane_stopped",
      adapter: target.backend,
      target: target.targetId,
      membershipId: member.membershipId,
    };
  }

  async function transitionCurrentMembership(
    targetTeamName: string,
    member: Member,
    reason: NonNullable<Member["deactivationReason"]>,
    stopTerminal: boolean,
  ): Promise<{ member: Member | null; stopEvidence?: TeammateStopEvidence }> {
    if (!member.membershipId) {
      throw new Error(`Current Membership for ${member.name} on team ${targetTeamName} has no membershipId.`);
    }
    return teams.withCurrentMembershipLease(targetTeamName, member.membershipId, async (current) => {
      const stopEvidence = stopTerminal ? await killTeammate(targetTeamName, current) : undefined;
      return {
        member: await teams.deactivateMembership(targetTeamName, member.membershipId!, reason),
        stopEvidence,
      };
    });
  }

  if (modelToolJourney) {
    modelToolLifecycleAdapter = {
      async teamCreated(targetTeamName, sessionFile) {
        isTeammate = false;
        agentName = "team-lead";
        teamName = targetTeamName;
        const config = await teams.readConfig(targetTeamName);
        currentMembershipId = config.members.find((member) => member.name === "team-lead" && member.isActive !== false)?.membershipId;
        await registerLeadSession(targetTeamName, sessionFile, undefined, true, currentMembershipId);
        startSyncNudgeConductor(leaderContext);
      },
      async stopWorker(targetTeamName, worker) {
        const safeTeamName = paths.sanitizeName(targetTeamName);
        const safeWorker = paths.sanitizeName(worker);
        return teams.withTeamTopologyLease(safeTeamName, async () => {
          const config = await teams.readConfig(safeTeamName);
          const member = [...config.members].reverse().find((candidate) => candidate.name === safeWorker && candidate.isActive !== false);
          if (!member) return { kind: "refused" as const, worker: safeWorker, reason: "worker_not_found" as const, message: `Worker ${safeWorker} is not current.` };
          if (member.name === "team-lead" || member.agentType === "lead") return { kind: "refused" as const, worker: safeWorker, reason: "leader_reserved" as const, message: "The Team leader is reserved; use team_shutdown for whole-Team closure." };
          const unfinished = await tasks.listTasksWithVersions(safeTeamName, { assignee: safeWorker, nonterminalOnly: true });
          if (unfinished.length > 0) return { kind: "refused" as const, worker: safeWorker, reason: "nonterminal_tasks_assigned" as const, message: `Worker ${safeWorker} has nonterminal Tasks.`, guardingTaskIds: unfinished.map((task) => task.id) };
          try {
            const changed = await transitionCurrentMembership(safeTeamName, member, "process_shutdown", true);
            await teamEvents.appendTeamEvent(safeTeamName, { type: "worker", worker: safeWorker, membershipId: member.membershipId!, phase: "stopped" });
            if (!changed.member) return { kind: "refused" as const, worker: safeWorker, reason: "stop_not_confirmed" as const, message: `Worker ${safeWorker} was not deactivated.` };
            return { kind: "stopped" as const, worker: safeWorker };
          } catch (error) {
            return { kind: "refused" as const, worker: safeWorker, reason: "stop_not_confirmed" as const, message: error instanceof Error ? error.message : String(error) };
          }
        });
      },
      async shutdownTeam(targetTeamName) {
        const safeTeamName = paths.sanitizeName(targetTeamName);
        return teams.withTeamTopologyLease(safeTeamName, async () => {
          const config = await teams.readConfig(safeTeamName);
          const current = config.members.filter((member) => member.isActive !== false);
          const teammates = current.filter((member) => member.name !== "team-lead" && member.agentType !== "lead");
          const stoppedWorkers: string[] = [];
          const failedWorkers: string[] = [];
          await Promise.all(teammates.map(async (member) => {
            try {
              const changed = await transitionCurrentMembership(safeTeamName, member, "team_shutdown", true);
              if (changed.member) stoppedWorkers.push(member.name);
            } catch {
              failedWorkers.push(member.name);
            }
          }));
          if (failedWorkers.length === 0) {
            const lead = current.find((member) => member.name === "team-lead" || member.agentType === "lead");
            if (lead) await transitionCurrentMembership(safeTeamName, lead, "team_shutdown", false);
          }
          const unfinishedTaskIds = (await tasks.listTasksWithVersions(safeTeamName, { nonterminalOnly: true })).map((task) => task.id);
          if (failedWorkers.length > 0) return { kind: "partial" as const, stoppedWorkers: stoppedWorkers.sort(), failedWorkers: failedWorkers.sort(), unfinishedTaskIds };
          return { kind: "shutdown" as const, stoppedWorkers: stoppedWorkers.sort(), unfinishedTaskIds };
        });
      },
    };
  }

  // Workers receive only the current semantic Task and Alert tools. The
  // leader model surface is registered by registerModelToolJourney above.
  function registerWorkerSemanticTools(): void {
    registerWorkerTool({
      name: "task_read",
      label: "Read Task",
      description: "Read current Task cards by ID from the active Team.",
      parameters: Type.Object({
        task_id: Type.String({ minLength: 1 }),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params: { task_id: string }, _signal, _onUpdate, ctx) {
        const binding = await resolveCurrentWorkerContext(ctx);
        const outcome = await taskAdapterFactory(binding.teamName, binding.member.name).read(params.task_id);
        return assembleToolResult("task_read", {
          kind: "task_read_batch",
          outcomes: [outcome.kind === "found"
            ? { kind: "found", input_index: 0, task_id: outcome.task.id, task: outcome.task }
            : { kind: "contract_gap", input_index: 0, task_id: outcome.taskId, reason: outcome.reason, version: outcome.version, message: outcome.message, state_changed: false }],
        });
      },
    });

    registerWorkerTool({
      name: "task_update",
      label: "Update Task",
      description: "Apply current Task changes, or set claim=true alone for an atomic claim with no status change, using an exact opaque TaskVersionRef.",
      parameters: Type.Object({
        task_id: Type.String({ minLength: 1 }),
        operation_id: Type.String({ minLength: 1 }),
        claim: Type.Optional(Type.Literal(true, { description: "Do not include current_context, journal_entries, or status with claim=true." })),
        expected_version: TaskVersionRefSchema,
        current_context: Type.Optional(Type.String({ minLength: 1 })),
        journal_entries: Type.Optional(Type.Array(Type.Object({ kind: Type.Enum(["progress", "decision", "blocker", "result", "note"]), text: Type.String({ minLength: 1 }) }, { additionalProperties: false }), { minItems: 1 })),
        status: Type.Optional(StringEnum(["open", "in_progress", "blocked", "closed"])),
      }, { additionalProperties: false, minProperties: 3 }),
      async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
        const binding = await resolveCurrentWorkerContext(ctx);
        const adapter = taskAdapterFactory(binding.teamName, binding.member.name);
        if (params.claim === true && (params.current_context !== undefined || params.journal_entries !== undefined || params.status !== undefined)) {
          throw new Error("claim=true is atomic; do not include current_context, journal_entries, or status.");
        }
        const result = params.claim === true
          ? await adapter.claim({ taskId: params.task_id, operationId: params.operation_id, expectedVersion: params.expected_version })
          : await adapter.update({
            taskId: params.task_id,
            operationId: params.operation_id,
            expectedVersion: params.expected_version,
            ...(params.current_context !== undefined ? { currentContext: params.current_context } : {}),
            ...(params.journal_entries !== undefined ? { journalEntries: params.journal_entries } : {}),
            ...(params.status !== undefined ? { status: params.status } : {}),
          });
        const outcome = result.kind === "updated"
          ? { kind: "updated", input_index: 0, task_id: result.taskId, operation_id: result.operationId, task: result.task, journal_entries: result.journalEntries }
          : result.kind === "refused"
            ? { kind: "refused", input_index: 0, task_id: result.taskId, operation_id: result.operationId, reason: result.reason, message: result.message, current_task: result.currentTask, state_changed: false }
            : { kind: "contract_gap", input_index: 0, task_id: result.taskId, operation_id: "operationId" in result ? result.operationId : params.operation_id, reason: result.reason, message: result.message, ...( "currentTask" in result ? { current_task: result.currentTask } : {}), unsupported: "unsupported" in result ? [...result.unsupported] : ["task_authority"], state_changed: false };
        return assembleToolResult("task_update", { kind: "task_update_batch", outcomes: [outcome] } as any);
      },
    });

    const alertRegistration = {
      name: "alert_send",
      label: "Send Alert",
      description: "Send exceptional clarification or attention to team-lead.",
      parameters: Type.Object({
        kind: StringEnum(["clarification", "attention"]),
        text: Type.String({ minLength: 1 }),
        task_id: Type.Optional(Type.String({ minLength: 1 })),
        task_version: Type.Optional(TaskVersionRefSchema),
      }),
      async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
        const binding = await resolveCurrentWorkerContext(ctx);
        const actor = binding.member;
        try {
          const result = await alerts.sendAlert({ teamName: binding.teamName, from: actor.name, to: "team-lead", kind: params.kind, text: params.text, taskId: params.task_id, taskVersion: params.task_version, expectedSender: actor.membershipId && actor.sessionFile ? { membershipId: actor.membershipId, sessionFile: actor.sessionFile } : undefined });
          return assembleToolResult("alert_send", { kind: "alert_sent", alert_id: result.alertId, accepted_recipients: result.accepted.map((item) => item.recipient), failed_recipients: result.failures.map((item) => item.recipient), task_state_changed: false });
        } catch (error) {
          return assembleToolResult("alert_send", { kind: "refused", reason: "no_eligible_recipients", message: error instanceof Error ? error.message : String(error), state_changed: false });
        }
      },
    };
    registerWorkerTool(alertRegistration as any);
  }
  registerWorkerSemanticTools();
}
