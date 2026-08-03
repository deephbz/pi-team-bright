import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  CandidateEnsureWorkerParametersSchema,
  CandidateTaskCreateParametersSchema,
  CandidateTaskReadParametersSchema,
  CandidateTaskUpdateParametersSchema,
  CandidateTeamCreateParametersSchema,
  CandidateTeamSyncParametersSchema,
  CandidateWorkerStopParametersSchema,
  CandidateTeamShutdownParametersSchema,
  CandidateTaskLinkParametersSchema,
  CandidateAlertSendParametersSchema,
  candidateModelToolCatalog,
} from "./catalog";
import {
  createModelToolJourneyExecutors,
  type CandidateEnsureWorkerResult,
  type CandidateTaskCreateResult,
  type CandidateTaskReadResult,
  type CandidateTaskUpdateResult,
  type CandidateTeamCreateResult,
  type CandidateTeamSyncResult,
  type CandidateWorkerStopResult,
  type CandidateTeamShutdownResult,
  type CandidateTaskLinkResult,
  type CandidateAlertSendResult,
  type ModelToolJourneyExecutors,
} from "./executors";
import {
  exactLeaderSessionId,
  InMemoryModelToolTeamPort,
  type ModelToolTeamPort,
} from "./in-memory-team-port";
import { assembleCandidateToolResult } from "./result-projection";
import { createCandidateToolResultRenderer } from "./tui-projection";

function catalogEntry(name: "team_create" | "team_sync" | "ensure_worker" | "task_create" | "task_read" | "task_update" | "worker_stop" | "team_shutdown" | "task_link" | "alert_send") {
  const entry = candidateModelToolCatalog.tools.find((tool) => tool.name === name);
  if (!entry) throw new Error(`Candidate model-tool catalog has no ${name} entry.`);
  return entry;
}

const teamCreateCatalogEntry = catalogEntry("team_create");
const teamSyncCatalogEntry = catalogEntry("team_sync");
const ensureWorkerCatalogEntry = catalogEntry("ensure_worker");
const taskCreateCatalogEntry = catalogEntry("task_create");
const taskReadCatalogEntry = catalogEntry("task_read");
const taskUpdateCatalogEntry = catalogEntry("task_update");
const workerStopCatalogEntry = catalogEntry("worker_stop");
const teamShutdownCatalogEntry = catalogEntry("team_shutdown");
const taskLinkCatalogEntry = catalogEntry("task_link");
const alertSendCatalogEntry = catalogEntry("alert_send");

