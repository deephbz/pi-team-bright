import { hostEnv } from "../src/env/host-env";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { createAlertSender } from "../src/alert-authority/alerts";
import { createToolCallRenderer, createToolResultRenderer } from "../src/model-tool-contract/tui-projection";
import {
  createCustomMessageRenderer,
  projectDirectMessage,
  projectSyncNudgeMessage,
  projectTaskChangeMessage,
  projectDoctorMessage,
  projectWorkerRecoveryMessage,
  projectStatusEntry,
} from "../src/model-tool-contract/custom-message-projection";
import { renderProjectionWithTheme } from "../src/model-tool-contract/tui-message-projection";
import { resolveWorkerLaunchResources } from "../src/utils/worker-resource-projection";
import { SYNC_NUDGE_CUSTOM_TYPE } from "../src/utils/sync-nudge";
import { LEGACY_TASK_CHANGE_CUSTOM_TYPE, TASK_CHANGE_CUSTOM_TYPE } from "../src/utils/task-delivery";
import { DIRECT_MESSAGE_CUSTOM_TYPE, LEGACY_DIRECT_MESSAGE_CUSTOM_TYPE } from "../src/alert-authority/direct-delivery";
import { PTB_DOCTOR_CUSTOM_TYPE } from "../src/utils/ptb-doctor-command";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { registerAutomaticSummaryPolicyProvider } from "../src/utils/automatic-summary-policy";
import { createWorkerLaunchBridge, type WorkerAggregate } from "../src/team-authority/worker-launch-bridge";
import { DurableTeamLifecyclePublication } from "../src/adapters/durable-team-lifecycle-publication";
import { TeamLifecycleService } from "../src/team-authority/team-lifecycle-service";
import { TeamSessionLifecycleService } from "../src/team-authority/team-session-lifecycle-service";
import { projectNonterminalTaskIds, projectTaskChanges } from "../src/coordination/task-change-projection";
import { DurableTaskMutationPublication } from "../src/adapters/durable-task-mutation-publication";
import { DurableGraphTaskAuthority } from "../src/adapters/durable-graph-task-authority";
import { graphTaskAuthorityPath } from "../src/utils/paths";
import { DurableGraphTaskOrchestration } from "../src/task-authority/graph-orchestration";
import { DurableGraphAssignedWorkGuard } from "../src/adapters/durable-graph-assigned-work";
import { DurableTaskChangeDeliveryMembership } from "../src/adapters/durable-task-change-delivery-membership";
import { DurablePiSessionTeamQuery } from "../src/adapters/durable-pi-session-team-query";
import { DurableAlertMembership } from "../src/adapters/durable-alert-membership";
import { DurableAlertPublication } from "../src/adapters/durable-alert-publication";
import { createDurableCoordinationQueries } from "../src/adapters/durable-coordination-queries";
import { CoordinationObservationService, createDurableCoordinationObservationStore } from "../src/coordination/observation-service";

import { createPiTeamSessionAdapter } from "./pi-team-session-adapter";
import { TEAM_UPDATE_TYPE, projectTeamUpdateMessage } from "./team-update";

