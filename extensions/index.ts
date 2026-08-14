import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { createAlertSender } from "../src/alert-authority/alerts";
import { createToolResultRenderer } from "../src/model-tool-contract/tui-projection";
import { resolveQualifiedWorkerDefaultModel, resolveWorkerLaunchResources } from "../src/utils/worker-resource-projection";
import { SYNC_NUDGE_CUSTOM_TYPE, syncNudgeTuiLine, validateSyncNudgeRecord } from "../src/utils/sync-nudge";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { registerAutomaticSummaryPolicyProvider } from "../src/utils/automatic-summary-policy";
import { createWorkerLaunchBridge, type WorkerAggregate } from "../src/team-authority/worker-launch-bridge";
import { DurableAssignedWorkGuard } from "../src/adapters/durable-assigned-work-guard";
import { DurableNonterminalAssignedTaskQuery } from "../src/adapters/durable-nonterminal-assigned-task-query";
import { DurableTeamLifecyclePublication } from "../src/adapters/durable-team-lifecycle-publication";
import { TeamLifecycleService } from "../src/team-authority/team-lifecycle-service";
import { TeamSessionLifecycleService } from "../src/team-authority/team-session-lifecycle-service";
import { createPublishingBeadsTaskAdapterFactory, createReadOnlyBeadsTaskAdapterFactory } from "../src/model-tool-contract/beads-task-adapter";
import { DurableTaskAuthorityProvisioning } from "../src/adapters/durable-task-authority-provisioning";
import { projectNonterminalTaskIds, projectTaskChanges } from "../src/model-tool-contract/beads-task-adapter";
import { DurableTaskMutationPublication } from "../src/adapters/durable-task-mutation-publication";
import { DurableTaskOrchestration } from "../src/adapters/durable-task-orchestration";
import { DurableGraphTaskAuthority } from "../src/adapters/durable-graph-task-authority";
import { graphTaskAuthorityPath } from "../src/utils/paths";
import { DurableGraphTaskOrchestration } from "../src/task-authority/graph-orchestration";
import { DurableGraphAssignedWorkGuard } from "../src/adapters/durable-graph-assigned-work";
import { CompositeAssignedWorkGuard } from "../src/adapters/composite-assigned-work-guard";
import { DurableTaskAuthorityTeam } from "../src/adapters/durable-task-authority-team";
import { DurableTaskAuthorityRead } from "../src/adapters/durable-task-authority-read";
import { DurableTaskAuthorityReadTeam } from "../src/adapters/durable-task-authority-read-team";
import { DurableTaskChangeDeliveryMembership } from "../src/adapters/durable-task-change-delivery-membership";
import { DurablePiSessionTeamQuery } from "../src/adapters/durable-pi-session-team-query";
import { DurableAlertMembership } from "../src/adapters/durable-alert-membership";
import { DurableAlertPublication } from "../src/adapters/durable-alert-publication";
import { DurableCoordinationNudgeRecord } from "../src/adapters/durable-coordination-nudge-record";
import { createDurableCoordinationNudgeStore } from "../src/adapters/durable-coordination-nudge-store";
import { createDurableCoordinationQueries } from "../src/adapters/durable-coordination-queries";
import { CoordinationObservationService, createDurableCoordinationObservationStore } from "../src/coordination/observation-service";
import { DurableCoordinationHiddenObservation } from "../src/adapters/durable-coordination-hidden-observation";
import { createPiTeamSessionAdapter } from "./pi-team-session-adapter";

