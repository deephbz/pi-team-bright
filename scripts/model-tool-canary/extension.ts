import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, chmodSync, openSync, statSync } from "node:fs";
import {
  CandidateEnsureWorkerParametersSchema,
  CandidateEnsureWorkerResultSchema,
  CandidateTaskCreateParametersSchema,
  CandidateTaskCreateResultSchema,
  CandidateTaskReadParametersSchema,
  CandidateTaskReadResultSchema,
  CandidateTaskUpdateParametersSchema,
  CandidateTaskUpdateResultSchema,
  CandidateTeamCreateParametersSchema,
  CandidateTeamCreateResultSchema,
  CandidateTeamSyncParametersSchema,
  CandidateTeamSyncResultSchema,
} from "../../src/model-tool-contract/catalog";
import { exactLeaderSessionId, registerModelToolJourney } from "../../src/model-tool-contract/runtime";

const CAPTURE_ENVIRONMENT = "PI_MODEL_TOOL_CANARY_CAPTURE";
const capturePath = process.env[CAPTURE_ENVIRONMENT];

if (!capturePath) {
  throw new Error(`${CAPTURE_ENVIRONMENT} must name the private canary capture file.`);
}

const captureDescriptor = openSync(capturePath, "a", 0o600);
chmodSync(capturePath, 0o600);
if ((statSync(capturePath).mode & 0o777) !== 0o600) {
  throw new Error("Canary capture file must have mode 0600.");
}

let sequence = 0;

function writeRecord(kind: string, data: Record<string, unknown> = {}): void {
  appendFileSync(captureDescriptor, `${JSON.stringify({
    schema: "pi-team-bright-model-tool-canary-raw/1",
    sequence: ++sequence,
    at: new Date().toISOString(),
    kind,
    ...data,
  })}\n`, "utf8");
}

function sessionEvidence(ctx: ExtensionContext): Record<string, unknown> {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    provider: ctx.model?.provider,
    model: ctx.model?.id,
  };
}

function branchIds(ctx: ExtensionContext): string[] {
  return ctx.sessionManager.getBranch().map((entry) => entry.id);
}

function containsExact(value: unknown, target: string): boolean {
  if (value === target) return true;
  if (Array.isArray(value)) return value.some((item) => containsExact(item, target));
  if (value && typeof value === "object") return Object.values(value).some((item) => containsExact(item, target));
  return false;
}

function persistedToolResult(ctx: ExtensionContext, toolCallId: string, resultText: string): string | undefined {
  const entry = ctx.sessionManager.getBranch().find((candidate) => {
    if (candidate.type !== "message") return false;
    const message = candidate.message;
    return message.role === "toolResult"
      && message.toolCallId === toolCallId
      && message.content.some((part) => part.type === "text" && part.text === resultText);
  });
  return entry?.id;
}

writeRecord("catalog", {
  tools: [
    {
      name: "team_create",
      parameters: CandidateTeamCreateParametersSchema,
      result: CandidateTeamCreateResultSchema,
    },
    {
      name: "ensure_worker",
      parameters: CandidateEnsureWorkerParametersSchema,
      result: CandidateEnsureWorkerResultSchema,
    },
    {
      name: "task_create",
      parameters: CandidateTaskCreateParametersSchema,
      result: CandidateTaskCreateResultSchema,
    },
    {
      name: "task_read",
      parameters: CandidateTaskReadParametersSchema,
      result: CandidateTaskReadResultSchema,
    },
    {
      name: "task_update",
      parameters: CandidateTaskUpdateParametersSchema,
      result: CandidateTaskUpdateResultSchema,
    },
    {
      name: "team_sync",
      parameters: CandidateTeamSyncParametersSchema,
      result: CandidateTeamSyncResultSchema,
    },
  ],
});

export default function modelToolCanaryExtension(pi: ExtensionAPI): void {
  const journey = registerModelToolJourney(pi);
  const debugRevision = () => journey.port.readDebugRevision?.();

  pi.on("session_start", (event, ctx) => {
    writeRecord("session_start", { ...sessionEvidence(ctx), reason: event.reason });
  });

  pi.on("before_provider_request", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const ids = branchIds(ctx);
    journey.port.setBranchContext(exactLeaderSessionId(sessionId), ids);
    const pending = journey.port.getPendingObservation?.(exactLeaderSessionId(sessionId));
    let acknowledged = false;
    if (pending && containsExact(event.payload, pending.resultText)) {
      const entryId = persistedToolResult(ctx, pending.toolCallId, pending.resultText);
      if (entryId) acknowledged = journey.port.acknowledgePendingObservation(exactLeaderSessionId(sessionId), entryId, ids);
    }
    writeRecord("before_provider_request", {
      ...sessionEvidence(ctx),
      payload: event.payload,
      observationAcknowledged: acknowledged,
    });
  });

  pi.on("after_provider_response", (event, ctx) => {
    // Never capture response headers. They can contain private request and
    // network identifiers. The status is the bounded pre-stream anchor.
    writeRecord("after_provider_response", {
      ...sessionEvidence(ctx),
      status: event.status,
    });
  });

  pi.on("tool_call", (event, ctx) => {
    if (!["team_create", "ensure_worker", "task_create", "task_read", "task_update", "team_sync"].includes(event.toolName)) return;
    const sessionId = ctx.sessionManager.getSessionId();
    journey.port.setBranchContext(sessionId as never, branchIds(ctx));
    writeRecord("tool_call", {
      ...sessionEvidence(ctx),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      debugRevision: debugRevision(),
    });
  });

  pi.on("tool_result", (event, ctx) => {
    if (!["team_create", "ensure_worker", "task_create", "task_read", "task_update", "team_sync"].includes(event.toolName)) return;
    writeRecord("tool_result", {
      ...sessionEvidence(ctx),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      content: event.content,
      details: event.details,
      isError: event.isError,
      debugRevision: debugRevision(),
    });
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    writeRecord("assistant_message_end", {
      ...sessionEvidence(ctx),
      role: event.message.role,
      stopReason: event.message.stopReason,
      usage: {
        input: event.message.usage?.input,
        output: event.message.usage?.output,
        totalTokens: event.message.usage?.totalTokens,
        costTotal: event.message.usage?.cost?.total,
      },
    });
  });

  pi.on("agent_settled", (_event, ctx) => {
    writeRecord("agent_settled", sessionEvidence(ctx));
  });

  pi.on("session_shutdown", (event, ctx) => {
    writeRecord("session_shutdown", { ...sessionEvidence(ctx), reason: event.reason });
  });
}
