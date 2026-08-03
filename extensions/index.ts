import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import * as paths from "../src/utils/paths";
import * as teams from "../src/utils/teams";
import * as tasks from "../src/utils/tasks";
import { BeadsError } from "../src/utils/beads";
import * as messaging from "../src/utils/messaging";
import * as alerts from "../src/utils/alerts";
import * as teamEvents from "../src/utils/team-events";
import { selectTeamSyncNextActions, summarizeTeamSyncNextActions } from "../src/utils/team-sync-actions";
import { toolResultDetails, warning as toolResultWarning, type WorkerEnsurePostState } from "../src/utils/receipt-types";
import { createCandidateToolResultRenderer } from "../src/model-tool-contract/tui-projection";
import {
  DirectMessageDelivery,
  messagePollMs,
} from "../src/utils/message-delivery";
import {
  TaskChangeDelivery,
  taskPollMs,
} from "../src/utils/task-delivery";
import * as runtime from "../src/utils/runtime";
import { loadWorkerResourcePolicy, materializeWorkerAggregate, ownsWorkerAggregate, projectWorkerTools, removeWorkerAggregate, resolveWorkerLaunchResources, type WorkerResourcePolicy } from "../src/utils/worker-resource-projection";
import { clearTeamFooter, syncTeamFooter } from "../src/utils/team-footer";
import { IdentifiedInboxMessage, Member, TaskFile, TeamConfig } from "../src/utils/models";
import { getTerminalAdapter } from "../src/adapters/terminal-registry";
import { assertTeamTerminalTarget, hasPersistedTerminalTarget, memberTerminalTarget, terminalTarget } from "../src/utils/terminal-target";
import { assertTargetSupportedByTerminal, terminalForTeam } from "../src/utils/team-terminal";
import {
  admitTeamSession,
  placeSessionTerminal,
  type TeamIdentitySource,
  type TeamSessionAdmission,
} from "../src/utils/session-terminal";
import { Iterm2Adapter } from "../src/adapters/iterm2-adapter";
import * as predefined from "../src/utils/predefined-teams";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { registerAutomaticSummaryPolicyProvider } from "../src/utils/automatic-summary-policy";
import { createWorkerLaunchBridge, launchObservationState } from "../src/utils/worker-launch-bridge";
import { parseCandidateTaskMetadata, refreshCandidateTaskMetadata } from "../src/model-tool-contract/beads-task-adapter";
import { MODEL_TOOL_IMPLEMENTATION_VERSION, MODEL_TOOL_PREVIEW_WORKER_MARKER } from "../src/model-tool-contract/preview-constants";
import type { CandidateTaskMetadata } from "../src/utils/beads";
import { DurablePreviewTeamPort, type DurablePreviewLifecycle } from "../src/model-tool-contract/durable-preview-port";
import { exactLeaderSessionId, registerModelToolJourney } from "../src/model-tool-contract/runtime";
import { assembleCandidateToolResult } from "../src/model-tool-contract/result-projection";
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