import { GraphTaskUpdateParametersSchema, TaskVersionRefSchema } from "../src/model-tool-contract/catalog";
import { transitionLegacyGraphTask } from "../src/model-tool-contract/legacy-graph-task-transition-adapter";
import {
  DurableModelToolAlertApplication,
  DurableModelToolBindings,
  DurableModelToolCoordinationApplication,
  DurableModelToolTaskApplication,
  DurableModelToolTeamApplication,
  type ModelToolLifecycle,
} from "../src/model-tool-contract/durable-model-tool-port";
import { ModelToolJourneyFacade } from "../src/model-tool-contract/model-tool-journey-facade";
import { exactLeaderSessionId, registerModelToolJourney } from "../src/model-tool-contract/runtime";
import { assembleToolResult } from "../src/model-tool-contract/result-projection";

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
    "team_create", "ensure_worker", "task_graph_apply", "task_read", "task_update", "team_sync",
    "worker_stop", "team_shutdown", "alert_send",
  ]);
  const workerToolNames = new Set(["task_read", "task_update", "alert_send"]);
  // `team-lead` is a reserved leader identity, even when explicitly supplied
  // through the Worker launch environment.
  const initialIsTeammate = !!process.env.PI_AGENT_NAME && process.env.PI_AGENT_NAME !== "team-lead";
  let sessionAdapter!: ReturnType<typeof createPiTeamSessionAdapter>;
  const workerToolDefinitions = new Map<string, ToolDefinition<any, any>>();
  let alertToolRegistration: { description: string; parameters: unknown } | undefined;
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
    if ((sessionAdapter?.isTeammate() ?? initialIsTeammate) && workerToolNames.has(tool.name)) registerProjectedWorkerTool(tool);
  }

  function registerRecoveredWorkerTools(): void {
    for (const name of workerToolNames) {
      const tool = workerToolDefinitions.get(name);
      if (tool) registerProjectedWorkerTool(tool);
    }
  }

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

  const taskAuthorityTeam = new DurableTaskAuthorityTeam();
  const taskAuthorityReadTeam = new DurableTaskAuthorityReadTeam();
  const taskAuthorityRead = new DurableTaskAuthorityRead(taskAuthorityReadTeam);
  const taskReadAdapterFactory = createReadOnlyBeadsTaskAdapterFactory(taskAuthorityRead);
  const taskPublication = new DurableTaskMutationPublication();
  const taskOrchestration = new DurableTaskOrchestration(taskPublication, taskPublication);
  const graphTaskAuthority = new DurableGraphTaskAuthority();
  const graphTaskOrchestration = new DurableGraphTaskOrchestration(graphTaskAuthority, taskPublication, taskPublication, taskPublication);
  const taskAdapterFactory = createPublishingBeadsTaskAdapterFactory(taskPublication, taskAuthorityTeam, taskAuthorityRead, taskOrchestration);
  const alertMembership = new DurableAlertMembership();
  const taskDeliveryMembership = new DurableTaskChangeDeliveryMembership();
  const piSessionTeamQuery = new DurablePiSessionTeamQuery();
  const alertPublication = new DurableAlertPublication();
  const alertSender = createAlertSender(alertMembership, alertPublication);
  const coordinationQueries = createDurableCoordinationQueries(taskReadAdapterFactory, graphTaskOrchestration);
  const coordinationHiddenObservation = new DurableCoordinationHiddenObservation();
  const coordinationNudgeStore = createDurableCoordinationNudgeStore(coordinationHiddenObservation);
  const coordinationObservationService = new CoordinationObservationService(
    coordinationQueries,
    { projectNonterminalTaskIds, projectTaskChanges },
    createDurableCoordinationObservationStore(coordinationHiddenObservation),
    undefined,
    coordinationNudgeStore,
  );
  const nudgeRecords = new DurableCoordinationNudgeRecord();

  const lifecyclePublication = new DurableTeamLifecyclePublication();
  const legacyAssignedWorkGuard = new DurableAssignedWorkGuard(
    taskReadAdapterFactory,
    new DurableNonterminalAssignedTaskQuery(taskAuthorityRead),
  );
  const graphAssignedWorkGuard = new DurableGraphAssignedWorkGuard(graphTaskOrchestration);
  const teamLifecycleService = new TeamLifecycleService({
    assignedWorkGuard: new CompositeAssignedWorkGuard(graphAssignedWorkGuard, legacyAssignedWorkGuard),
    lifecyclePublication,
  });
  const teamSessionLifecycleService = new TeamSessionLifecycleService(lifecyclePublication);
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
    lifecyclePublication,
  });

  let modelToolLifecycleAdapter: ModelToolLifecycle | undefined;
  let modelToolJourney: ReturnType<typeof registerModelToolJourney> | undefined;
  if (!initialIsTeammate) {
    const lifecycle: ModelToolLifecycle = {
      teamCreated: async (name, sessionFile) => modelToolLifecycleAdapter?.teamCreated?.(name, sessionFile),
      stopWorker: async (name, worker) => modelToolLifecycleAdapter
        ? modelToolLifecycleAdapter.stopWorker(name, worker)
        : { kind: "unavailable", reason: "carrier_unavailable", message: "Model-tool lifecycle adapter is not ready." },
      shutdownTeam: async (name) => modelToolLifecycleAdapter
        ? modelToolLifecycleAdapter.shutdownTeam(name)
        : { kind: "unavailable", reason: "team_authority_unavailable", message: "Model-tool lifecycle adapter is not ready." },
    };
    const modelToolBindings = new DurableModelToolBindings();
    const taskAuthorityProvisioning = new DurableTaskAuthorityProvisioning();
    const modelToolTeam = new DurableModelToolTeamApplication(modelToolBindings, workerLaunchBridge, lifecycle, taskAuthorityProvisioning);
    const modelToolTask = new DurableModelToolTaskApplication(modelToolBindings, taskAdapterFactory, taskOrchestration, graphTaskOrchestration);
    const modelToolAlert = new DurableModelToolAlertApplication(modelToolBindings, alertSender);
    const modelToolCoordination = new DurableModelToolCoordinationApplication(modelToolBindings, coordinationObservationService);
    modelToolJourney = registerModelToolJourney(pi, new ModelToolJourneyFacade(modelToolTeam, modelToolTask, modelToolAlert, modelToolCoordination));
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
      if (sessionAdapter.isTeammate() || !leaderToolNames.has(event.toolName)) return;
      modelToolJourney.port.coordination.setBranchContext(
        exactLeaderSessionId(ctx.sessionManager.getSessionId()),
        modelToolBranchIds(ctx),
      );
    });
    pi.on("before_provider_request", async (event, ctx) => {
      if (sessionAdapter.isTeammate()) return;
      const sessionId = exactLeaderSessionId(ctx.sessionManager.getSessionId());
      const lineage = modelToolBranchIds(ctx);
      modelToolJourney.port.coordination.setBranchContext(sessionId, lineage);
      const pending = modelToolJourney.port.coordination.getPendingObservation?.(sessionId);
      if (!pending || !modelToolContainsExact(event.payload, pending.resultText)) return;
      const entryId = modelToolPersistedToolResult(ctx, pending.toolCallId, pending.resultText);
      if (!entryId) return;
      if (modelToolJourney.port.coordination.acknowledgePendingObservationAsync) {
        await modelToolJourney.port.coordination.acknowledgePendingObservationAsync(sessionId, entryId, lineage);
      } else {
        modelToolJourney.port.coordination.acknowledgePendingObservation(sessionId, entryId, lineage);
      }
    });
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
      description: (sessionAdapter?.isTeammate() ?? initialIsTeammate)
        ? "Send exceptional clarification or attention to team-lead. Alerts never assign or complete work; update the Task when durable intent changes."
        : "Send exceptional clarification, attention, or a Team announcement. Alerts never assign or complete work; update the Task when durable intent changes.",
      parameters: (sessionAdapter?.isTeammate() ?? initialIsTeammate)
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


  sessionAdapter = createPiTeamSessionAdapter({
    pi,
    teamSessionLifecycleService,
    teamLifecycleService,
    getModelToolJourney: () => modelToolJourney,
    modelToolBranchIds,
    projectTrust,
    lifecyclePublication,
    alertMembership,
    taskDeliveryMembership,
    nudgeRecords,
    taskReadAdapterFactory,
    teamQuery: piSessionTeamQuery,
    leaderToolNames,
    workerToolNames,
    refreshAlertToolProjection,
    registerRecoveredWorkerTools,
    taskReadyReconciliation: {
      reconcileReady: (team, worker) => graphTaskOrchestration.hasGraph(team)
        ? graphTaskOrchestration.reconcileReady(team, worker)
        : taskOrchestration.reconcileReady(team, worker),
    },
    taskGraphControlSource: {
      hasGraph: (teamName) => graphTaskAuthority.exists(teamName),
      trace: (teamName) => graphTaskAuthority.trace(teamName),
      watchPath: (teamName) => graphTaskAuthorityPath(teamName),
    },
  });
  modelToolLifecycleAdapter = sessionAdapter.modelToolLifecycle;
  sessionAdapter.register();

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
        const binding = await sessionAdapter.resolveCurrentWorkerContext(ctx);
        if (graphTaskOrchestration.hasGraph(binding.teamName)) {
          const task = (await graphTaskOrchestration.readTasks(binding.teamName, [params.task_id]))[0];
          return assembleToolResult("task_read", {
            kind: "task_read_batch",
            outcomes: [task
              ? { kind: "found", input_index: 0, task_id: task.id, task }
              : { kind: "missing", input_index: 0, task_id: params.task_id, reason: "task_not_found", state_changed: false }],
          } as any);
        }
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
      description: "Apply one explicit graph-native Task transition with an exact Task version. dependency_waiting and ready are derived.",
      parameters: GraphTaskUpdateParametersSchema,
      async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
        const binding = await sessionAdapter.resolveCurrentWorkerContext(ctx);
        if (graphTaskOrchestration.hasGraph(binding.teamName)) {
          const result = await graphTaskOrchestration.transition(binding.teamName, {
            taskId: params.task_id,
            operationId: params.operation_id,
            expectedVersion: params.expected_version,
            ...(params.transition ? { transition: params.transition } : {}),
            ...(params.current_context ? { currentContext: params.current_context } : {}),
            ...(params.evidence ? { evidence: params.evidence } : {}),
            ...(params.transition && params.transition !== "cancel" ? { worker: binding.member.name } : {}),
          }, binding.member.name);
          const outcome = result.kind === "updated"
            ? {
              kind: "updated", input_index: 0, task_id: result.task.id, operation_id: result.operationId,
              replayed: result.replayed, transition: result.transition, task: result.task,
              ready_task_ids: result.readyTaskIds,
              ...(result.failureTraversal ? { failure_traversal: { source_task_id: result.failureTraversal.sourceTaskId, target_task_id: result.failureTraversal.targetTaskId, traversal: result.failureTraversal.traversal } } : {}),
              ...(result.deliveryWarnings.length ? { delivery_warnings: result.deliveryWarnings } : {}),
            }
            : result.kind === "refused"
              ? { kind: "refused", input_index: 0, task_id: result.taskId, operation_id: result.operationId, reason: result.reason, message: result.message, ...(result.currentTask ? { current_task: result.currentTask } : {}), state_changed: false }
              : { kind: "unknown_outcome", input_index: 0, task_id: result.taskId, operation_id: result.operationId, message: result.message };
          return assembleToolResult("task_update", outcome as any);
        }
        const result = await transitionLegacyGraphTask(
          taskAdapterFactory(
            binding.teamName,
            binding.member.name,
            binding.member.membershipId && binding.member.sessionFile
              ? { membershipId: binding.member.membershipId, sessionFile: binding.member.sessionFile }
              : undefined,
          ),
          {
            taskId: params.task_id,
            operationId: params.operation_id,
            expectedVersion: params.expected_version,
            ...(params.transition ? { transition: params.transition } : {}),
            ...(params.current_context ? { currentContext: params.current_context } : {}),
            ...(params.evidence ? { evidence: params.evidence } : {}),
            worker: binding.member.name,
          },
        );
        const outcome = result.kind === "updated"
          ? {
            kind: "updated", input_index: 0, task_id: result.taskId, operation_id: result.operationId,
            replayed: result.replayed ?? false, transition: result.transition ?? "context_updated", task: result.task,
            ready_task_ids: result.readyTaskIds ?? [],
            ...(result.failureTraversal ? { failure_traversal: { source_task_id: result.failureTraversal.sourceTaskId, target_task_id: result.failureTraversal.targetTaskId, traversal: result.failureTraversal.traversal } } : {}),
            ...(result.deliveryWarnings?.length ? { delivery_warnings: result.deliveryWarnings } : {}),
          }
          : result.kind === "refused"
            ? { kind: "refused", input_index: 0, task_id: result.taskId, operation_id: result.operationId, reason: result.reason, message: result.message, ...(result.currentTask ? { current_task: result.currentTask } : {}), state_changed: false }
            : result.kind === "unknown_outcome"
              ? { kind: "unknown_outcome", input_index: 0, task_id: result.taskId, operation_id: result.operationId, message: result.message }
              : { kind: "unavailable", input_index: 0, task_id: result.taskId, operation_id: result.operationId, reason: result.reason, message: result.message, state_changed: false };
        return assembleToolResult("task_update", outcome as any);
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
        const binding = await sessionAdapter.resolveCurrentWorkerContext(ctx);
        const actor = binding.member;
        try {
          const result = await alertSender.sendAlert({ teamName: binding.teamName, from: actor.name, to: "team-lead", kind: params.kind, text: params.text, taskId: params.task_id, taskVersion: params.task_version, expectedSender: actor.membershipId && actor.sessionFile ? { membershipId: actor.membershipId, sessionFile: actor.sessionFile } : undefined });
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