export interface RegisteredModelToolJourney {
  port: ModelToolTeamPort;
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
  port: ModelToolTeamPort = new InMemoryModelToolTeamPort(),
): RegisteredModelToolJourney {
  const executors = createModelToolJourneyExecutors(port);
  const leaderSessionId = (ctx: { sessionManager: { getSessionId?: () => string; getSessionFile?: () => string | undefined } }) => {
    const sessionFile = ctx.sessionManager.getSessionFile?.();
    const rawSessionId = ctx.sessionManager.getSessionId?.() ?? sessionFile;
    if (!rawSessionId) throw new Error("A durable Pi Session identity is required for the model-tool surface.");
    const exact = exactLeaderSessionId(rawSessionId);
    if (sessionFile) port.setLeaderSessionFile?.(exact, sessionFile);
    return exact;
  };

  const teamCreateTool: ToolDefinition<
    typeof CandidateTeamCreateParametersSchema,
    CandidateTeamCreateResult
  > = {
    name: "team_create",
    label: teamCreateCatalogEntry.label,
    description: teamCreateCatalogEntry.responsibility,
    renderResult: createCandidateToolResultRenderer("team_create"),
    parameters: CandidateTeamCreateParametersSchema,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      const result = await executors.teamCreate(
        leaderSessionId(ctx),
        parameters,
      );
      return assembleCandidateToolResult("team_create", result);
    },
  };
  pi.registerTool(teamCreateTool);

  const teamSyncTool: ToolDefinition<
    typeof CandidateTeamSyncParametersSchema,
    CandidateTeamSyncResult
  > = {
    name: "team_sync",
    label: teamSyncCatalogEntry.label,
    description: teamSyncCatalogEntry.responsibility,
    renderResult: createCandidateToolResultRenderer("team_sync"),
    parameters: CandidateTeamSyncParametersSchema,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      const result = await executors.teamSync(
        leaderSessionId(ctx),
        parameters,
        _signal,
        _toolCallId,
      );
      return assembleCandidateToolResult("team_sync", result);
    },
  };
  pi.registerTool(teamSyncTool);

  const ensureWorkerTool: ToolDefinition<
    typeof CandidateEnsureWorkerParametersSchema,
    CandidateEnsureWorkerResult
  > = {
    name: "ensure_worker",
    label: ensureWorkerCatalogEntry.label,
    description: ensureWorkerCatalogEntry.responsibility,
    renderResult: createCandidateToolResultRenderer("ensure_worker"),
    parameters: CandidateEnsureWorkerParametersSchema,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      const result = await executors.ensureWorker(
        leaderSessionId(ctx),
        parameters,
      );
      return assembleCandidateToolResult("ensure_worker", result);
    },
  };
  pi.registerTool(ensureWorkerTool);

  const taskCreateTool: ToolDefinition<
    typeof CandidateTaskCreateParametersSchema,
    CandidateTaskCreateResult
  > = {
    name: "task_create",
    label: taskCreateCatalogEntry.label,
    description: taskCreateCatalogEntry.responsibility,
    renderResult: createCandidateToolResultRenderer("task_create"),
    parameters: CandidateTaskCreateParametersSchema,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      const result = await executors.taskCreate(
        leaderSessionId(ctx),
        parameters,
      );
      return assembleCandidateToolResult("task_create", result);
    },
  };
  pi.registerTool(taskCreateTool);

  const taskReadTool: ToolDefinition<
    typeof CandidateTaskReadParametersSchema,
    CandidateTaskReadResult
  > = {
    name: "task_read",
    label: taskReadCatalogEntry.label,
    description: taskReadCatalogEntry.responsibility,
    renderResult: createCandidateToolResultRenderer("task_read"),
    parameters: CandidateTaskReadParametersSchema,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      const result = await executors.taskRead(
        leaderSessionId(ctx),
        parameters,
      );
      return assembleCandidateToolResult("task_read", result);
    },
  };
  pi.registerTool(taskReadTool);

  const taskUpdateTool: ToolDefinition<
    typeof CandidateTaskUpdateParametersSchema,
    CandidateTaskUpdateResult
  > = {
    name: "task_update",
    label: taskUpdateCatalogEntry.label,
    description: taskUpdateCatalogEntry.responsibility,
    renderResult: createCandidateToolResultRenderer("task_update"),
    parameters: CandidateTaskUpdateParametersSchema,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      const result = await executors.taskUpdate(
        leaderSessionId(ctx),
        parameters,
      );
      return assembleCandidateToolResult("task_update", result);
    },
  };
  pi.registerTool(taskUpdateTool);

  const workerStopTool: ToolDefinition<typeof CandidateWorkerStopParametersSchema, CandidateWorkerStopResult> = {
    name: "worker_stop",
    label: workerStopCatalogEntry.label,
    description: workerStopCatalogEntry.responsibility,
    renderResult: createCandidateToolResultRenderer("worker_stop"),
    parameters: CandidateWorkerStopParametersSchema,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      return assembleCandidateToolResult("worker_stop", await executors.workerStop(leaderSessionId(ctx), parameters));
    },
  };
  pi.registerTool(workerStopTool);

  const teamShutdownTool: ToolDefinition<typeof CandidateTeamShutdownParametersSchema, CandidateTeamShutdownResult> = {
    name: "team_shutdown",
    label: teamShutdownCatalogEntry.label,
    description: teamShutdownCatalogEntry.responsibility,
    renderResult: createCandidateToolResultRenderer("team_shutdown"),
    parameters: CandidateTeamShutdownParametersSchema,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      return assembleCandidateToolResult("team_shutdown", await executors.teamShutdown(leaderSessionId(ctx), parameters));
    },
  };
  pi.registerTool(teamShutdownTool);

  const taskLinkTool: ToolDefinition<typeof CandidateTaskLinkParametersSchema, CandidateTaskLinkResult> = {
    name: "task_link",
    label: taskLinkCatalogEntry.label,
    description: taskLinkCatalogEntry.responsibility,
    renderResult: createCandidateToolResultRenderer("task_link"),
    parameters: CandidateTaskLinkParametersSchema,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      return assembleCandidateToolResult("task_link", await executors.taskLink(leaderSessionId(ctx), parameters));
    },
  };
  pi.registerTool(taskLinkTool);

  const alertSendTool: ToolDefinition<typeof CandidateAlertSendParametersSchema, CandidateAlertSendResult> = {
    name: "alert_send",
    label: alertSendCatalogEntry.label,
    description: alertSendCatalogEntry.responsibility,
    renderResult: createCandidateToolResultRenderer("alert_send"),
    parameters: CandidateAlertSendParametersSchema,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      return assembleCandidateToolResult("alert_send", await executors.alertSend(leaderSessionId(ctx), parameters));
    },
  };
  pi.registerTool(alertSendTool);

  return { port, executors };
}
