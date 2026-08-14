import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { captureQualifiedAvailableModelKeys } from "../utils/worker-resource-projection";
import {
  EnsureWorkerParametersSchema,
  TaskCreateParametersSchema,
  TaskReadParametersSchema,
  TaskUpdateParametersSchema,
  TeamCreateParametersSchema,
  TeamSyncParametersSchema,
  WorkerStopParametersSchema,
  TeamShutdownParametersSchema,
  AlertSendParametersSchema,
  modelToolCatalog,
} from "./catalog";
import {
  createModelToolJourneyExecutors,
  type EnsureWorkerResult,
  type TaskCreateResult,
  type TaskReadResult,
  type TaskUpdateResult,
  type TeamCreateResult,
  type TeamSyncResult,
  type WorkerStopResult,
  type TeamShutdownResult,
  type AlertSendResult,
  type ModelToolJourneyExecutors,
} from "./executors";
import { InMemoryModelToolTeamPort } from "./in-memory-team-port";
import { exactLeaderSessionId, type ModelToolTeamPort } from "./model-tool-contracts";
import type { ModelToolJourneyPort } from "./model-tool-journey-port";
import { assembleToolResult } from "./result-projection";
import { createToolResultRenderer } from "./tui-projection";
import { withSemanticTrace } from "../utils/trace";

function catalogEntry(name: "team_create" | "team_sync" | "ensure_worker" | "task_graph_apply" | "task_read" | "task_update" | "worker_stop" | "team_shutdown" | "alert_send") {
  const entry = modelToolCatalog.tools.find((tool) => tool.name === name);
  if (!entry) throw new Error(`Model tool catalog has no ${name} entry.`);
  return entry;
}

const teamCreateCatalogEntry = catalogEntry("team_create");
const teamSyncCatalogEntry = catalogEntry("team_sync");
const ensureWorkerCatalogEntry = catalogEntry("ensure_worker");
const taskCreateCatalogEntry = catalogEntry("task_graph_apply");
const taskReadCatalogEntry = catalogEntry("task_read");
const taskUpdateCatalogEntry = catalogEntry("task_update");
const workerStopCatalogEntry = catalogEntry("worker_stop");
const teamShutdownCatalogEntry = catalogEntry("team_shutdown");
const alertSendCatalogEntry = catalogEntry("alert_send");

export interface RegisteredModelToolJourney {
  port: ModelToolJourneyPort;
  executors: ModelToolJourneyExecutors;
}

/** Capture shape shared by Pi's generic API and provider-schema probes. */
export interface ModelToolRegistration {
  name: string;
  parameters: unknown;
  execute: (...arguments_: any[]) => Promise<any>;
}

/** Minimal foreign adapter seam implemented by Pi's ExtensionAPI. */
export interface ModelToolRegistrationSink {
  registerTool(tool: ModelToolRegistration): void;
}

type Assert<T extends true> = T;
type PiRegistrationCompatibility = Assert<ExtensionAPI extends ModelToolRegistrationSink ? true : false>;