/** Find the team this durable Pi Session leads. */
function findLeadTeamForSession(piSessionFile?: string): string | null {
  const teamsDir = paths.TEAMS_DIR;
  if (!fs.existsSync(teamsDir)) return null;

  const sessionMatches: string[] = [];
  for (const teamDir of fs.readdirSync(teamsDir)) {
    try {
      const recordPath = paths.configPath(teamDir);
      if (!fs.existsSync(recordPath)) continue;
      const config = JSON.parse(fs.readFileSync(recordPath, "utf-8")) as {
        members?: Member[];
      };
      const lead = [...(config.members || [])].reverse().find(
        (member) => member.name === "team-lead" && member.isActive !== false,
      );
      if (piSessionFile && lead?.sessionFile === piSessionFile) sessionMatches.push(teamDir);
    } catch {
      // Ignore corrupted session files.
    }
  }

  if (sessionMatches.length > 1) {
    throw new Error(
      `Ambiguous lead Session binding: this durable Pi Session is registered to multiple teams (${sessionMatches.join(", ")}). ` +
      "Refusing to choose by filesystem order. Set PI_TEAM_NAME to the intended current team before resuming, or repair the stale lead-session records.",
    );
  }
  if (sessionMatches.length === 1) return sessionMatches[0];
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

type WorkerProjectedTool = "task_read" | "task_update" | "alert_send";
type UnknownRecord = Record<string, unknown>;

type WorkerTaskCard = {
  id: string;
  title: string;
  goal: string;
  status: "open" | "in_progress" | "blocked" | "closed";
  assignee?: string;
  current_context: string;
  version: string;
};

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Unsupported legacy Worker receipt: ${field} is missing.`);
  return value;
}

function workerTaskCard(value: unknown): WorkerTaskCard {
  const task = asRecord(value);
  if (!task) throw new Error("Unsupported legacy Worker receipt: Task post-state is missing.");
  const status = task.status;
  if (status !== "open" && status !== "in_progress" && status !== "blocked" && status !== "closed") {
    throw new Error("Unsupported legacy Worker receipt: Task status is invalid.");
  }
  const id = requiredString(task.id, "postState.id");
  const title = typeof task.title === "string" && task.title.length > 0 ? task.title : id;
  const goal = [task.description, task.acceptanceCriteria, task.title, task.id]
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0) ?? id;
  return {
    id,
    title,
    goal,
    status,
    ...(typeof task.assignee === "string" && task.assignee.length > 0 ? { assignee: task.assignee } : {}),
    current_context: typeof task.notes === "string" && task.notes.length > 0 ? task.notes : "No current Task context is recorded.",
    version: requiredString(task.version, "postState.version"),
  };
}

function receiptWarnings(details: UnknownRecord): UnknownRecord[] {
  return Array.isArray(details.warnings) ? details.warnings.flatMap((value) => asRecord(value) ? [value] : []) : [];
}

function receiptMessage(result: UnknownRecord, warnings: readonly UnknownRecord[]): string {
  const warning = warnings.map((value) => value.message).find((value): value is string => typeof value === "string" && value.length > 0);
  const content = Array.isArray(result.content)
    ? result.content.flatMap((value) => asRecord(value) ? [value.text] : []).find((value): value is string => typeof value === "string" && value.length > 0)
    : undefined;
  return warning ?? content ?? "The operation was refused.";
}

function reasonFromReceipt(
  postState: UnknownRecord | undefined,
  warningCodes: ReadonlySet<string>,
  allowed: readonly string[],
  codeReasons: Readonly<Record<string, string>>,
): string | undefined {
  if (postState && typeof postState.reason === "string" && allowed.includes(postState.reason)) return postState.reason;
  for (const [code, reason] of Object.entries(codeReasons)) if (warningCodes.has(code)) return reason;
  return undefined;
}

/** Adapt only known legacy Worker receipts. Unknown data fails before model projection. */
function projectWorkerReceipt(tool: WorkerProjectedTool, result: unknown, args: Record<string, unknown>, toolCallId: string): unknown {
  const receipt = asRecord(result);
  const details = receipt && asRecord(receipt.details);
  if (details?.kind !== undefined) return result;
  if (!receipt || !details) throw new Error(`Unsupported legacy ${tool} receipt.`);
  const postState = asRecord(details.postState);
  const warnings = receiptWarnings(details);
  const warningCodes = new Set(warnings.flatMap((value) => typeof value.code === "string" ? [value.code] : []));
  const message = receiptMessage(receipt, warnings);

  if (tool === "task_read") {
    const taskId = requiredString(args.task_id, "task_id");
    if (postState?.found === false) {
      return assembleCandidateToolResult("task_read", {
        kind: "task_read_batch",
        outcomes: [{ kind: "missing", input_index: 0, task_id: taskId, reason: "task_not_found", state_changed: false }],
      });
    }
    return assembleCandidateToolResult("task_read", {
      kind: "task_read_batch",
      outcomes: [{ kind: "found", input_index: 0, task_id: workerTaskCard(postState).id, task: workerTaskCard(postState) }],
    });
  }

  if (tool === "task_update") {
    const taskId = requiredString(args.task_id, "task_id");
    const operationId = typeof args.operation_id === "string" && args.operation_id.length > 0 ? args.operation_id : toolCallId;
    if (details.outcome === "refused") {
      const reason = reasonFromReceipt(postState, warningCodes,
        ["task_not_found", "version_conflict", "operation_conflict", "terminal_evidence_required"],
        {
          task_not_found: "task_not_found",
          task_version_conflict: "version_conflict",
          task_operation_conflict: "operation_conflict",
          terminal_evidence_required: "terminal_evidence_required",
        });
      if (!reason) throw new Error("Unsupported legacy task_update refusal receipt.");
      const current = postState?.id ? workerTaskCard(postState) : undefined;
      return assembleCandidateToolResult("task_update", {
        kind: "task_update_batch",
        outcomes: [{ kind: "refused", input_index: 0, task_id: current?.id ?? taskId, operation_id: operationId, reason: reason as "task_not_found" | "version_conflict" | "operation_conflict" | "terminal_evidence_required", message, ...(current ? { current_task: current } : {}), state_changed: false }],
      });
    }
    if (details.outcome !== "accepted" && details.outcome !== "partial") throw new Error("Unsupported legacy task_update receipt outcome.");
    const current = workerTaskCard(postState);
    const evidence = asRecord(details.evidence);
    const evidenceEntries = evidence?.journalEntries ?? evidence?.journal_entries;
    const journalEntries = Array.isArray(evidenceEntries) ? evidenceEntries : [];
    const deliveryWarnings = warnings.flatMap((value) => typeof value.message === "string" && value.message.length > 0 ? [value.message] : []);
    return assembleCandidateToolResult("task_update", {
      kind: "task_update_batch",
      outcomes: [{
        kind: "updated",
        input_index: 0,
        task_id: current.id,
        operation_id: operationId,
        task: current,
        journal_entries: journalEntries,
        ...(deliveryWarnings.length > 0 ? { delivery_warnings: deliveryWarnings } : {}),
      }],
    });
  }

  if (details.outcome === "refused") {
    const reason = reasonFromReceipt(postState, warningCodes,
      ["recipient_not_current", "no_eligible_recipients", "invalid_fanout"],
      {
        alert_recipient_not_current: "recipient_not_current",
        alert_no_eligible_recipients: "no_eligible_recipients",
        invalid_alert_fanout: "invalid_fanout",
      });
    if (!reason) throw new Error("Unsupported legacy alert_send refusal receipt.");
    return assembleCandidateToolResult("alert_send", {
      kind: "refused",
      reason: reason as "recipient_not_current" | "no_eligible_recipients" | "invalid_fanout",
      message,
      state_changed: false,
    });
  }
  if (details.outcome !== "accepted" && details.outcome !== "partial") throw new Error("Unsupported legacy alert_send receipt outcome.");
  const evidence = asRecord(details.evidence);
  const failures = Array.isArray(evidence?.failures) ? evidence!.failures : [];
  const accepted = Array.isArray(postState?.recipients)
    ? postState.recipients.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  const failed = failures.flatMap((value) => {
    const failure = asRecord(value);
    return typeof failure?.recipient === "string" && failure.recipient.length > 0 ? [failure.recipient] : [];
  });
  const resource = asRecord(details.resource);
  return assembleCandidateToolResult("alert_send", {
    kind: "alert_sent",
    alert_id: requiredString(resource?.id ?? evidence?.alertId, "alert identifier"),
    accepted_recipients: accepted,
    failed_recipients: failed,
    task_state_changed: false,
  });
}

export default function (pi: ExtensionAPI) {
  registerAutomaticSummaryPolicyProvider(pi);
  // Keep the default agent-facing coordination surface intentionally small.
  // Legacy implementations remain readable for migration and historical
  // delivery recovery, but registration is filtered at this boundary.
  const candidateLeaderTools = new Set([
    "team_create", "ensure_worker", "task_create", "task_read", "task_update", "team_sync",
    "worker_stop", "team_shutdown", "task_link", "alert_send",
  ]);
  const currentWorkerTools = new Set(["task_read", "task_update", "alert_send"]);
  // An envless process is provisionally a leader. Session-start recovery
  // replaces the provisional Alert registration when it proves a Worker
  // Membership, so a lead resumed with PI_TEAM_NAME keeps the new surface.
  const leaderPreviewProcess = !process.env.PI_AGENT_NAME;
  let registeringCandidateLeaderTools = false;
  let allowRecoveredWorkerRegistration = false;
  const registerPublicTool = pi.registerTool.bind(pi);
  (pi as any).registerTool = (tool: { name: string }) => {
    if (leaderPreviewProcess) {
      if (registeringCandidateLeaderTools && candidateLeaderTools.has(tool.name)) registerPublicTool(tool as any);
      else if (allowRecoveredWorkerRegistration && currentWorkerTools.has(tool.name)) {
        registerPublicTool({
          ...tool,
          execute: async (...callArgs: any[]) => projectWorkerReceipt(
            tool.name as WorkerProjectedTool,
            await (tool as any).execute(...callArgs),
            asRecord(callArgs[1]) ?? {},
            requiredString(callArgs[0], "tool call ID"),
          ),
          renderResult: createCandidateToolResultRenderer(tool.name as any),
        } as any);
      }
      return;
    }
    if (currentWorkerTools.has(tool.name)) {
      registerPublicTool({
        ...tool,
        execute: async (...callArgs: any[]) => projectWorkerReceipt(
          tool.name as WorkerProjectedTool,
          await (tool as any).execute(...callArgs),
          asRecord(callArgs[1]) ?? {},
          requiredString(callArgs[0], "tool call ID"),
        ),
        renderResult: createCandidateToolResultRenderer(tool.name as any),
      } as any);
    }
  };
  let isTeammate = !!process.env.PI_AGENT_NAME;
  let agentName = process.env.PI_AGENT_NAME || "team-lead";
  const envTeamName = process.env.PI_TEAM_NAME;
  const envLaunchId = process.env.PI_AGENT_LAUNCH_ID;

  // For leads without PI_TEAM_NAME, check if we're registered as lead for a team
  const detectedTeamName = envTeamName || findLeadTeamForSession();
  let teamName = detectedTeamName;
  let currentMembershipId: string | undefined;

  const terminal = getTerminalAdapter();

  let directMessageDelivery: DirectMessageDelivery | null = null;
  let taskChangeDelivery: TaskChangeDelivery | null = null;
  let directMessageSessionEligible = true;
  let taskChangeSessionEligible = true;
  let footerModel: any;
  let workerResourcePolicy: WorkerResourcePolicy | undefined;
  let workerActiveToolBaseline: string[] | undefined;
  let alertToolRegistration: { description: string; parameters: unknown } | undefined;

  function workerAggregate(cwd: string, ctx: any): { path?: string; projectTrusted: boolean } {
    const resources = resolveWorkerLaunchResources({
      cwd,
      leaderCwd: ctx.cwd ?? process.cwd(),
      leaderProjectTrusted: ctx.isProjectTrusted?.() === true,
    });
    for (const message of resources.policy.diagnostics) ctx.ui?.notify?.(`Pi Team Bright Worker settings: ${message}`, "warning");
    return { path: resources.aggregatePath, projectTrusted: resources.projectTrusted };
  }

  const workerLaunchBridge = createWorkerLaunchBridge({
    buildWorkerArgv: (model, thinking, aggregatePath, projectTrusted) => {
      const argv = buildPiArgv(getPiLaunchArgv(), model, thinking);
      // A Worker must load this exact extension source once. Suppress ambient
      // packages first, or Pi can load a stale global copy beside this one.
      argv.push("-ne", "-e", process.env.PI_TEAM_BRIGHT_SHIPPED_EXTENSION || __filename);
      return buildPiArgv(argv, undefined, undefined, aggregatePath, projectTrusted);
    },
    resolveModel: resolveModelWithProvider,
    workerAggregate: (cwd) => workerAggregate(cwd, { cwd, isProjectTrusted: () => false }),
  });

  let previewLifecycleAdapter: DurablePreviewLifecycle | undefined;
  const previewJourney = leaderPreviewProcess
    ? (() => {
      registeringCandidateLeaderTools = true;
      try {
        const lifecycleProxy: DurablePreviewLifecycle = {
          teamCreated: async (name, sessionFile) => previewLifecycleAdapter?.teamCreated?.(name, sessionFile),
          stopWorker: async (name, worker) => previewLifecycleAdapter
            ? previewLifecycleAdapter.stopWorker(name, worker)
            : { kind: "unavailable", reason: "carrier_unavailable", message: "Preview lifecycle adapter is not ready." },
          shutdownTeam: async (name) => previewLifecycleAdapter
            ? previewLifecycleAdapter.shutdownTeam(name)
            : { kind: "unavailable", reason: "team_authority_unavailable", message: "Preview lifecycle adapter is not ready." },
        };
        return registerModelToolJourney(pi, new DurablePreviewTeamPort(workerLaunchBridge, lifecycleProxy));
      } finally {
        registeringCandidateLeaderTools = false;
      }
    })()
    : undefined;

  function previewBranchIds(ctx: ExtensionContext): string[] {
    return ctx.sessionManager.getBranch().map((entry) => entry.id);
  }

  function previewContainsExact(value: unknown, target: string): boolean {
    if (value === target) return true;
    if (Array.isArray(value)) return value.some((item) => previewContainsExact(item, target));
    if (value && typeof value === "object") return Object.values(value).some((item) => previewContainsExact(item, target));
    return false;
  }

  function previewPersistedToolResult(ctx: ExtensionContext, toolCallId: string, resultText: string): string | undefined {
    const entry = ctx.sessionManager.getBranch().find((candidate) => {
      if (candidate.type !== "message") return false;
      const message = candidate.message;
      return message.role === "toolResult"
        && message.toolCallId === toolCallId
        && message.content.some((part) => part.type === "text" && part.text === resultText);
    });
    return entry?.id;
  }

  if (previewJourney) {
    pi.on("tool_call", (event, ctx) => {
      if (!candidateLeaderTools.has(event.toolName)) return;
      previewJourney.port.setBranchContext(
        exactLeaderSessionId(ctx.sessionManager.getSessionId()),
        previewBranchIds(ctx),
      );
    });
    pi.on("before_provider_request", async (event, ctx) => {
      const sessionId = exactLeaderSessionId(ctx.sessionManager.getSessionId());
      const lineage = previewBranchIds(ctx);
      previewJourney.port.setBranchContext(sessionId, lineage);
      const pending = previewJourney.port.getPendingObservation?.(sessionId);
      if (!pending || !previewContainsExact(event.payload, pending.resultText)) return;
      const entryId = previewPersistedToolResult(ctx, pending.toolCallId, pending.resultText);
      if (!entryId) return;
      if (previewJourney.port.acknowledgePendingObservationAsync) {
        await previewJourney.port.acknowledgePendingObservationAsync(sessionId, entryId, lineage);
      } else {
        previewJourney.port.acknowledgePendingObservation(sessionId, entryId, lineage);
      }
    });
  }

  function configureWorkerResources(ctx: any): void {
    if (!isTeammate) return;
    const cwd = ctx.cwd ?? process.cwd();
    workerResourcePolicy = loadWorkerResourcePolicy({ cwd, projectTrusted: ctx.isProjectTrusted?.() === true });
    // Capture this once, before this extension projects settings. Reload always
    // derives from it so removing settings restores Pi's active-tool baseline.
    workerActiveToolBaseline ??= pi.getActiveTools?.() ?? [];
    const registered = pi.getAllTools?.().map((tool: { name: string }) => tool.name) ?? workerActiveToolBaseline;
    const projected = projectWorkerTools(workerActiveToolBaseline, registered, workerResourcePolicy);
    pi.setActiveTools?.(projected);
    for (const message of workerResourcePolicy.diagnostics) ctx.ui?.notify?.(`Pi Team Bright Worker settings: ${message}`, "warning");
  }

  function alertToolProjection() {
    return {
      description: isTeammate
        ? "Send exceptional clarification or attention to one current Team member. Alerts never assign or complete work; update the Task when durable intent changes."
        : "Send exceptional clarification, attention, or a Team announcement. Alerts never assign or complete work; update the Task when durable intent changes.",
      parameters: Type.Object({
        team_name: Type.String(),
        to: Type.String({ description: isTeammate ? "Current Worker or team-lead name" : "Current Worker name, team-lead, or * for an announcement" }),
        kind: StringEnum(isTeammate ? ["clarification", "attention"] : ["clarification", "attention", "announcement"]),
        text: Type.String(),
        task_id: Type.Optional(Type.String()),
        task_version: Type.Optional(Type.String()),
      }),
    };
  }

  function refreshAlertToolProjection(): void {
    if (!alertToolRegistration) return;
    // Pi 0.82 replaces the same-name registration. This also covers a Worker
    // resumed without launch environment identity.
    Object.assign(alertToolRegistration, alertToolProjection());
    pi.registerTool(alertToolRegistration as any);
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
    task: TaskFile,
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

  function stopDeliveries() {
    directMessageDelivery?.stop();
    directMessageDelivery = null;
    taskChangeDelivery?.stop();
    taskChangeDelivery = null;
  }

  async function assertCurrentSessionBinding(ctx: any, requestedTeam: string): Promise<Member> {
    const sessionFile = ctx?.sessionManager?.getSessionFile?.();
    if (!sessionFile) throw new Error("A durable Pi Session is required for every team-scoped tool operation.");
    const config = await teams.readConfig(requestedTeam);
    if (config.implementationVersion && config.implementationVersion !== MODEL_TOOL_IMPLEMENTATION_VERSION) {
      throw new Error(`Team ${requestedTeam} belongs to implementation ${config.implementationVersion}; this process cannot mutate a mixed-version Team epoch.`);
    }
    return teams.assertCurrentSessionBinding(requestedTeam, agentName, sessionFile);
  }

  /** Mutating Team topology/lifecycle/templates is a coordinator capability. */
  async function assertLeadMutation(ctx: any, operation: string, requestedTeam?: string): Promise<Member | undefined> {
    if (agentName !== "team-lead") {
      throw new Error(`${operation} is lead-only; ask team-lead to perform this Team mutation.`);
    }
    if (!requestedTeam) return undefined;
    const config = await teams.readConfig(requestedTeam);
    if (config.implementationVersion && config.implementationVersion !== MODEL_TOOL_IMPLEMENTATION_VERSION) {
      throw new Error(`${operation} refused: Team ${requestedTeam} belongs to implementation ${config.implementationVersion}; stop the Team and restart one version epoch before mutating it.`);
    }
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
        allowRecoveredWorkerRegistration = true;
        refreshAlertToolProjection();
      }
    }
    // A fresh lead process has no lead environment variables either. Match
    // its resumed Pi session to the durable lead record.
    if (!isTeammate && !teamName) {
      teamName = findLeadTeamForSession(piSessionFile);
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
        const trusted = ctx.isProjectTrusted?.() === true;
        const policy = loadWorkerResourcePolicy({ cwd, projectTrusted: trusted });
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
        ? "Assigned Tasks are your work contracts. Alerts and retained legacy delivery records are delivered in context, but presentation never changes Task state. Set an accepted Task in_progress when work starts. When you finish, call task_update yourself to set it closed and append verification evidence; never leave completion only in a TUI reply. If the work is blocked, call task_update with status blocked, concrete blocker evidence, and the next action. Use alert_send only for exceptional clarification or escalation; an alert never completes or blocks a Task. Re-read Task authority before a conflicting write."
        : "This fork is a new Session identity and receives none of the source Agent's pending Task changes.";
      return {
        systemPrompt: event.systemPrompt + `\n\nYou are Worker '${agentName}' on Team '${teamName}'.\nYour lead is 'team-lead'.${modelInfo}${profileInfo}\n${taskInstruction}`,
      };
    }
    if (previewJourney) {
      return {
        systemPrompt: event.systemPrompt + "\n\nUse the ten-tool release candidate as the Team leader. Create or resume one Team through your exact Session. Reuse Workers by stable semantic scope. Delegate executable work through assigned Tasks. Use a snapshot to establish hidden branch position, then use updates for routine supervision. Use worker_stop and team_shutdown only after exact stop evidence. Use task_link for typed graph changes and alert_send only for exceptional coordination. Task updates require the returned exact version and operation ID; identical retries replay the durable receipt."
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

  if (leaderPreviewProcess) {
    previewLifecycleAdapter = {
      async teamCreated(targetTeamName, sessionFile) {
        isTeammate = false;
        agentName = "team-lead";
        teamName = targetTeamName;
        const config = await teams.readConfig(targetTeamName);
        currentMembershipId = config.members.find((member) => member.name === "team-lead" && member.isActive !== false)?.membershipId;
        await registerLeadSession(targetTeamName, sessionFile, undefined, true, currentMembershipId);
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

  // Tools
  pi.registerTool({
    name: "team_create",
    label: "Create Team",
    description: "Create a new agent team.",
    parameters: Type.Object({
      team_name: Type.String(),
      description: Type.Optional(Type.String()),
      default_model: Type.Optional(Type.String({ description: "Default model for teammates. Omit this parameter to use Pi's configured default model; set it only when the user explicitly requests a specific model." })),
      separate_windows: Type.Optional(Type.Boolean({ default: false, description: "Open teammates in separate OS windows instead of panes" })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      await assertLeadMutation(ctx, "team_create");
      const leadSessionFile = ctx?.sessionManager?.getSessionFile?.();
      if (!leadSessionFile) throw new Error("team_create requires a durable Pi Session file.");
      if (!terminal) throw new Error("No terminal adapter detected.");
      const safeTeamName = paths.sanitizeName(params.team_name);
      return teams.withTeamTopologyLease(safeTeamName, async (topologyLease) => {
      const taskAuthority = await tasks.resolveTeamTaskAuthority(safeTeamName);
      let config: Awaited<ReturnType<typeof teams.createTeam>>;
      try {
        config = await teams.createTeam(
          safeTeamName,
          leadSessionFile,
          "lead-agent",
          params.description,
          params.default_model,
          params.separate_windows,
          taskAuthority.workspace,
          taskAuthority.authorityId,
          taskAuthority.fingerprint,
          topologyLease,
          {
            backend: terminal.name,
            ...(terminal.currentTargetId?.()
              ? { leadTarget: terminalTarget(terminal.name, "pane", terminal.currentTargetId()!) }
              : {}),
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("still has current Memberships")) throw error;
        const current = await teams.readConfig(safeTeamName);
        const members = current.members.filter((member) => member.isActive !== false).map((member) => member.name);
        return {
          content: [{
            type: "text",
            text: `Team ${safeTeamName} not recreated: current members ${members.join(", ")} must be shut down first. No Team identity was replaced.`,
          }],
          details: toolResultDetails({
            outcome: "refused",
            operation: "team_create",
            resource: { kind: "team", id: safeTeamName, teamName: safeTeamName },
            postState: {
              name: safeTeamName,
              changed: false,
              lifecycle: "active",
              taskBackend: current.taskBackend,
              currentMembers: members,
            },
            warnings: [toolResultWarning("team_has_current_members", "Current Team membership prevents implicit recreation.", safeTeamName)],
            nextActions: [{
              tool: "team_shutdown",
              reason: "Shut down the current Team before intentionally recreating it.",
              args: { team_name: safeTeamName },
            }],
          }),
        };
      }
      // Register this session as the lead so it can receive inbox messages.
      await registerLeadSession(safeTeamName, leadSessionFile, undefined, true);
      // Update teamName and start native custom delivery for the lead.
      isTeammate = false;
      agentName = "team-lead";
      teamName = safeTeamName;
      currentMembershipId = config.members.find((member) => member.name === "team-lead" && member.isActive !== false)?.membershipId;
      await startDirectMessageDelivery(ctx);
      await startTaskChangeDelivery(ctx);
      await refreshTeamFooter(ctx);
      return {
        content: [{
          type: "text",
          text: `Team ${safeTeamName} created; Task authority is ready.\nNext: use ensure_worker when another capability is needed, or task_create to create the first work contract.`,
        }],
        details: toolResultDetails({
          operation: "team_create",
          resource: { kind: "team", id: safeTeamName, teamName: safeTeamName },
          postState: {
            name: safeTeamName,
            lifecycle: "active",
            taskAuthorityReady: config.taskBackend === "beads",
            teamDirectory: paths.teamDir(safeTeamName),
            taskWorkspace: config.taskWorkspace,
            beadsDatabase: config.taskAuthorityFingerprint?.doltDatabase,
          },
          nextActions: [
            { tool: "ensure_worker", reason: "Create a stable Worker only when the Team needs another capability.", args: { team_name: safeTeamName } },
            { tool: "task_create", reason: "Create the first durable work contract.", args: { team_name: safeTeamName } },
          ],
          evidence: {
            leadMembershipId: currentMembershipId,
            taskAuthority: {
              backend: config.taskBackend,
              authorityId: config.taskAuthorityId,
            },
            terminalBackend: config.terminalBackend,
          },
        }),
      };
      });
    },
  });

  pi.registerTool({
    name: "ensure_worker",
    label: "Ensure Worker",
    description: "Ensure one stable named Worker exists. Reuse its live carrier, retry an unconsumed prepared launch, or resume the exact bound Session; assign executable work with a Task.",
    parameters: Type.Object({
      team_name: Type.String(),
      name: Type.String(),
      profile: Type.String({ description: "Standing role and capabilities, not a work item" }),
      cwd: Type.String(),
      model: Type.Optional(Type.String({ description: "Model for this teammate. Omit this parameter to use the team or Pi default; set it only when the user explicitly requests a specific model." })),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"])),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const safeName = paths.sanitizeName(params.name);
      const safeTeamName = paths.sanitizeName(params.team_name);

      if (safeName === "team-lead") {
        await assertLeadMutation(ctx, "ensure_worker", safeTeamName);
        const current = await teams.readConfig(safeTeamName);
        return {
          content: [{ type: "text", text: `Worker not created: team-lead is reserved. Choose a distinct Worker name; the current roster is unchanged.` }],
          details: toolResultDetails({
            outcome: "refused",
            operation: "ensure_worker",
            resource: { kind: "worker", id: safeName, teamName: safeTeamName },
            postState: {
              changed: false,
              reason: "reserved_worker_name",
              currentWorkers: current.members.filter((member) => member.agentType === "teammate" && member.isActive !== false).map((member) => member.name),
            },
            warnings: [toolResultWarning("reserved_worker_name", "team-lead is reserved for the Team leader.", safeName)],
            nextActions: [{
              tool: "ensure_worker",
              reason: "Choose a distinct stable Worker name.",
              args: { team_name: safeTeamName },
            }],
          }),
        };
      }

      return teams.withTeamTopologyLease(safeTeamName, async () => {
      // The caller may have become stale while waiting for another topology
      // transaction. Revalidate only after this Team's lease is held.
      await assertLeadMutation(ctx, "ensure_worker", safeTeamName);

      if (!teams.teamExists(safeTeamName)) {
        throw new Error(`Team ${params.team_name} does not exist`);
      }

      const launch = await workerLaunchBridge.ensureWorker({
        teamName: safeTeamName,
        workerName: safeName,
        scope: params.profile,
        cwd: params.cwd,
        model: params.model,
        thinking: params.thinking,
        signal,
        workerAggregate: (cwd) => workerAggregate(cwd, ctx),
      });

      if (launch.action === "reused") {
        return {
          content: [{ type: "text", text: `Reused current Worker ${safeName}; no relaunch occurred. Task state is unchanged; reconcile its current assignment before creating a Task for new work.` }],
          details: toolResultDetails({
            operation: "ensure_worker",
            resource: { kind: "worker", id: safeName, teamName: safeTeamName },
            postState: {
              name: safeName,
              action: "reused",
              membership: "current",
              carrier: launch.member.sessionFile ? "session_bound" : "prepared",
              taskStateChanged: false,
            } satisfies WorkerEnsurePostState,
            nextActions: [{
              tool: "team_sync",
              reason: "Reconcile this Worker's current Task assignment before creating more work.",
              args: { team_name: safeTeamName },
            }],
            evidence: {
              membershipId: launch.membershipId,
              sessionBound: !!launch.member.sessionFile,
              terminal: launch.target,
            },
          }),
        };
      }

      const startup = launch.startup;
      const firstBindingRetry = launch.action === "recovered" && launch.recoveryMode === "first_binding_retry";
      const actionText = launch.action === "created"
        ? startup.observed
          ? `Worker ${safeName} created; its exact Session binding and runtime startup were observed, and no Task is assigned.\nNext: create a Task only when real work exists.`
          : `Worker ${safeName} was launched, but its exact runtime startup wasn't observed within the bounded wait; no Task is assigned.\nNext: use team_sync to observe binding changes; create a Task only when real work exists.`
        : firstBindingRetry
          ? startup.observed
            ? `Recovered prepared Worker ${safeName}; its exact Session binding and runtime startup were observed. Task state is unchanged.`
            : `Recovered prepared Worker ${safeName} by retrying its unconsumed first binding in a new carrier, but runtime startup wasn't observed. Task state is unchanged.`
          : startup.observed
            ? `Recovered Worker ${safeName} by resuming its exact Session; runtime startup was observed. Task state is unchanged.`
            : `Recovered Worker ${safeName} by resuming its exact Session, but runtime startup wasn't observed. Task state is unchanged.`;
      const warning = startup.observed ? [] : [toolResultWarning(
        "runtime_not_observed",
        launch.action === "created"
          ? "Terminal launch succeeded, but this call did not observe the exact Worker runtime startup within the bounded wait."
          : firstBindingRetry
            ? "First-binding relaunch succeeded, but this call did not observe the exact Worker runtime startup within the bounded wait."
            : "Exact-Session relaunch succeeded, but this call did not observe the exact Worker runtime startup within the bounded wait.",
        safeName,
      )];
      const nextActions = launch.action === "created"
        ? startup.observed ? [{ tool: "task_create", reason: "Assign a goal and independently verifiable acceptance criteria.", args: { team_name: safeTeamName, assignee: safeName } }] : [{ tool: "team_sync", reason: "Observe the exact Worker binding before assigning executable work.", args: { team_name: safeTeamName } }]
        : firstBindingRetry
          ? [{ tool: "team_sync", reason: "Reconcile this Worker's binding event and current Task assignment.", args: { team_name: safeTeamName } }]
          : [{ tool: "team_sync", reason: "Reconcile this Worker's current Task assignment and later lifecycle event.", args: { team_name: safeTeamName } }];
      const postState: WorkerEnsurePostState = launch.action === "created"
        ? {
          name: safeName,
          action: "created",
          membership: "current",
          ...launchObservationState(startup),
          terminalLaunched: true,
          assignedTasks: [],
        }
        : {
          name: safeName,
          action: "recovered",
          recoveryMode: launch.recoveryMode,
          membership: "current",
          ...launchObservationState(startup),
          terminalLaunched: true,
          taskStateChanged: false,
        };
      const evidence = launch.action === "created"
        ? {
          membershipId: launch.membershipId,
          agentId: launch.member.agentId,
          terminalLaunch: {
            adapter: launch.target.backend,
            kind: launch.target.isWindow ? "window" : "pane",
            targetId: launch.target.terminalId,
          },
        }
        : {
          membershipId: launch.membershipId,
          sessionBound: !!launch.member.sessionFile,
          terminalLaunch: {
            adapter: launch.target.backend,
            kind: launch.target.isWindow ? "window" : "pane",
            targetId: launch.target.terminalId,
          },
        };
      return {
        content: [{ type: "text", text: actionText }],
        details: toolResultDetails({
          operation: "ensure_worker",
          resource: { kind: "worker", id: safeName, teamName: safeTeamName },
          postState,
          warnings: warning,
          nextActions,
          evidence,
        }),
      };
      });
    },
  });

  pi.registerTool({
    name: "send_message",
    label: "Send Message",
    description: "Send substantive coordination to a teammate. Avoid ACK-only messages unless semantic confirmation is required.",
    parameters: Type.Object({
      team_name: Type.String(),
      recipient: Type.String(),
      content: Type.String(),
      summary: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const actorMembership = await assertCurrentSessionBinding(ctx, params.team_name);
      let message;
      try {
        message = await messaging.sendPlainMessage(params.team_name, agentName, params.recipient, params.content, params.summary, undefined, actorMembership.membershipId && actorMembership.sessionFile ? {
          membershipId: actorMembership.membershipId,
          sessionFile: actorMembership.sessionFile,
        } : undefined);
      } catch (error) {
        if (error instanceof messaging.MessageTeamDoesNotExistError) {
          throw new Error(`Cannot send message: Team '${params.team_name}' does not exist. Create or select an existing team first.`);
        }
        if (error instanceof messaging.RecipientNotCurrentMemberError) {
          throw new Error(
            `Cannot send message: recipient '${params.recipient}' is not a current member of team '${params.team_name}'. ` +
            "Contact or escalate to the team leader 'team-lead' to resolve the intended recipient.",
          );
        }
        throw error;
      }
      return {
        content: [{ type: "text", text: JSON.stringify({
          status: "accepted",
          recipient: params.recipient,
          messageId: message.id,
        }) }],
        details: { messageId: message.id },
      };
    },
  });

  pi.registerTool({
    name: "broadcast_message",
    label: "Broadcast Message",
    description: "Broadcast substantive coordination to current team members except the sender.",
    parameters: Type.Object({
      team_name: Type.String(),
      content: Type.String(),
      summary: Type.String(),
      color: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const actorMembership = await assertCurrentSessionBinding(ctx, params.team_name);
      const result = await messaging.broadcastMessage(params.team_name, agentName, params.content, params.summary, params.color, actorMembership.membershipId && actorMembership.sessionFile ? {
        membershipId: actorMembership.membershipId,
        sessionFile: actorMembership.sessionFile,
      } : undefined);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "read_inbox",
    label: "Read Inbox",
    description: "Explicitly audit or inspect Message history. Never use this tool to fetch normal delivery; accepted Messages arrive as native custom context.",
    parameters: Type.Object({
      team_name: Type.String(),
      agent_name: Type.Optional(Type.String({ description: "Whose inbox to read. Defaults to your own." })),
      unread_only: Type.Optional(Type.Boolean({ default: true })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const actorMembership = await assertCurrentSessionBinding(ctx, params.team_name);
      const targetAgent = params.agent_name || agentName;
      const readingOwnInbox = targetAgent === agentName;
      const msgs = readingOwnInbox && actorMembership?.membershipId
        ? await messaging.readInboxForMembership(
            params.team_name,
            targetAgent,
            actorMembership.membershipId,
            params.unread_only,
            true,
          )
        : await messaging.readInbox(params.team_name, targetAgent, params.unread_only, false);

      if (isTeammate && teamName && params.team_name === teamName && targetAgent === agentName) {
        await writeCurrentTeammateRuntime(ctx, {
          lastHeartbeatAt: Date.now(),
          lastInboxReadAt: Date.now(),
          ready: true,
          lastError: undefined,
        });
      }

      return {
        content: [{ type: "text", text: JSON.stringify(msgs, null, 2) }],
        details: { messages: msgs },
      };
    },
  });

  pi.registerTool({
    name: "team_sync",
    label: "Sync Team",
    description: "Read the current compact Team projection or block on the next matching Task, Worker, or Alert event. This replaces polling and inbox reads.",
    parameters: Type.Object({
      team_name: Type.String(),
      cursor: Type.Optional(Type.String()),
      wait_ms: Type.Optional(Type.Number({ minimum: 0, maximum: 300000 })),
      task_ids: Type.Optional(Type.Array(Type.String(), { maxItems: teamEvents.MAX_TEAM_SYNC_LIMIT })),
      event_types: Type.Optional(Type.Array(StringEnum(["task", "worker", "alert"]))),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: teamEvents.MAX_TEAM_SYNC_LIMIT, description: "Maximum events per incremental page and Worker/Task records per projection page." })),
      continuation: Type.Optional(Type.String({ description: "Opaque continuation returned for a truncated projection page. Omit cursor when using it." })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      await assertCurrentSessionBinding(ctx, params.team_name);
      if (params.cursor !== undefined && !/^(0|[1-9][0-9]*)$/.test(params.cursor)) {
        return {
          content: [{
            type: "text",
            text: `Team sync not started: cursor ${JSON.stringify(params.cursor)} is invalid. Cursors must be monotonic decimal strings. No Team or Task state changed; retry with your last valid returned cursor, or request a fresh snapshot if it is unavailable.`,
          }],
          details: toolResultDetails({
            outcome: "refused",
            operation: "team_sync",
            resource: { kind: "team", id: params.team_name, teamName: params.team_name },
            postState: { changed: false, waited: false, reason: "invalid_cursor" },
            warnings: [toolResultWarning("invalid_event_cursor", "A cursor must be zero or a positive base-10 integer.", params.cursor)],
            nextActions: [{
              tool: "team_sync",
              reason: "Reuse the last valid monotonic decimal cursor returned by team_sync; request a fresh snapshot only if it is unavailable.",
            }],
            evidence: { requestedCursor: params.cursor, eventJournalRead: false },
          }),
        };
      }
      if (params.continuation !== undefined && params.cursor !== undefined) {
        return {
          content: [{ type: "text", text: "Team sync not started: continuation and cursor are mutually exclusive. Echo the continuation alone to read the next projection page, or use cursor alone to read later events." }],
          details: toolResultDetails({
            outcome: "refused",
            operation: "team_sync",
            resource: { kind: "team", id: params.team_name, teamName: params.team_name },
            postState: { changed: false, waited: false, reason: "ambiguous_continuation" },
            warnings: [toolResultWarning("ambiguous_sync_position", "continuation and cursor cannot be combined.")],
            nextActions: [{ tool: "team_sync", reason: "Echo exactly one returned continuation coordinate." }],
          }),
        };
      }
      let eventResult: teamEvents.TeamEventWaitResult;
      try {
        eventResult = await teamEvents.syncTeamEvents({
          teamName: params.team_name,
          cursor: params.continuation === undefined ? params.cursor : undefined,
          waitMs: params.continuation === undefined ? (params.wait_ms ?? 0) : 0,
          eventTypes: params.event_types,
          taskIds: params.task_ids,
          limit: params.limit,
          signal,
        });
      } catch (error) {
        if (!(error instanceof teamEvents.TeamEventCursorAheadError)) throw error;
        return {
          content: [{
            type: "text",
            text: `Team sync refused cursor ${error.requestedCursor}: the actual current journal head is ${error.headCursor}. Team, Worker, Task, and event state are unchanged; no events were consumed or lost, and no lower cursor was returned as successful progress. Request a fresh snapshot to establish a new coordinate.`,
          }],
          details: toolResultDetails({
            outcome: "refused",
            operation: "team_sync",
            resource: { kind: "team", id: params.team_name, teamName: params.team_name },
            postState: {
              changed: false,
              waited: false,
              reason: "cursor_ahead_of_journal",
              requestedCursor: error.requestedCursor,
              journalHeadCursor: error.headCursor,
              cursorCorrectionRequired: true,
            },
            warnings: [toolResultWarning("event_cursor_ahead", "The supplied cursor is ahead of the current Team event journal head.", error.requestedCursor)],
            nextActions: [{
              tool: "team_sync",
              reason: "Request a fresh snapshot without a cursor; do not treat the lower journal head as continuation success.",
              args: { team_name: params.team_name, limit: params.limit ?? teamEvents.DEFAULT_TEAM_SYNC_LIMIT },
            }],
            evidence: { requestedCursor: error.requestedCursor, journalHeadCursor: error.headCursor },
          }),
        };
      }
      const [config, taskList] = await Promise.all([
        teams.readConfig(params.team_name),
        tasks.listTasks(params.team_name),
      ]);
      const baseProjection = teamEvents.projectTeamCurrentState(config, taskList);
      let projectionPage: teamEvents.TeamProjectionPage;
      try {
        projectionPage = teamEvents.pageTeamCurrentProjection(baseProjection, {
          headCursor: eventResult.headCursor,
          limit: params.limit,
          continuation: params.continuation,
        });
      } catch (error) {
        if (!(error instanceof teamEvents.InvalidTeamSnapshotContinuationError)) throw error;
        return {
          content: [{ type: "text", text: `${error.message} No Team or Task state changed.` }],
          details: toolResultDetails({
            outcome: "refused",
            operation: "team_sync",
            resource: { kind: "team", id: config.name, teamName: config.name },
            postState: { changed: false, waited: false, reason: "invalid_or_stale_snapshot_continuation", journalHeadCursor: eventResult.headCursor },
            warnings: [toolResultWarning("invalid_snapshot_continuation", error.message, params.continuation)],
            nextActions: [{
              tool: "team_sync",
              reason: "Request a fresh bounded snapshot without a continuation.",
              args: { team_name: config.name, limit: params.limit ?? teamEvents.DEFAULT_TEAM_SYNC_LIMIT },
            }],
          }),
        };
      }
      const hydrationIds = [
        ...(params.task_ids ?? []),
        ...(params.cursor === undefined ? projectionPage.projection.tasks.map((task) => task.id) : []),
      ];
      const hydratedTasks = await teamEvents.hydrateTeamSyncTasks(
        eventResult.events,
        hydrationIds,
        (taskIds) => tasks.readTasks(params.team_name, taskIds),
      );
      const taskById = new Map(hydratedTasks.map((task) => [task.id, task]));
      const projection = {
        ...projectionPage.projection,
        tasks: projectionPage.projection.tasks.map((task) => {
          const authoritative = taskById.get(task.id);
          return authoritative ? { ...task, version: authoritative.version } : task;
        }),
      };
      const normalizedHydratedTasks = hydratedTasks.map((task) => ({
        ...task,
        assignee: task.assignee ?? null,
        design: task.design ?? null,
        notes: task.notes ?? null,
      }));
      const taskEventGroups = new Map<string, Array<{ change: string; actor: string }>>();
      const workerEventGroups = new Map<string, { event: Extract<(typeof eventResult.events)[number], { type: "worker" }>; count: number }>();
      const alertEventGroups = new Map<string, { event: Extract<(typeof eventResult.events)[number], { type: "alert" }>; count: number }>();
      for (const event of eventResult.events) {
        if (event.type === "task") {
          const group = taskEventGroups.get(event.ref.taskId) ?? [];
          group.push({ change: event.change, actor: event.actor });
          taskEventGroups.set(event.ref.taskId, group);
        } else if (event.type === "worker") {
          const key = `${event.worker}\0${event.phase}`;
          const group = workerEventGroups.get(key);
          workerEventGroups.set(key, { event, count: (group?.count ?? 0) + 1 });
        } else {
          const key = `${event.from}\0${event.to}\0${event.kind}\0${event.taskRef?.taskId ?? ""}\0${event.taskRef?.version ?? ""}`;
          const group = alertEventGroups.get(key);
          alertEventGroups.set(key, { event, count: (group?.count ?? 0) + 1 });
        }
      }
      const eventSummary = [...taskEventGroups.entries()].map(([taskId, changes]) => {
        const current = taskById.get(taskId);
        const relations = current?.relations.length
          ? `, relations ${current.relations.map((relation) => `${relation.relation} ${relation.targetId}`).join(", ")}`
          : "";
        const blocker = current?.status === "blocked" && current.notes
          ? ` Blocker: ${current.notes}`
          : "";
        const state = current
          ? `${current.status}${current.assignee ? `, assigned to ${current.assignee}` : ", unassigned"}, version ${current.version}${relations}.${blocker}`
          : "current state unavailable";
        const semanticChanges = [...new Set(changes.map((change) => `${change.change} by ${change.actor}`))];
        const requested = params.task_ids?.includes(taskId) ? "Requested Task" : "Task";
        const taskLabel = `${requested} ${taskId}${current ? ` “${current.title}”` : ""}`;
        const observation = semanticChanges.length === 1
          ? `Observed ${changes[0].change} event for ${taskLabel} by ${changes[0].actor}`
          : `Observed events for ${taskLabel} (${semanticChanges.join("; ")})`;
        return `${observation}; authoritative current state: ${state}${current?.status === "blocked" ? " Resolve the blocker before continuing." : ""}`;
      });
      for (const { event, count } of workerEventGroups.values()) {
        eventSummary.push(`Worker ${event.worker} ${event.phase}${count > 1 ? ` ×${count}` : ""}.`);
      }
      for (const { event, count } of alertEventGroups.values()) {
        eventSummary.push(
          `${event.kind} Alert from ${event.from} to ${event.to}${event.taskRef ? ` for Task ${event.taskRef.taskId}` : ""}`
          + `${count > 1 ? ` repeated ${count} times` : ""}.`,
        );
      }
      if (eventResult.events.length > 0) {
        const idle = projection.workers.filter((worker) => worker.carrier !== "absent" && worker.nonterminalTasks.length === 0);
        if (idle.length > 0) eventSummary.push(`Idle Workers with no nonterminal assigned Tasks: ${idle.map((worker) => worker.name).join(", ")}.`);
      }
      const workerSummary = projection.workers.length === 0
        ? "Workers: none."
        : `Workers: ${projection.workers.map(worker => `${worker.name} (${worker.carrier}; ${worker.nonterminalTasks.length} nonterminal Tasks)`).join(", ")}.`;
      const taskSummary = projection.tasks.length === 0
        ? "Tasks: none."
        : `Tasks: ${projection.tasks.map(task => `${task.id} “${task.title}” ${task.status}${task.assignee ? `, assigned to ${task.assignee}` : ", unassigned"}, version ${task.version}`).join("; ")}.`;
      const completion = params.cursor === undefined ? "snapshot" : eventResult.timedOut ? "timeout" : "events";
      const projectionText = completion === "snapshot" ? [workerSummary, taskSummary] : [];
      const lifecycleNextActions = selectTeamSyncNextActions({
        teamName: config.name,
        cursor: eventResult.cursor,
        completion,
        projection,
        hydratedTasks,
      });
      const paginationNextActions = [
        ...(eventResult.truncated ? [{
          tool: "team_sync",
          reason: `Continue unread events from cursor ${eventResult.cursor} before waiting at journal head ${eventResult.headCursor}.`,
          args: { team_name: config.name, cursor: eventResult.cursor, limit: params.limit ?? teamEvents.DEFAULT_TEAM_SYNC_LIMIT },
        }] : []),
        ...(projectionPage.continuation ? [{
          tool: "team_sync",
          reason: `Continue the bounded current projection (${projectionPage.offset + projection.workers.length + projection.tasks.length} of ${projectionPage.totalItems} records returned).`,
          args: { team_name: config.name, continuation: projectionPage.continuation, limit: params.limit ?? teamEvents.DEFAULT_TEAM_SYNC_LIMIT },
        }] : []),
      ];
      const nextActions = [
        ...paginationNextActions,
        ...lifecycleNextActions.filter((action) => !(paginationNextActions.length > 0 && action.tool === "team_sync")),
      ];
      const lifecycleGuidance = summarizeTeamSyncNextActions(lifecycleNextActions);
      return {
        content: [{
          type: "text",
          text: [
            `Team ${config.name} ${completion} at cursor ${eventResult.cursor}.`,
            ...(eventResult.truncated
              ? [`Event page truncated at ${eventResult.events.length} records with exactly ${eventResult.remaining} matching event${eventResult.remaining === 1 ? "" : "s"} remaining; journal head is ${eventResult.headCursor}. Continue from cursor ${eventResult.cursor} before waiting.`]
              : []),
            ...(projectionPage.continuation
              ? [`Projection page truncated after ${projectionPage.offset + projection.workers.length + projection.tasks.length} of ${projectionPage.totalItems} Worker/Task records; echo the returned continuation.`]
              : []),
            ...(eventSummary.length > 0
              ? eventSummary
              : eventResult.events.length > 0
                ? []
                : [eventResult.timedOut ? "No matching changes before timeout; timeout is not evidence of Worker or runtime failure and changed no state." : "No new events."]),
            ...projectionText,
            ...(lifecycleGuidance ? [lifecycleGuidance] : []),
          ].join("\n"),
        }],
        details: toolResultDetails({
          operation: "team_sync",
          resource: { kind: "team", id: config.name, teamName: config.name },
          postState: {
            completion,
            cursor: eventResult.cursor,
            journalHeadCursor: eventResult.headCursor,
            projection,
            hydratedTasks: normalizedHydratedTasks,
            pagination: {
              events: {
                limit: params.limit ?? teamEvents.DEFAULT_TEAM_SYNC_LIMIT,
                returned: eventResult.events.length,
                truncated: eventResult.truncated,
                remaining: eventResult.remaining,
                continuationCursor: eventResult.truncated ? eventResult.cursor : null,
              },
              projection: {
                limit: projectionPage.limit,
                offset: projectionPage.offset,
                returned: projection.workers.length + projection.tasks.length,
                totalItems: projectionPage.totalItems,
                truncated: projectionPage.truncated,
                continuation: projectionPage.continuation ?? null,
              },
            },
          },
          nextActions,
          evidence: {
            events: eventResult.events,
            wait: {
              requestedCursor: params.cursor ?? null,
              waitMs: params.wait_ms ?? 0,
              taskIds: params.task_ids ?? [],
              eventTypes: params.event_types ?? [],
              timedOut: eventResult.timedOut,
              journalHeadCursor: eventResult.headCursor,
              eventPageTruncated: eventResult.truncated,
              remainingMatchingEvents: eventResult.remaining,
            },
          },
        }),
      };
    },
  });

  function registerAlertTool(): void {
    const projection = alertToolProjection();
    const registration = {
    name: "alert_send",
    label: "Send Alert",
    // This process-specific TypeBox projection limits Worker model calls. The
    // alerts service remains the authority and rejects forged announcements.
    ...projection,
    async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
      const actor = await assertCurrentSessionBinding(ctx, params.team_name);
      if (params.to === "*" && params.kind !== "announcement") {
        return {
          content: [{
            type: "text",
            text: `${params.kind} Alert rejected: whole-Team fan-out requires kind announcement. No Alert, delivery, event, or Task change was created; change the kind or choose one current recipient.`,
          }],
          details: toolResultDetails({
            outcome: "refused",
            operation: "alert_send",
            postState: {
              attemptedKind: params.kind,
              attemptedRecipient: params.to,
              accepted: false,
              alertCreated: false,
              deliveryCreated: false,
              eventCreated: false,
              taskStateChanged: false,
              reason: "whole_team_requires_announcement",
            },
            warnings: [toolResultWarning("invalid_alert_fanout", "Only announcement Alerts may target the whole Team.", "*")],
            nextActions: [{
              tool: "alert_send",
              reason: "Use kind announcement for whole-Team fan-out, or address one current member.",
              args: { team_name: params.team_name },
            }],
            evidence: { deliveryAttempts: 0, eventAppended: false },
          }),
        };
      }
      let result: Awaited<ReturnType<typeof alerts.sendAlert>>;
      try {
        result = await alerts.sendAlert({
          teamName: params.team_name,
          from: agentName,
          to: params.to,
          kind: params.kind,
          text: params.text,
          taskId: params.task_id,
          taskVersion: params.task_version,
          expectedSender: actor.membershipId && actor.sessionFile
            ? { membershipId: actor.membershipId, sessionFile: actor.sessionFile }
            : undefined,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.startsWith("Recipient '") && !message.includes("was not accepted by any current Team member")) throw error;
        const current = await teams.readConfig(params.team_name);
        const currentWorkers = current.members
          .filter((member) => member.agentType === "teammate" && member.isActive !== false)
          .map((member) => member.name);
        const noEligibleBroadcastRecipients = params.to === "*"
          && message.includes("was not accepted by any current Team member");
        return {
          content: [{
            type: "text",
            text: noEligibleBroadcastRecipients
              ? `${params.kind} Alert wasn't sent: zero eligible Worker recipients, so nothing was delivered. Reconcile the roster with team_sync before deciding whether to retry.`
              : `${params.kind} Alert not sent to ${params.to}: the recipient isn't a current Team member. Reconcile the current roster with team_sync before retrying.`,
          }],
          details: toolResultDetails({
            outcome: "refused",
            operation: "alert_send",
            postState: {
              attemptedKind: params.kind,
              attemptedRecipient: params.to,
              from: agentName,
              accepted: false,
              alertCreated: false,
              deliveryCreated: false,
              eventCreated: false,
              taskStateChanged: false,
              teamStateChanged: false,
              reason: noEligibleBroadcastRecipients ? "no_eligible_recipients" : "recipient_not_current",
              team: {
                name: params.team_name,
                lifecycle: current.members.some((member) => member.isActive !== false) ? "active" : "stopped",
                taskBackend: current.taskBackend,
              },
              currentWorkers,
              ...(params.task_id ? { taskRef: { taskId: params.task_id, ...(params.task_version ? { version: params.task_version } : {}) } } : {}),
            },
            warnings: [toolResultWarning(
              noEligibleBroadcastRecipients ? "alert_no_eligible_recipients" : "alert_recipient_not_current",
              noEligibleBroadcastRecipients
                ? "No other current Team member accepted the announcement."
                : message,
              noEligibleBroadcastRecipients ? undefined : params.to,
            )],
            nextActions: noEligibleBroadcastRecipients
              ? [{
                  tool: "team_sync",
                  reason: "Reconcile the current roster before deciding whether this announcement is still needed.",
                  args: { team_name: params.team_name },
                }, {
                  tool: "ensure_worker",
                  reason: "Only if actual work requires a Worker, ensure one stable Worker before retrying the still-needed announcement.",
                  args: { team_name: params.team_name },
                }]
              : [{
                  tool: "team_sync",
                  reason: "Read current Workers before retrying exceptional coordination.",
                  args: { team_name: params.team_name },
                }],
            evidence: {
              eligibleRecipients: noEligibleBroadcastRecipients ? 0 : currentWorkers.length,
              deliveryAttempts: 0,
              acceptedDeliveries: 0,
              eventAppended: false,
              alertEventCursor: null,
              taskStateChanged: false,
              teamStateChanged: false,
            },
          }),
        };
      }
      const outcome = result.failures.length > 0 ? "partial" : "accepted";
      const recipients = result.accepted.map((delivery) => delivery.recipient);
      const taskRef = params.task_id
        ? { taskId: params.task_id, ...(params.task_version ? { version: params.task_version } : {}) }
        : undefined;
      const failureText = result.failures.length > 0
        ? ` Delivery wasn't accepted for ${result.failures.map((failure) => failure.recipient).join(", ")}.`
        : " No recipients failed.";
      return {
        content: [{
          type: "text",
          text: `${params.kind} Alert ${outcome === "partial" ? "partially accepted" : "accepted"} by ${recipients.join(", ")}${taskRef ? ` for Task ${taskRef.taskId}` : ""}. No Task state changed.${failureText}`,
        }],
        details: toolResultDetails({
          outcome,
          operation: "alert_send",
          resource: { kind: "alert", id: result.alertId, teamName: params.team_name },
          postState: {
            kind: params.kind,
            from: agentName,
            to: params.to,
            recipients,
            ...(taskRef ? { taskRef } : {}),
            taskStateChanged: false,
          },
          warnings: result.failures.map((failure) => toolResultWarning(
            "alert_delivery_failed",
            "Alert delivery wasn't accepted by this recipient.",
            failure.recipient,
          )),
          evidence: {
            alertId: result.alertId,
            cursor: result.cursor,
            alertText: params.text,
            deliveries: result.accepted,
            failures: result.failures,
          },
        }),
      };
    },
  };
    alertToolRegistration = registration;
    pi.registerTool(registration as any);
  }
  registerAlertTool();

  pi.registerTool({
    name: "task_create",
    label: "Create Task",
    description: "Create a Team Task. Its mutation receipt contains authoritative post-state; wait through team_sync for later changes.",
    parameters: Type.Object({
      team_name: Type.String(),
      title: Type.String(),
      description: Type.String(),
      acceptance_criteria: Type.Optional(Type.String({ description: "Required when the Task is assigned; independently verifiable success criteria" })),
      design: Type.Optional(Type.String()),
      assignee: Type.Optional(Type.String()),
      idempotency_key: Type.Optional(Type.String()),
    }) as any,
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const actorMembership = await assertCurrentSessionBinding(ctx, params.team_name);
      const actingSessionFile = ctx?.sessionManager?.getSessionFile?.();
      let result: Awaited<ReturnType<typeof tasks.createTask>>;
      try {
        result = await tasks.createTask(params.team_name, {
          title: params.title,
          description: params.description,
          acceptanceCriteria: params.acceptance_criteria,
          design: params.design,
          assignee: params.assignee,
          idempotencyKey: params.idempotency_key,
        }, actorMembership.membershipId && actingSessionFile
          ? { actor: agentName, actingMembershipId: actorMembership.membershipId, actingSessionFile }
          : undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== "Assigned Tasks require nonempty acceptance criteria") throw error;
        return {
          content: [{
            type: "text",
            text: `Task not created: assigned work requires nonempty, independently verifiable acceptance criteria. Add them and retry; Team Task state is unchanged.`,
          }],
          details: toolResultDetails({
            outcome: "refused",
            operation: "task_create",
            postState: { created: false, taskStateChanged: false, reason: "acceptance_criteria_required" },
            warnings: [toolResultWarning("acceptance_criteria_required", message, params.assignee)],
            nextActions: [{
              tool: "task_create",
              reason: "Add independently verifiable acceptance criteria before retrying Task creation.",
              args: {
                team_name: params.team_name,
                title: params.title,
                assignee: params.assignee,
              },
            }],
          }),
        };
      }
      const task = result.task;
      const publicWarnings = result.deliveryWarnings.map((message) => {
        const committedPrefix = `Task ${task.id} committed but `;
        return message.startsWith(committedPrefix)
          ? `Task authority committed, but ${message.slice(committedPrefix.length)}`
          : message;
      });
      const owner = task.assignee ? `assigned to ${task.assignee}` : "unassigned";
      const degradedAreas = [
        result.publication.teamEvent.appended ? undefined : "Team-event publication",
        result.publication.delivery.failedRecipients.length > 0 ? "Worker delivery" : undefined,
      ].filter((area): area is string => !!area);
      const agentText = result.deliveryDegraded
        ? `Created Task ${task.id} “${task.title}”: ${task.status}, ${owner}. Task authority committed, but ${degradedAreas.join(" and ") || "post-commit publication"} degraded. Do not recreate this Task; investigate delivery recovery with team_sync.`
        : `Created Task ${task.id} “${task.title}”: ${task.status}${task.assignee ? `, assigned to ${task.assignee}` : ""}, version ${task.version}.`;
      return {
        content: [{
          type: "text",
          text: agentText,
        }],
        details: toolResultDetails({
          outcome: result.deliveryDegraded ? "partial" : "accepted",
          operation: "task_create",
          resource: { kind: "task", id: task.id, teamName: params.team_name },
          postState: { ...task, assignee: task.assignee ?? null, design: task.design ?? null, notes: task.notes ?? null },
          warnings: publicWarnings.map((message) => toolResultWarning(
            "task_delivery_degraded",
            message,
            task.id,
          )),
          nextActions: result.deliveryDegraded
            ? [{
                tool: "team_sync",
                reason: `Reconcile committed Task ${task.id} and its delivery recovery; do not recreate the Task.`,
                args: { team_name: params.team_name, task_ids: [task.id] },
              }]
            : [],
          evidence: {
            changed: result.changed,
            appliedOperations: result.appliedOperations,
            deliveryDegraded: result.deliveryDegraded,
            teamEvent: result.publication.teamEvent,
            delivery: result.publication.delivery,
          },
        }),
      };
    },
  });

  pi.registerTool({
    name: "task_list",
    label: "List Tasks",
    description: "Query the current compact Task projection on demand, not as follow-up to a mutation receipt.",
    parameters: Type.Object({
      team_name: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      await assertCurrentSessionBinding(ctx, params.team_name);
      const taskList = await tasks.listTasks(params.team_name);
      return {
        content: [{ type: "text", text: JSON.stringify(taskList, null, 2) }],
        details: { tasks: taskList },
      };
    },
  });

  pi.registerTool({
    name: "task_update",
    label: "Update Task",
    description: "Apply one semantic Task mutation. Its receipt contains authoritative post-state; wait through team_sync for later changes.",
    parameters: Type.Object({
      team_name: Type.String(),
      task_id: Type.String(),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      acceptance_criteria: Type.Optional(Type.String()),
      design: Type.Optional(Type.String()),
      status: Type.Optional(StringEnum(["open", "in_progress", "blocked", "closed"])),
      assignee: Type.Optional(Type.String()),
      claim: Type.Optional(Type.Boolean({ default: false, description: "Atomically claim the task for the current agent" })),
      append_note: Type.Optional(Type.String({ description: "Append prose to the Task's native Beads notes" })),
      expected_version: Type.Optional(Type.String({ description: "Optimistic concurrency token from task_read" })),
    }) as any,
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const actingSessionFile = ctx?.sessionManager?.getSessionFile?.();
      const actorMembership = await assertCurrentSessionBinding(ctx, params.team_name);
      const requestedMutation = {
        ...(params.title !== undefined ? { title: params.title } : {}),
        ...(params.description !== undefined ? { description: params.description } : {}),
        ...(params.acceptance_criteria !== undefined ? { acceptanceCriteria: params.acceptance_criteria } : {}),
        ...(params.design !== undefined ? { design: params.design } : {}),
        ...(params.status !== undefined ? { status: params.status } : {}),
        ...(params.assignee !== undefined ? { assignee: params.assignee } : {}),
        ...(params.claim !== undefined ? { claim: params.claim } : {}),
        ...(params.append_note !== undefined ? { appendNote: params.append_note } : {}),
      };
      let result: Awaited<ReturnType<typeof tasks.applySemanticTaskUpdate>>;
      let candidateTaskMetadata: CandidateTaskMetadata | undefined;
      let taskEventEvidence: Array<{ kind: "progress" | "status"; text: string }> | undefined;
      if (
        process.env[MODEL_TOOL_PREVIEW_WORKER_MARKER] === "1"
        && (params.append_note !== undefined || params.status !== undefined)
      ) {
        try {
          const record = await tasks.readCandidateTaskAuthorityRecord(params.team_name, params.task_id);
          const parsed = parseCandidateTaskMetadata(record);
          if (!("kind" in parsed)) {
            candidateTaskMetadata = refreshCandidateTaskMetadata(
              parsed,
              params.append_note ?? parsed.current_context,
            );
            taskEventEvidence = [
              ...(params.append_note !== undefined ? [{ kind: "progress" as const, text: params.append_note }] : []),
              ...(params.status !== undefined ? [{ kind: "status" as const, text: `Worker set Task status to ${params.status}.` }] : []),
            ];
          }
        } catch {
          // Legacy or unreadable Tasks keep the shipped mutation behavior.
        }
      }
      try {
        result = await tasks.applySemanticTaskUpdate(
          params.team_name,
          params.task_id,
          requestedMutation,
          {
            actor: agentName,
            expectedVersion: params.expected_version,
            actingSessionFile,
            actingMembershipId: actorMembership.membershipId,
            ...(candidateTaskMetadata ? { candidateTaskMetadata, taskEventEvidence } : {}),
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isConflict = error instanceof BeadsError && error.kind === "conflict";
        const isEvidenceGuard = message.startsWith("Transitioning a Task to ") && message.includes("requires a nonempty evidence note");
        if (!isConflict && !isEvidenceGuard) throw error;
        const current = await tasks.readTask(params.team_name, params.task_id);
        const code = isConflict ? "task_version_conflict" : "terminal_evidence_required";
        const recovery = isConflict
          ? "Use the current version to review and retry the intended mutation."
          : `Append verification or blocker evidence in the same update that sets ${params.status}.`;
        return {
          content: [{
            type: "text",
            text: isConflict
              ? `Task ${current.id} not updated: expected version is stale. Re-read the Task, review its current ${current.status} state, then retry with version ${current.version}.`
              : `Task ${current.id} not updated: changing it to ${params.status} requires a nonempty evidence note in the same call. Current version remains ${current.version}.`,
          }],
          details: toolResultDetails({
            outcome: "refused",
            operation: "task_update",
            resource: { kind: "task", id: current.id, teamName: params.team_name },
            postState: { ...current, assignee: current.assignee ?? null, design: current.design ?? null, notes: current.notes ?? null },
            warnings: [toolResultWarning(
              code,
              isConflict
                ? "The expected Task version is stale; no Task state changed."
                : `A nonempty evidence note is required to set this Task to ${params.status}; no Task state changed.`,
              current.id,
            )],
            nextActions: [{
              tool: isConflict ? "task_read" : "task_update",
              reason: recovery,
              args: isConflict
                ? { team_name: params.team_name, task_id: current.id }
                : { team_name: params.team_name, task_id: current.id, expected_version: current.version },
            }],
            evidence: {
              requestedVersion: params.expected_version,
              currentVersion: current.version,
              requestedMutation,
              changed: false,
            },
          }),
        };
      }
      return {
        content: [{
          type: "text",
          text: taskMutationContent(result.task, result.appliedOperations, result.deliveryWarnings),
        }],
        details: toolResultDetails({
          outcome: result.deliveryDegraded ? "partial" : "accepted",
          operation: "task_update",
          resource: { kind: "task", id: result.task.id, teamName: params.team_name },
          postState: { ...result.task, assignee: result.task.assignee ?? null, design: result.task.design ?? null, notes: result.task.notes ?? null },
          warnings: result.deliveryWarnings.map((message) => toolResultWarning(
            "task_delivery_degraded",
            message,
            result.task.id,
          )),
          nextActions: [],
          evidence: {
            before: {
              ...result.before,
              assignee: result.before.assignee ?? null,
              design: result.before.design ?? null,
              notes: result.before.notes ?? null,
            },
            appliedOperations: result.appliedOperations,
            deliveryDegraded: result.deliveryDegraded,
          },
        }),
      };
    },
  });

  pi.registerTool({
    name: "task_link",
    label: "Link Task",
    description: "Add or remove one typed Task relation with graph and version validation.",
    parameters: Type.Object({
      team_name: Type.String(),
      task_id: Type.String(),
      relation: StringEnum(["blocked_by", "parent", "related"]),
      target_id: Type.String(),
      action: StringEnum(["add", "remove"]),
      expected_version: Type.Optional(Type.String({ description: "Optimistic concurrency token from task_read" })),
    }) as any,
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const graphPostState = (task: TaskFile, includeBoundedSource = false) => ({
        id: task.id,
        version: task.version,
        relations: task.relations,
        ...(includeBoundedSource ? {
          title: task.title,
          status: task.status,
          assignee: task.assignee ?? null,
          relationCount: task.relations.length,
        } : {}),
      });
      const actingSessionFile = ctx?.sessionManager?.getSessionFile?.();
      const actorMembership = await assertCurrentSessionBinding(ctx, params.team_name);
      let result: Awaited<ReturnType<typeof tasks.mutateTaskLink>>;
      try {
        result = await tasks.mutateTaskLink(params.team_name, params.task_id, {
          relation: params.relation,
          targetId: params.target_id,
          action: params.action,
        }, {
          actor: agentName,
          expectedVersion: params.expected_version,
          actingSessionFile,
          actingMembershipId: actorMembership.membershipId,
        });
      } catch (error) {
        if (!(error instanceof BeadsError) || error.kind !== "conflict") throw error;
        const current = await tasks.readTask(params.team_name, params.task_id);
        const staleVersion = /changed since version|expected(?: Task)? version|stale/i.test(error.message);
        const conflictReason = staleVersion ? "stale_version" : "graph_invariant";
        const requestedRelationExists = current.relations.some((relation) => (
          relation.relation === params.relation && relation.targetId === params.target_id
        ));
        const currentRelationState = requestedRelationExists
          ? `The current ${params.relation} relation ${current.id} → ${params.target_id} remains.`
          : `The current graph still has no ${params.relation} relation ${current.id} → ${params.target_id}.`;
        return {
          content: [{
            type: "text",
            text: staleVersion
              ? `The requested ${params.relation} relation change was not applied because the expected version is stale. ${currentRelationState} Read Task ${current.id} to review its current graph before retrying.`
              : `Task relation not changed: the requested graph mutation conflicts with current relations. Review Task ${current.id} at version ${current.version} before retrying.`,
          }],
          details: toolResultDetails({
            outcome: "refused",
            operation: "task_link",
            resource: { kind: "task", id: current.id, teamName: params.team_name },
            postState: graphPostState(current),
            warnings: [toolResultWarning(
              staleVersion ? "task_relation_stale_version" : "task_relation_graph_conflict",
              staleVersion
                ? "The expected Task version is stale; no relation changed."
                : "The requested mutation conflicts with the current Task graph; no relation changed.",
              current.id,
            )],
            nextActions: [{
              tool: "task_read",
              reason: "Read current Task authority before deciding whether to retry the relation change.",
              args: {
                team_name: params.team_name,
                task_id: current.id,
              },
            }],
            evidence: {
              requestedVersion: params.expected_version,
              currentVersion: current.version,
              relation: params.relation,
              targetId: params.target_id,
              action: params.action,
              changed: false,
              conflictReason,
            },
          }),
        };
      }
      const noOpReason = params.action === "add" ? "already_present" : "already_absent";
      const relationDescription = `${params.relation} relation ${params.task_id} → ${params.target_id}`;
      const receiptText = result.changed
        ? `${params.action === "add" ? "Added" : "Removed"} ${relationDescription}; source Task version is now ${result.task.version}.${result.deliveryWarnings.length ? ` Delivery warnings: ${result.deliveryWarnings.join("; ")}` : ""}`
        : `Task relation unchanged: ${relationDescription} was ${params.action === "add" ? "already present" : "already absent"}. Source Task remains version ${result.task.version}.`;
      return {
        content: [{
          type: "text",
          text: receiptText,
        }],
        details: toolResultDetails({
          outcome: result.deliveryDegraded ? "partial" : "accepted",
          operation: "task_link",
          resource: { kind: "task", id: result.task.id, teamName: params.team_name },
          postState: graphPostState(result.task, result.changed && params.action === "remove"),
          warnings: result.deliveryWarnings.map((message) => toolResultWarning(
            "task_delivery_degraded",
            message,
            result.task.id,
          )),
          nextActions: [],
          evidence: {
            relation: params.relation,
            targetId: params.target_id,
            action: params.action,
            changed: result.changed,
            ...(result.changed ? {} : { noOpReason }),
            deliveryAttempted: result.changed && !!result.task.assignee,
            expectedVersion: params.expected_version,
            appliedOperations: result.appliedOperations,
            deliveryDegraded: result.deliveryDegraded,
          },
        }),
      };
    },
  });

  pi.registerTool({
    name: "team_shutdown",
    label: "Shutdown Team",
    description: "Attempt to stop every teammate and deactivate only Memberships whose terminal/process stop is confirmed.",
    parameters: Type.Object({
      team_name: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const teamName = paths.sanitizeName(params.team_name);
      return teams.withTeamTopologyLease(teamName, async () => {
      await assertLeadMutation(ctx, "team_shutdown", teamName);
      try {
        const config = await teams.readConfig(teamName);
        const current = config.members.filter((member) => member.isActive !== false);
        const deactivated: Member[] = [];
        const failures: Array<{ name: string; error: string }> = [];
        const teammates = current.filter((member) => member.name !== "team-lead" && member.agentType !== "lead");
        const outcomes = await Promise.allSettled(teammates.map(async (member) => {
          const changed = await transitionCurrentMembership(teamName, member, "team_shutdown", true);
          if (changed.member) deactivated.push(changed.member);
          return changed.stopEvidence;
        }));
        const stopEvidence: TeammateStopEvidence[] = [];
        outcomes.forEach((outcome, index) => {
          if (outcome.status === "rejected") failures.push({
            name: teammates[index].name,
            error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
          });
          else if (outcome.value) stopEvidence.push(outcome.value);
        });
        // The lead remains current whenever a teammate could not be stopped,
        // so one live coordinator retains authority to retry or inspect the
        // partial shutdown. It closes only after every teammate terminal
        // action and membership transition succeeded.
        if (failures.length === 0) {
          const lead = current.find((member) => member.name === "team-lead" || member.agentType === "lead");
          if (lead) {
            const changed = await transitionCurrentMembership(teamName, lead, "team_shutdown", false);
            if (changed.member) deactivated.push(changed.member);
          }
        }
        const finalConfig = await teams.readConfig(teamName);
        const unfinishedTasks = (await tasks.listTasksWithVersions(teamName, { nonterminalOnly: true }))
          .map((task) => ({ id: task.id, title: task.title, status: task.status, assignee: task.assignee ?? null, version: task.version }));
        const lifecycle = failures.length === 0 ? "shut_down" : "active";
        const failureSummaries = failures.map((failure) => ({
          name: failure.name,
          reason: "stop_not_confirmed",
          membershipRemainsCurrent: true,
        }));
        const stoppedWorkerNames = deactivated.filter((member) => member.agentType === "teammate").map((member) => member.name);
        const currentMembers = finalConfig.members.filter((member) => member.isActive !== false).map((member) => member.name);
        const details = toolResultDetails({
          outcome: failures.length > 0 ? "partial" : "accepted",
          operation: "team_shutdown",
          resource: { kind: "team", id: teamName, teamName },
          postState: {
            lifecycle,
            shutdownOutcome: failures.length === 0 ? "complete" : "partial",
            stoppedWorkers: stopEvidence.length,
            stoppedWorkerNames,
            currentMembers,
            deactivatedMembers: deactivated.map((member) => member.name),
            failures: failureSummaries,
            unfinishedTasks,
            taskAuthorityRetained: true,
          },
          warnings: failures.map((failure) => toolResultWarning(
            "worker_stop_failed",
            "Worker stop couldn't be confirmed; its Membership remains current.",
            failure.name,
          )),
          nextActions: failures.length > 0
            ? [{ tool: "team_shutdown", reason: "Resolve the named Worker stop failures, then retry.", args: { team_name: teamName } }]
            : [],
          evidence: {
            deactivatedMembershipIds: deactivated.map((member) => member.membershipId).filter(Boolean),
            stop: stopEvidence,
            stopFailures: failures,
          },
          diagnostics: {
            staleBindings: finalConfig.members
              .filter((member) => member.isActive === false && hasPersistedTerminalTarget(member))
              .map((member) => ({
                name: member.name,
                membershipId: member.membershipId,
                sessionBound: !!member.sessionFile,
                terminal: member.terminalTarget
                  ? { backend: member.terminalTarget.backend, kind: member.terminalTarget.kind, targetId: member.terminalTarget.targetId }
                  : member.windowId
                    ? { kind: "window", targetId: member.windowId }
                    : { kind: "pane", targetId: member.tmuxPaneId },
              })),
          },
        });
        await refreshTeamFooter(ctx);
        return {
          content: [{
            type: "text",
            text: failures.length === 0
              ? `Team ${teamName} shut down. Stopped ${stopEvidence.length} Workers; no Worker stops failed. Task authority and ${unfinishedTasks.length} unfinished ${unfinishedTasks.length === 1 ? "Task" : "Tasks"} retained. No further lifecycle action is required.`
              : `Team ${teamName} shutdown partially completed, so the Team remains active with ${currentMembers.join(", ")} current. Stopped ${stoppedWorkerNames.join(", ") || "no Workers"}; stop wasn't confirmed for ${failures.map((failure) => failure.name).join(", ")}. Task authority and ${unfinishedTasks.length} unfinished ${unfinishedTasks.length === 1 ? "Task" : "Tasks"} retained; resolve the failure and retry.`,
          }],
          details,
        };
      } catch (e) {
        throw new Error(`Failed to shutdown team: ${e}`);
      }
      });
    },
  });

  pi.registerTool({
    name: "report_stale_agent_sessions",
    label: "Report Stale Agent Sessions",
    description: "Report old Pi-core agent session folders for review without deleting them.",
    parameters: Type.Object({
      max_age_hours: Type.Optional(Type.Number()),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const maxAgeHours = params.max_age_hours ?? 24;
      const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
      const report = inspectAgentSessionCleanup(maxAgeMs);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ...report, maxAgeHours }),
        }],
        details: { ...report, maxAgeHours }
      };
    },
  });

  pi.registerTool({
    name: "task_read",
    label: "Read Task",
    description: "Read current Task details on demand, especially before a later conditional write; mutation receipts already contain their post-state.",
    parameters: Type.Object({
      team_name: Type.String(),
      task_id: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      await assertCurrentSessionBinding(ctx, params.team_name);
      let task: Awaited<ReturnType<typeof tasks.readTask>>;
      try {
        task = await tasks.readTask(params.team_name, params.task_id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!(error instanceof BeadsError) || error.kind !== "command" || !/(not found|no issue found)/i.test(message)) throw error;
        return {
          content: [{
            type: "text",
            text: `Task ${params.task_id} wasn't found in Team ${params.team_name}; Task authority is unchanged. Use a team_sync snapshot to reconcile current Task IDs before retrying.`,
          }],
          details: toolResultDetails({
            outcome: "refused",
            operation: "task_read",
            resource: { kind: "task", id: params.task_id, teamName: params.team_name },
            postState: { found: false },
            warnings: [toolResultWarning("task_not_found", `Task ${params.task_id} does not exist in this Team authority.`, params.task_id)],
            nextActions: [{
              tool: "team_sync",
              reason: "Read the current compact Task projection to select a valid Task ID.",
              args: { team_name: params.team_name },
            }],
            evidence: {
              authority: { backend: "beads", teamName: params.team_name },
              taskAuthorityChanged: false,
            },
          }),
        };
      }
      const relations = task.relations.length > 0
        ? task.relations.map((relation) => `${relation.relation} ${relation.targetId}`).join(", ")
        : "none";
      return {
        content: [{
          type: "text",
          text: [
            `Task ${task.id}: ${task.title} — ${task.description || "not specified"}`,
            `State: ${task.status}; ${task.assignee ? `assigned to ${task.assignee}` : "unassigned"}; version ${task.version}`,
            `Acceptance criteria: ${task.acceptanceCriteria || "not specified"}`,
            `Design: ${task.design || "not specified"}`,
            `Relations: ${relations}`,
            `Notes: ${task.notes || "none"}`,
          ].join("\n"),
        }],
        details: toolResultDetails({
          operation: "task_read",
          resource: { kind: "task", id: task.id, teamName: params.team_name },
          postState: { ...task, assignee: task.assignee ?? null, design: task.design ?? null, notes: task.notes ?? null },
          nextActions: [{
            tool: "task_update",
            reason: "Use the returned exact version for a conditional mutation when one is needed.",
            args: { team_name: params.team_name, task_id: task.id, expected_version: task.version },
          }],
        }),
      };
    },
  });

  pi.registerTool({
    name: "check_teammate",
    label: "Check Teammate",
    description: "Diagnose one teammate's runtime health on demand. Do not routinely poll this tool for progress or completion.",
    parameters: Type.Object({
      team_name: Type.String(),
      agent_name: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      await assertCurrentSessionBinding(ctx, params.team_name);
      const config = await teams.readConfig(params.team_name);
      const member = [...config.members].reverse().find(m => m.name === params.agent_name && m.isActive !== false);
      if (!member) throw new Error(`Teammate ${params.agent_name} not found`);
      if (!member.membershipId) throw new Error(`Current Membership for ${params.agent_name} has no membershipId.`);

      let alive = false;
      const healthTerminal = terminalForTeam(config);
      const healthTarget = config.terminalBackend
        ? assertTeamTerminalTarget(config, member)
        : memberTerminalTarget(member, healthTerminal.name);
      if (healthTarget) assertTargetSupportedByTerminal(healthTerminal, healthTarget);
      if (healthTarget?.kind === "window") {
        alive = healthTerminal.isWindowAlive(healthTarget.targetId);
      } else if (healthTarget?.kind === "pane") {
        alive = healthTerminal.isAlive(healthTarget.targetId);
      }

      const unreadCount = (await messaging.readInboxForMembership(
        params.team_name,
        params.agent_name,
        member.membershipId,
        true,
        false,
      )).length;
      const storedRuntime = await runtime.readRuntimeStatus(params.team_name, params.agent_name);
      const runtimeStatus = storedRuntime?.membershipId === member.membershipId ? storedRuntime : null;
      const now = Date.now();
      const hasRecentHeartbeat = !!runtimeStatus?.lastHeartbeatAt
        && (now - runtimeStatus.lastHeartbeatAt) <= runtime.HEARTBEAT_STALE_MS;
      const startupStalled = alive
        && unreadCount > 0
        && (now - member.joinedAt) > runtime.STARTUP_STALL_MS
        && !(runtimeStatus?.ready);
      const health = !alive
        ? "dead"
        : startupStalled
          ? "stalled"
          : runtimeStatus?.ready
            ? (hasRecentHeartbeat ? "healthy" : "idle")
            : "starting";

      const details = {
        alive,
        unreadCount,
        health,
        hasRecentHeartbeat,
        startupStalled,
        runtime: runtimeStatus,
      };

      // Absence of a terminal surface is not sufficient evidence to delete a
      // live runtime generation. Cleanup only the exact observed dead process.
      const checkedGeneration = exactRuntimeGeneration(member, runtimeStatus);
      if (!alive && exactBoundProcessAlreadyExited(checkedGeneration)) {
        await runtime.deleteRuntimeStatus(params.team_name, params.agent_name, checkedGeneration!);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ alive, unreadCount, health, hasRecentHeartbeat, startupStalled }, null, 2),
        }],
        details,
      };
    },
  });

  pi.registerTool({
    name: "worker_stop",
    label: "Stop Worker",
    description: "Stop one Worker only when it has no assigned nonterminal Tasks, then deactivate its current Membership after shutdown is confirmed.",
    parameters: Type.Object({
      team_name: Type.String(),
      worker: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const safeTeamName = paths.sanitizeName(params.team_name);
      const safeAgentName = paths.sanitizeName(params.worker);
      return teams.withTeamTopologyLease(safeTeamName, async () => {
        await assertLeadMutation(ctx, "worker_stop", safeTeamName);
        const config = await teams.readConfig(safeTeamName);
        const member = [...config.members].reverse().find(m => m.name === safeAgentName && m.isActive !== false);
        if (!member) {
          return {
            content: [{ type: "text", text: `Worker ${safeAgentName} not stopped: no current Worker by that name exists. No state changed.` }],
            details: toolResultDetails({
              outcome: "refused",
              operation: "worker_stop",
              resource: { kind: "worker", id: safeAgentName, teamName: safeTeamName },
              postState: {
                worker: safeAgentName,
                changed: false,
                reason: "worker_not_found",
                currentWorkers: config.members.filter((candidate) => candidate.agentType === "teammate" && candidate.isActive !== false).map((candidate) => candidate.name),
              },
              warnings: [toolResultWarning("worker_not_found", `No current Worker named ${safeAgentName} exists.`, safeAgentName)],
              nextActions: [{
                tool: "team_sync",
                reason: "Read the current Worker projection before choosing a lifecycle action.",
                args: { team_name: safeTeamName },
              }],
            }),
          };
        }
        if (member.name === "team-lead" || member.agentType === "lead") {
          throw new Error("worker_stop cannot shut down the team leader; use team_shutdown for whole-team lifecycle closure.");
        }

        const unfinished = await tasks.listTasksWithVersions(safeTeamName, {
          assignee: safeAgentName,
          nonterminalOnly: true,
        });
        if (unfinished.length > 0) {
          const ids = unfinished.map((task) => task.id);
          return {
            content: [{
              type: "text",
              text: `Worker ${safeAgentName} not stopped: assigned nonterminal ${ids.length === 1 ? "Task" : "Tasks"} ${ids.join(", ")}. Close, reassign, or block and unassign ${ids.length === 1 ? "it" : "them"} first.`,
            }],
            details: toolResultDetails({
              outcome: "refused",
              operation: "worker_stop",
              resource: { kind: "worker", id: safeAgentName, teamName: safeTeamName },
              postState: {
                worker: safeAgentName,
                changed: false,
                reason: "nonterminal_tasks_assigned",
                membership: "current",
                currentWorkers: config.members.filter((candidate) => candidate.agentType === "teammate" && candidate.isActive !== false).map((candidate) => candidate.name),
                guardingTasks: unfinished.map((task) => ({
                  id: task.id,
                  title: task.title,
                  status: task.status,
                  version: task.version,
                })),
              },
              warnings: unfinished.map((task) => toolResultWarning(
                "worker_has_nonterminal_task",
                `Task ${task.id} is ${task.status} and assigned to ${safeAgentName}.`,
                task.id,
              )),
              nextActions: unfinished.map((task) => ({
                tool: "task_update",
                reason: "Close, reassign, or block and unassign this Task before retrying worker_stop.",
                args: { team_name: safeTeamName, task_id: task.id, expected_version: task.version },
              })),
              evidence: { membershipId: member.membershipId },
            }),
          };
        }

        const changed = await transitionCurrentMembership(safeTeamName, member, "process_shutdown", true);
        await teamEvents.appendTeamEvent(safeTeamName, {
          type: "worker", worker: safeAgentName, membershipId: member.membershipId!, phase: "stopped",
        });
        return {
          content: [{ type: "text", text: `Worker ${safeAgentName} stopped; no Task state changed.` }],
          details: toolResultDetails({
            operation: "worker_stop",
            resource: { kind: "worker", id: safeAgentName, teamName: safeTeamName },
            postState: { worker: safeAgentName, membership: "inactive", taskStateChanged: false },
            evidence: {
              deactivatedMembershipId: changed.member?.membershipId,
              stop: changed.stopEvidence,
              receipt: {
                operation: "worker_stop",
                worker: safeAgentName,
                membershipId: changed.member?.membershipId || member.membershipId,
              },
            },
          }),
        };
      });
    },
  });

  pi.registerTool({
    name: "list_predefined_teams",
    label: "List Predefined Teams",
    description: "List all available predefined team configurations from teams.yaml files. These are team templates that can be instantiated with create_predefined_team.",
    parameters: Type.Object({}),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const projectDir = ctx.cwd;
      const predefinedTeams = predefined.getAllPredefinedTeams(projectDir);
      const agents = predefined.getAllAgentDefinitions(projectDir);
      
      const result = predefinedTeams.map(team => {
        const teamAgents = team.agents.map(agentName => {
          const agentDef = agents.find(a => a.name === agentName);
          return {
            name: agentName,
            description: agentDef?.description || "(agent definition not found)",
            found: !!agentDef,
          };
        });
        
        return {
          name: team.name,
          agents: teamAgents,
        };
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { teams: result },
      };
    },
  });

  pi.registerTool({
    name: "list_predefined_agents",
    label: "List Predefined Agents",
    description: "List all available predefined agent definitions from .md files. These can be used individually or as part of predefined teams.",
    parameters: Type.Object({}),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const projectDir = ctx.cwd;
      const agents = predefined.getAllAgentDefinitions(projectDir);
      
      const result = agents.map(agent => ({
        name: agent.name,
        description: agent.description,
        tools: agent.tools,
        model: agent.model,
        thinking: agent.thinking,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { agents: result },
      };
    },
  });

  pi.registerTool({
    name: "create_predefined_team",
    label: "Create Predefined Team",
    description: "Create a team from a predefined team configuration. Spawns all agents defined in the team template from teams.yaml. Each agent is spawned with its predefined prompt, tools, and settings.",
    parameters: Type.Object({
      team_name: Type.String({ description: "Name for the new team instance" }),
      predefined_team: Type.String({ description: "Name of the predefined team template from teams.yaml" }),
      cwd: Type.String({ description: "Working directory for spawned agents" }),
      default_model: Type.Optional(Type.String({ description: "Default model for agents without a specified model. Omit this parameter to use Pi's configured default model; set it only when the user explicitly requests a specific model." })),
      separate_windows: Type.Optional(Type.Boolean({ default: false, description: "Open teammates in separate OS windows instead of panes" })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      await assertLeadMutation(ctx, "create_predefined_team");
      const projectDir = ctx.cwd;
      const leadSessionFile = ctx?.sessionManager?.getSessionFile?.();
      if (!leadSessionFile) throw new Error("create_predefined_team requires a durable Pi Session file.");
      const predefinedTeam = predefined.getPredefinedTeam(params.predefined_team, projectDir);
      
      if (!predefinedTeam) {
        const available = predefined.getAllPredefinedTeams(projectDir).map(t => t.name);
        throw new Error(`Predefined team "${params.predefined_team}" not found. Available teams: ${available.join(", ") || "none"}`);
      }
      const duplicateNames = [...new Set(predefinedTeam.agents.filter((name, index) => predefinedTeam.agents.indexOf(name) !== index))];
      if (predefinedTeam.agents.includes("team-lead") || duplicateNames.length > 0) {
        throw new Error(`Invalid predefined team '${params.predefined_team}': teammate names must be unique and 'team-lead' is reserved${duplicateNames.length ? `; duplicates: ${duplicateNames.join(", ")}` : ""}.`);
      }

      if (!terminal) {
        throw new Error("No terminal adapter detected.");
      }

      const safeTeamName = paths.sanitizeName(params.team_name);
      return teams.withTeamTopologyLease(safeTeamName, async (topologyLease) => {

      // Create the team
      const taskAuthority = await tasks.resolveTeamTaskAuthority(safeTeamName);
      const config = await teams.createTeam(
        safeTeamName,
        leadSessionFile,
        "lead-agent",
        `Predefined team: ${params.predefined_team}`,
        params.default_model,
        params.separate_windows,
        taskAuthority.workspace,
        taskAuthority.authorityId,
        taskAuthority.fingerprint,
        topologyLease,
        {
          backend: terminal.name,
          ...(terminal.currentTargetId?.()
            ? { leadTarget: terminalTarget(terminal.name, "pane", terminal.currentTargetId()!) }
            : {}),
        },
      );
      await registerLeadSession(safeTeamName, leadSessionFile, undefined, true);
      // Update teamName and start native custom delivery for the lead.
      teamName = safeTeamName;
      currentMembershipId = config.members.find((member) => member.name === "team-lead" && member.isActive !== false)?.membershipId;
      await startDirectMessageDelivery(ctx);
      await startTaskChangeDelivery(ctx);
      await refreshTeamFooter(ctx);

      const agentDefinitions = predefined.getAllAgentDefinitions(projectDir);
      const spawnResults: Array<{ name: string; status: string; error?: string }> = [];

      // Spawn each agent in the predefined team
      for (const agentName of predefinedTeam.agents) {
        const agentDef = agentDefinitions.find(a => a.name === agentName);
        
        if (!agentDef) {
          spawnResults.push({ name: agentName, status: "skipped", error: "Agent definition not found" });
          continue;
        }

        try {
          const safeName = paths.sanitizeName(agentName);
          
          let chosenModel = agentDef.model || params.default_model || config.defaultModel;
          
          if (chosenModel && !chosenModel.includes('/')) {
            const resolved = resolveModelWithProvider(chosenModel);
            if (resolved) {
              chosenModel = resolved;
            } else if (config.defaultModel && config.defaultModel.includes('/')) {
              const [provider] = config.defaultModel.split('/');
              chosenModel = `${provider}/${chosenModel}`;
            }
          }

          const useSeparateWindow = params.separate_windows ?? config.separateWindows ?? false;
          if (useSeparateWindow && !terminal.supportsWindows()) {
            throw new Error(`Separate windows mode is not supported in ${terminal.name}.`);
          }

          const member: Member = {
            membershipId: teams.newMembershipId(),
            pendingLaunchId: teams.newLaunchId(),
            agentId: `${safeName}@${safeTeamName}`,
            name: safeName,
            agentType: "teammate",
            model: chosenModel,
            joinedAt: Date.now(),
            cwd: params.cwd,
            subscriptions: [],
            prompt: agentDef.prompt,
            color: "blue",
            thinking: agentDef.thinking,
          };

          await teams.addMember(safeTeamName, member);

          const aggregate = workerAggregate(params.cwd, ctx);
          const piCmd = buildPiArgv(getPiLaunchArgv(), chosenModel, agentDef.thinking, aggregate.path, aggregate.projectTrusted);

          const env: Record<string, string> = {
            ...process.env,
            PI_TEAM_NAME: safeTeamName,
            PI_AGENT_NAME: safeName,
            PI_AGENT_LAUNCH_ID: member.pendingLaunchId!,
            ...(aggregate.path ? { PI_TEAM_BRIGHT_WORKER_AGGREGATE: aggregate.path } : {}),
          };

          await workerLaunchBridge.launchPreparedMembership(
            safeTeamName,
            member,
            () => messaging.sendPlainMessage(safeTeamName, "team-lead", safeName, agentDef.prompt, "Initial prompt from predefined team"),
            async () => {
            if (useSeparateWindow) {
              const terminalId = terminal.spawnWindow({
                name: safeName,
                cwd: params.cwd,
                argv: piCmd,
                env: env,
                teamName: safeTeamName,
              });
              return { terminalId, isWindow: true, backend: terminal.name };
            }
            if (terminal instanceof Iterm2Adapter) {
              const teammates = (await teams.readConfig(safeTeamName)).members.filter(m => m.agentType === "teammate" && m.tmuxPaneId?.startsWith("iterm_"));
              const lastTeammate = teammates.length > 0 ? teammates[teammates.length - 1] : null;
              if (lastTeammate?.tmuxPaneId) {
                terminal.setSpawnContext({ lastSessionId: lastTeammate.tmuxPaneId.replace("iterm_", "") });
              } else {
                terminal.setSpawnContext({});
              }
            }

            const leadMember = (await teams.readConfig(safeTeamName)).members.find(m => m.name === "team-lead");
            const leadTarget = leadMember ? memberTerminalTarget(leadMember, config.terminalBackend || terminal.name) : undefined;
            const anchorPaneId = leadTarget?.kind === "pane"
              ? leadTarget.targetId
              : (terminal as import("../src/utils/terminal-adapter").TerminalAdapter).currentTargetId?.() || undefined;

            const terminalId = terminal.spawn({
              name: safeName,
              cwd: params.cwd,
              argv: piCmd,
              env: env,
              anchorPaneId,
            });
            return { terminalId, isWindow: false, backend: terminal.name };
            },
            aggregate.path,
          );

          spawnResults.push({ name: agentName, status: "spawned", error: undefined });
        } catch (e) {
          spawnResults.push({ name: agentName, status: "error", error: String(e) });
        }
      }

      const summary = spawnResults.map(r => `${r.name}: ${r.status}${r.error ? ` (${r.error})` : ""}`).join("\n");
      const failed = spawnResults.filter((result) => result.status !== "spawned");
      if (failed.length > 0) {
        throw new Error(
          `Predefined team "${params.predefined_team}" was only partially launched; failed members were compensated or left current only when shutdown could not be confirmed:\n${summary}`,
        );
      }
      
      return {
        content: [{ type: "text", text: `Team "${safeTeamName}" created from predefined team "${params.predefined_team}".\n\nAgent spawn results:\n${summary}` }],
        details: {
          teamName: safeTeamName,
          predefinedTeam: params.predefined_team,
          results: spawnResults,
          receipt: mutationReceipt(
            "create_predefined_team",
            { kind: "team", id: safeTeamName, template: params.predefined_team },
            {
              teamState: "current",
              teammateResults: spawnResults,
            },
            [],
          ),
        },
      };
      });
    },
  });

  pi.registerTool({
    name: "save_team_as_template",
    label: "Save Team as Template",
    description: "Save a runtime team as a reusable predefined team template. Creates agent definition files and updates teams.yaml. Use this when you've created a team with custom prompts and want to reuse it later.",
    parameters: Type.Object({
      team_name: Type.String({ description: "Name of the runtime team to save" }),
      template_name: Type.String({ description: "Name for the template (e.g., 'modularization', 'frontend-team')" }),
      description: Type.Optional(Type.String({ description: "Description for the template" })),
      scope: Type.Optional(StringEnum(["user", "project"], { description: "Where to save: 'user' for global (~/.pi), 'project' for project-local (.pi). Defaults to 'user'." })),
      dry_run: Type.Optional(Type.Boolean({ default: false, description: "Preview exact output paths and contents without writing files." })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      await assertLeadMutation(ctx, "save_team_as_template", params.team_name);
      const teamName = params.team_name;
      
      // Verify the team exists
      if (!teams.teamExists(teamName)) {
        throw new Error(`Team "${teamName}" does not exist. Save only the Team currently bound to this exact Session.`);
      }

      // Read the team configuration
      const config = await teams.readConfig(teamName);
      
      // Check that there are teammates to save
      const teammates = config.members.filter(m => m.agentType === "teammate" && m.isActive !== false);
      if (teammates.length === 0) {
        throw new Error(`Team "${teamName}" has no teammates to save. Only teams with spawned teammates can be saved as templates.`);
      }

      // Save the team as a template
      const result = predefined.saveTeamTemplate(config, {
        templateName: params.template_name,
        description: params.description,
        scope: params.scope || "user",
        projectDir: ctx.cwd,
        dryRun: params.dry_run ?? false,
      });

      // Build summary message
      const agentSummary = result.savedAgents.map(a => 
        `  - ${a.name}: ${a.existed ? "updated" : "created"} at ${a.path}`
      ).join("\n");
      
      const message = `Template "${params.template_name}" ${result.dryRun ? "previewed from" : "saved from"} Team "${teamName}".

Agent artifacts ${result.dryRun ? "planned" : "written"}:
${agentSummary}

Template location: ${result.teamsYamlPath}

${result.dryRun
  ? "No files were written. Review the artifact plan, then repeat with dry_run: false."
  : `You can now use this template with:\n  create_predefined_team({ team_name: "new-team", predefined_team: "${params.template_name}", cwd: "..." })`}`;

      return {
        content: [{ type: "text", text: message }],
        details: {
          teamName,
          templateName: params.template_name,
          agentsDir: result.agentsDir,
          teamsYamlPath: result.teamsYamlPath,
          savedAgents: result.savedAgents,
          templateExisted: result.templateExisted,
          dryRun: result.dryRun,
          artifacts: result.artifacts,
          receipt: mutationReceipt(
            "save_team_as_template",
            { kind: "team_template", id: params.template_name, teamName },
            {
              state: result.dryRun ? "previewed" : "written",
              dryRun: result.dryRun,
              artifacts: result.artifacts,
            },
            [],
            result.dryRun ? "Review artifacts, then call save_team_as_template with dry_run false to write them." : undefined,
          ),
        },
      };
    },
  });

}
