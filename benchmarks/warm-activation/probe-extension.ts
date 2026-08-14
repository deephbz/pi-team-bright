import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Disposable benchmark probe. Its output stays in a runner-created temporary
 * directory. The committed result contains only derived booleans and timings.
 */
const moduleInstance = randomUUID();
let factoryCount = 0;
let moduleCommandCount = 0;

const leaderOnlyToolNames = ["team_create", "ensure_worker", "worker_stop", "team_shutdown"];
const commonTaskToolNames = ["task_read", "task_update", "alert_send"];
const teamEnvironmentNames = [
  "PI_TEAM_NAME",
  "PI_AGENT_NAME",
  "PI_TEAM_MEMBERSHIP_ID",
  "PI_AGENT_LAUNCH_ID",
  "PI_TEAM_BRIGHT_WORKER_AGGREGATE",
  "PI_TEAM_BRIGHT_MODEL_TOOL",
];

function markerFromSystemPrompt(ctx: any): string | "absent" {
  try {
    const prompt = typeof ctx?.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "";
    const marker = /WARM_ACTIVATION_CONTEXT=([A-Z0-9_-]+)/.exec(prompt)?.[1];
    return marker || "absent";
  } catch {
    return "absent";
  }
}

function toolNames(pi: ExtensionAPI): string[] {
  try {
    return [...new Set(pi.getActiveTools?.() ?? [])].sort();
  } catch {
    return [];
  }
}

function modelLabel(ctx: any): string | "absent" {
  const provider = typeof ctx?.model?.provider === "string" ? ctx.model.provider : undefined;
  const id = typeof ctx?.model?.id === "string" ? ctx.model.id : undefined;
  return provider && id ? `${provider}/${id}` : "absent";
}

function sameDirectory(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return left === right;
  }
}

function writeRecord(record: Record<string, unknown>): void {
  const target = process.env.WARM_ACTIVATION_RECORD_PATH;
  if (!target) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.appendFileSync(target, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // A benchmark probe must not change Pi behavior if its private output fails.
  }
}

export default function warmActivationProbe(pi: ExtensionAPI): void {
  const factoryGeneration = ++factoryCount;
  let closureCommandCount = 0;

  const snapshot = (event: string, ctx: any, reason?: string) => {
    const activeTools = toolNames(pi);
    const expectedCwd = process.env.WARM_ACTIVATION_EXPECTED_CWD;
    const expectedModel = process.env.WARM_ACTIVATION_EXPECTED_MODEL;
    const observedModel = modelLabel(ctx);
    const contextCwd = typeof ctx?.cwd === "string" ? ctx.cwd : undefined;
    const processCwd = process.cwd();
    writeRecord({
      schema: "pi-team-bright/warm-activation-probe/1",
      event,
      ...(reason ? { reason } : {}),
      monotonic_ms: Math.round(performance.now() * 1000) / 1000,
      process_id: process.pid,
      rss_bytes: process.memoryUsage().rss,
      module_instance: moduleInstance,
      factory_generation: factoryGeneration,
      module_command_count: moduleCommandCount,
      closure_command_count: closureCommandCount,
      session_present: typeof ctx?.sessionManager?.getSessionId === "function",
      cwd_matches_expected: expectedCwd ? sameDirectory(contextCwd, expectedCwd) && sameDirectory(processCwd, expectedCwd) : false,
      context_cwd_matches_expected: expectedCwd ? sameDirectory(contextCwd, expectedCwd) : false,
      process_cwd_matches_expected: expectedCwd ? sameDirectory(processCwd, expectedCwd) : false,
      cwd_comparison: "canonical_realpath",
      context_marker: markerFromSystemPrompt(ctx),
      model: observedModel,
      model_matches_expected: expectedModel ? observedModel === expectedModel : false,
      active_tool_count: activeTools.length,
      has_leader_only_tools: leaderOnlyToolNames.some((name) => activeTools.includes(name)),
      active_common_task_tools: commonTaskToolNames.filter((name) => activeTools.includes(name)).length,
      team_environment_present: Object.fromEntries(teamEnvironmentNames.map((name) => [name, Boolean(process.env[name])])),
    });
  };

  pi.on("session_start", async (event, ctx) => {
    snapshot("session_start", ctx, event.reason);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    snapshot("session_shutdown", ctx, event.reason);
  });

  pi.registerCommand("warm-activation-probe", {
    description: "Record a disposable warm-activation benchmark marker.",
    handler: async (_args, ctx) => {
      moduleCommandCount += 1;
      closureCommandCount += 1;
      snapshot("activation_command", ctx);
    },
  });

  pi.registerCommand("warm-activation-shutdown", {
    description: "Gracefully stop a disposable warm-activation benchmark carrier.",
    handler: async (_args, ctx) => {
      snapshot("shutdown_command", ctx);
      ctx.shutdown();
    },
  });
}