/** Register only the accepted first model-tool journey against one runtime port. */
export function registerModelToolJourney(
  pi: ModelToolRegistrationSink,
  port: ModelToolJourneyPort | ModelToolTeamPort = new InMemoryModelToolTeamPort(),
): RegisteredModelToolJourney {
  const journeyPort = "team" in port
    ? port as ModelToolJourneyPort
    : { team: port as any, task: port as any, alert: port as any, coordination: port as any } satisfies ModelToolJourneyPort;
  const executors = createModelToolJourneyExecutors(journeyPort);
  const leaderSessionId = (ctx: {
    sessionManager: { getSessionId?: () => string; getSessionFile?: () => string | undefined };
    cwd?: string;
    isProjectTrusted?: () => unknown;
  }) => {
    const sessionFile = ctx.sessionManager.getSessionFile?.();
    const rawSessionId = ctx.sessionManager.getSessionId?.() ?? sessionFile;
    if (!rawSessionId) throw new Error("A durable Pi Session identity is required for the model-tool surface.");
    const exact = exactLeaderSessionId(rawSessionId);
    if (sessionFile) journeyPort.team.setLeaderSessionFile?.(exact, sessionFile);
    let projectTrusted: boolean | undefined;
    try {
      const trust = ctx.isProjectTrusted?.();
      projectTrusted = typeof trust === "boolean" ? trust : undefined;
    } catch {
      projectTrusted = undefined;
    }
    journeyPort.team.setLeaderLaunchContext?.(exact, {
      cwd: ctx.cwd ?? process.cwd(),
      projectTrusted,
    });
    return exact;
  };

  const teamCreateTool: ToolDefinition<
    typeof TeamCreateParametersSchema,
    TeamCreateResult
  > = {
    name: "team_create",
    label: teamCreateCatalogEntry.label,
    description: teamCreateCatalogEntry.responsibility,
    renderResult: createToolResultRenderer("team_create"),
    parameters: TeamCreateParametersSchema,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      const result = await executors.teamCreate(
        leaderSessionId(ctx),
        parameters,
      );
      return assembleToolResult("team_create", result);
    },
  };
  pi.registerTool(teamCreateTool);

  const teamSyncTool: ToolDefinition<
    typeof TeamSyncParametersSchema,
    TeamSyncResult
  > = {
    name: "team_sync",
    label: teamSyncCatalogEntry.label,
    description: teamSyncCatalogEntry.responsibility,
    renderResult: createToolResultRenderer("team_sync"),
    parameters: TeamSyncParametersSchema,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      const result = await executors.teamSync(
        leaderSessionId(ctx),
        parameters,
        _signal,
        _toolCallId,
      );
      return assembleToolResult("team_sync", result);
    },
  };
  pi.registerTool(teamSyncTool);

  const ensureWorkerTool: ToolDefinition<
    typeof EnsureWorkerParametersSchema,
    EnsureWorkerResult
  > = {
    name: "ensure_worker",
    label: ensureWorkerCatalogEntry.label,
    description: ensureWorkerCatalogEntry.responsibility,
    renderResult: createToolResultRenderer("ensure_worker"),
    parameters: EnsureWorkerParametersSchema,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      return withSemanticTrace("ensure_worker", { workerName: parameters.name }, async () => {
        const availableModelKeys = captureQualifiedAvailableModelKeys(ctx.modelRegistry);
        const result = await executors.ensureWorker(
          leaderSessionId(ctx),
          parameters,
          availableModelKeys ? { availableModelKeys } : undefined,
        );
        return assembleToolResult("ensure_worker", result);
      });
    },
  };
  pi.registerTool(ensureWorkerTool);

  const taskCreateTool: ToolDefinition<
    typeof TaskCreateParametersSchema,
    TaskCreateResult
  > = {
    name: "task_graph_apply",
    label: taskCreateCatalogEntry.label,
    description: taskCreateCatalogEntry.responsibility,
    renderResult: createToolResultRenderer("task_graph_apply"),
    parameters: TaskCreateParametersSchema,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      const result = await executors.taskCreate(
        leaderSessionId(ctx),
        parameters,
      );
      return assembleToolResult("task_graph_apply", result);
    },
  };
  pi.registerTool(taskCreateTool);

  const taskReadTool: ToolDefinition<
    typeof TaskReadParametersSchema,
    TaskReadResult
  > = {
    name: "task_read",
    label: taskReadCatalogEntry.label,
    description: taskReadCatalogEntry.responsibility,
    renderResult: createToolResultRenderer("task_read"),
    parameters: TaskReadParametersSchema,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      const result = await executors.taskRead(
        leaderSessionId(ctx),
        parameters,
      );
      return assembleToolResult("task_read", result);
    },
  };
  pi.registerTool(taskReadTool);

  const taskUpdateTool: ToolDefinition<
    typeof TaskUpdateParametersSchema,
    TaskUpdateResult
  > = {
    name: "task_update",
    label: taskUpdateCatalogEntry.label,
    description: taskUpdateCatalogEntry.responsibility,
    renderResult: createToolResultRenderer("task_update"),
    parameters: TaskUpdateParametersSchema,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      const result = await executors.taskUpdate(
        leaderSessionId(ctx),
        parameters,
      );
      return assembleToolResult("task_update", result);
    },
  };
  pi.registerTool(taskUpdateTool);

  const workerStopTool: ToolDefinition<typeof WorkerStopParametersSchema, WorkerStopResult> = {
    name: "worker_stop",
    label: workerStopCatalogEntry.label,
    description: workerStopCatalogEntry.responsibility,
    renderResult: createToolResultRenderer("worker_stop"),
    parameters: WorkerStopParametersSchema,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      return assembleToolResult("worker_stop", await executors.workerStop(leaderSessionId(ctx), parameters));
    },
  };
  pi.registerTool(workerStopTool);

  const teamShutdownTool: ToolDefinition<typeof TeamShutdownParametersSchema, TeamShutdownResult> = {
    name: "team_shutdown",
    label: teamShutdownCatalogEntry.label,
    description: teamShutdownCatalogEntry.responsibility,
    renderResult: createToolResultRenderer("team_shutdown"),
    parameters: TeamShutdownParametersSchema,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      return assembleToolResult("team_shutdown", await executors.teamShutdown(leaderSessionId(ctx), parameters));
    },
  };
  pi.registerTool(teamShutdownTool);

  const alertSendTool: ToolDefinition<typeof AlertSendParametersSchema, AlertSendResult> = {
    name: "alert_send",
    label: alertSendCatalogEntry.label,
    description: alertSendCatalogEntry.responsibility,
    renderResult: createToolResultRenderer("alert_send"),
    parameters: AlertSendParametersSchema,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      return assembleToolResult("alert_send", await executors.alertSend(leaderSessionId(ctx), parameters));
    },
  };
  pi.registerTool(alertSendTool);

  return { port: journeyPort, executors };
}