import { GraphTaskUpdateParametersSchema, TaskVersionRefSchema } from "../src/model-tool-contract/catalog";
import { WorkerAlertSendParametersSchema, WorkerTaskReadParametersSchema } from "../src/model-tool-contract/worker-parameters";
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
  const argv1 = hostEnv().process.argv[1];
  const execPath = hostEnv().process.execPath;

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
  if (model) argv.push("--model", model);
  if (thinking) argv.push("--thinking", thinking);
  // Worker model-facing tools are projected in the Worker process. Do not pass
  // a CLI allowlist, because it cannot re-enable registered tools at runtime.
  if (aggregatePrompt) argv.push("--no-context-files", "--append-system-prompt", aggregatePrompt);
  if (projectTrusted !== undefined) argv.push(projectTrusted ? "--approve" : "--no-approve");
  return argv;
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
  const now = hostEnv().clock.now();

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
  const taskChangeRenderer = createCustomMessageRenderer(projectTaskChangeMessage);
  const directMessageRenderer = createCustomMessageRenderer(projectDirectMessage);
  pi.registerMessageRenderer?.(TASK_CHANGE_CUSTOM_TYPE, taskChangeRenderer as any);
  pi.registerMessageRenderer?.(LEGACY_TASK_CHANGE_CUSTOM_TYPE, taskChangeRenderer as any);
  pi.registerMessageRenderer?.(DIRECT_MESSAGE_CUSTOM_TYPE, directMessageRenderer as any);
  pi.registerMessageRenderer?.(LEGACY_DIRECT_MESSAGE_CUSTOM_TYPE, directMessageRenderer as any);
  pi.registerMessageRenderer?.(SYNC_NUDGE_CUSTOM_TYPE, createCustomMessageRenderer(projectSyncNudgeMessage) as any);
  pi.registerMessageRenderer?.(TEAM_UPDATE_TYPE, createCustomMessageRenderer(projectTeamUpdateMessage) as any);
  pi.registerMessageRenderer?.(PTB_DOCTOR_CUSTOM_TYPE, createCustomMessageRenderer(projectDoctorMessage) as any);
  pi.registerMessageRenderer?.("ptb.worker-recovery", createCustomMessageRenderer(projectWorkerRecoveryMessage) as any);
  pi.registerEntryRenderer?.("ptb.status", (entry, options, theme) => {
    const projection = projectStatusEntry(entry.data);
    return projection ? renderProjectionWithTheme(projection, options, theme) : undefined;
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
  const initialIsTeammate = !!hostEnv().process.env.PI_AGENT_NAME && hostEnv().process.env.PI_AGENT_NAME !== "team-lead";
  let sessionAdapter!: ReturnType<typeof createPiTeamSessionAdapter>;
  const workerToolDefinitions = new Map<string, ToolDefinition<any, any>>();
  let alertToolRegistration: { description: string; parameters: unknown } | undefined;
  const registerPublicTool = pi.registerTool.bind(pi);

  function registerProjectedWorkerTool(tool: ToolDefinition<any, any>): void {
    registerPublicTool({
      ...tool,
      renderShell: "self",
      execute: async (...callArgs: any[]) => (tool.execute as any)(...callArgs),
      renderCall: createToolCallRenderer(tool.name as any),
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
      leaderCwd: ctx.cwd ?? hostEnv().process.cwd(),
      leaderProjectTrusted: projectTrust(ctx),
    });
    return { path: resources.aggregatePath, projectTrusted: resources.projectTrusted, modelRoleSettings: resources.policy.modelRoleSettings };
  }

  const taskPublication = new DurableTaskMutationPublication();
  const graphTaskAuthority = new DurableGraphTaskAuthority();
  const graphTaskOrchestration = new DurableGraphTaskOrchestration(graphTaskAuthority, taskPublication, taskPublication, taskPublication);
  const alertMembership = new DurableAlertMembership();
  const taskDeliveryMembership = new DurableTaskChangeDeliveryMembership();
  const piSessionTeamQuery = new DurablePiSessionTeamQuery();
  const alertPublication = new DurableAlertPublication();
  const alertSender = createAlertSender(alertMembership, alertPublication);
  const coordinationQueries = createDurableCoordinationQueries(graphTaskOrchestration);
  const coordinationObservationService = new CoordinationObservationService(
    coordinationQueries,
    { projectNonterminalTaskIds, projectTaskChanges },
    createDurableCoordinationObservationStore(),
  );

  const lifecyclePublication = new DurableTeamLifecyclePublication();
  const graphAssignedWorkGuard = new DurableGraphAssignedWorkGuard(graphTaskOrchestration);
  const teamLifecycleService = new TeamLifecycleService({
    assignedWorkGuard: graphAssignedWorkGuard,
    lifecyclePublication,
  });
  const teamSessionLifecycleService = new TeamSessionLifecycleService(lifecyclePublication);
  const workerLaunchBridge = createWorkerLaunchBridge({
    buildWorkerArgv: (model, thinking, aggregatePath, projectTrusted) => {
      const argv = buildPiArgv(getPiLaunchArgv(), model, thinking);
      // A Worker loads the exact Pi Team Bright source while retaining normal
      // unrelated extension and Skill discovery.
      argv.push("-e", hostEnv().process.env.PI_TEAM_BRIGHT_SHIPPED_EXTENSION || __filename);
      return buildPiArgv(argv, undefined, undefined, aggregatePath, projectTrusted);
    },
    // The launch adapter reads saved trust when no leader context is available.
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
    const modelToolTeam = new DurableModelToolTeamApplication(modelToolBindings, workerLaunchBridge, lifecycle);
    const modelToolTask = new DurableModelToolTaskApplication(modelToolBindings, graphTaskOrchestration);
    const modelToolAlert = new DurableModelToolAlertApplication(modelToolBindings, alertSender);
    const modelToolCoordination = new DurableModelToolCoordinationApplication(modelToolBindings, coordinationObservationService);
    modelToolJourney = registerModelToolJourney(pi, new ModelToolJourneyFacade(modelToolTeam, modelToolTask, modelToolAlert, modelToolCoordination));
  }

  function modelToolBranchIds(ctx: ExtensionContext): string[] {
    return ctx.sessionManager.getBranch().map((entry) => entry.id);
  }

  if (modelToolJourney) {
    pi.on("tool_call", (_event, ctx) => {
      if (sessionAdapter.isTeammate()) return;
      modelToolJourney.port.coordination.setBranchEntries?.(
        exactLeaderSessionId(ctx.sessionManager.getSessionId()), ctx.sessionManager.getBranch(),
      );
    });
  }

  function alertToolProjection() {
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
        ? WorkerAlertSendParametersSchema
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
    graphTaskAuthority,
    teamQuery: piSessionTeamQuery,
    leaderToolNames,
    workerToolNames,
    refreshAlertToolProjection,
    registerRecoveredWorkerTools,
    taskReadyReconciliation: {
      reconcileReady: (team, worker) => graphTaskOrchestration.reconcileReady(team, worker),
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
      parameters: WorkerTaskReadParametersSchema,
      async execute(_toolCallId, params: { task_id: string }, _signal, _onUpdate, ctx) {
        const binding = await sessionAdapter.resolveCurrentWorkerContext(ctx);
        try {
          const task = (await graphTaskOrchestration.readTasks(binding.teamName, [params.task_id]))[0];
          return assembleToolResult("task_read", {
            kind: "task_read_batch",
            outcomes: [task
              ? { kind: "found", input_index: 0, task_id: task.id, task }
              : { kind: "missing", input_index: 0, task_id: params.task_id, reason: "task_not_found", state_changed: false }],
          } as any);
        } catch (error) {
          return assembleToolResult("task_read", { kind: "unavailable", reason: "task_authority_unavailable", message: error instanceof Error ? error.message : String(error), state_changed: false });
        }
      },
    });

    registerWorkerTool({
      name: "task_update",
      label: "Update Task",
      description: "Apply one explicit graph-native Task transition with an exact Task version. dependency_waiting and ready are derived.",
      parameters: GraphTaskUpdateParametersSchema,
      async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
        const binding = await sessionAdapter.resolveCurrentWorkerContext(ctx);
        {
          const result = await graphTaskOrchestration.transition(binding.teamName, {
            taskId: params.task_id,
            operationId: params.operation_id,
            expectedVersion: params.expected_version,
            ...(params.transition ? { transition: params.transition } : {}),
            ...(params.current_context ? { currentContext: params.current_context } : {}),
            ...(params.evidence ? { evidence: params.evidence } : {}),
            ...(params.transition && params.transition !== "cancel" ? { worker: binding.member.name } : {}),
          }, binding.member.name, { agentName: binding.member.name, membershipId: binding.member.membershipId!, sessionFile: binding.member.sessionFile! });
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
              : result.kind === "unavailable"
                ? { kind: "unavailable", input_index: 0, task_id: result.taskId, operation_id: result.operationId, reason: result.reason, message: result.message, state_changed: false }
                : { kind: "unknown_outcome", input_index: 0, task_id: result.taskId, operation_id: result.operationId, message: result.message };
          return assembleToolResult("task_update", outcome as any);
        }
      },
    });

    const alertRegistration = {
      name: "alert_send",
      label: "Send Alert",
      description: "Send exceptional clarification or attention to team-lead. Accepted means stored, not presented or processed.",
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
          return assembleToolResult("alert_send", { kind: "alert_sent", alert_id: result.alertId, accepted_recipients: result.accepted.map((item) => item.recipient), failed_recipients: result.failures.map((item) => item.recipient), ...(result.deliveryDegraded?.length ? { delivery_degraded: result.deliveryDegraded } : {}), task_state_changed: false });
        } catch (error) {
          return assembleToolResult("alert_send", { kind: "refused", reason: "no_eligible_recipients", message: error instanceof Error ? error.message : String(error), state_changed: false });
        }
      },
    };
    registerWorkerTool(alertRegistration as any);
  }
  registerWorkerSemanticTools();
}
