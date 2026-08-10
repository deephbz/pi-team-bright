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
import { DurableTeamLifecyclePublication } from "../src/adapters/durable-team-lifecycle-publication";
import { TeamLifecycleService } from "../src/team-authority/team-lifecycle-service";
import { TeamSessionLifecycleService } from "../src/team-authority/team-session-lifecycle-service";
import { createPublishingBeadsTaskAdapterFactory } from "../src/model-tool-contract/beads-task-adapter";
import { DurableTaskMutationPublication } from "../src/adapters/durable-task-mutation-publication";
import { DurableAlertMembership } from "../src/adapters/durable-alert-membership";
import { DurableAlertPublication } from "../src/adapters/durable-alert-publication";
import { createDurableCoordinationQueries } from "../src/adapters/durable-coordination-queries";
import { createPiTeamSessionAdapter } from "./pi-team-session-adapter";

import { TaskVersionRefSchema } from "../src/model-tool-contract/catalog";
import { DurableModelToolTeamPort, type ModelToolLifecycle } from "../src/model-tool-contract/durable-model-tool-port";
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
    "team_create", "ensure_worker", "task_create", "task_read", "task_update", "team_sync",
    "worker_stop", "team_shutdown", "task_link", "alert_send",
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

  const taskAdapterFactory = createPublishingBeadsTaskAdapterFactory(new DurableTaskMutationPublication());
  const alertMembership = new DurableAlertMembership();
  const alertPublication = new DurableAlertPublication();
  const alertSender = createAlertSender(alertMembership, alertPublication);
  const coordinationQueries = createDurableCoordinationQueries();

  const lifecyclePublication = new DurableTeamLifecyclePublication();
  const teamLifecycleService = new TeamLifecycleService({
    assignedWorkGuard: new DurableAssignedWorkGuard(),
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
    modelToolJourney = registerModelToolJourney(pi, new DurableModelToolTeamPort(workerLaunchBridge, lifecycle, taskAdapterFactory, alertSender, coordinationQueries));
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
      modelToolJourney.port.setBranchContext(
        exactLeaderSessionId(ctx.sessionManager.getSessionId()),
        modelToolBranchIds(ctx),
      );
    });
    pi.on("before_provider_request", async (event, ctx) => {
      if (sessionAdapter.isTeammate()) return;
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
    leaderToolNames,
    workerToolNames,
    refreshAlertToolProjection,
    registerRecoveredWorkerTools,
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
        const binding = await sessionAdapter.resolveCurrentWorkerContext(ctx);
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
