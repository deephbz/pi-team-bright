import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import * as paths from "../src/utils/paths";
import * as teams from "../src/utils/teams";
import * as tasks from "../src/utils/tasks";
import * as messaging from "../src/utils/messaging";
import {
  DirectMessageDelivery,
  messagePollMs,
} from "../src/utils/message-delivery";
import {
  TaskChangeDelivery,
  taskPollMs,
} from "../src/utils/task-delivery";
import * as runtime from "../src/utils/runtime";
import { clearTeamFooter, syncTeamFooter } from "../src/utils/team-footer";
import { Member, TaskFile } from "../src/utils/models";
import { getTerminalAdapter } from "../src/adapters/terminal-registry";
import { Iterm2Adapter } from "../src/adapters/iterm2-adapter";
import * as predefined from "../src/utils/predefined-teams";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

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

export function buildPiArgv(base: string[], model?: string, thinking?: string, tools?: string[]): string[] {
  const argv = [...base];
  if (model) argv.push("--model", thinking ? `${model}:${thinking}` : model);
  else if (thinking) argv.push("--thinking", thinking);
  if (tools && tools.length > 0) argv.push("--tools", tools.join(","));
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

/** Register the current process and durable Pi session as a team's lead. */
function registerLeadSession(teamName: string, piSessionFile?: string) {
  const recordPath = paths.leadSessionPath(teamName);
  const dir = path.dirname(recordPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify({
    pid: process.pid,
    sessionFile: piSessionFile,
    startedAt: Date.now(),
  }));
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
    return JSON.stringify({
      task: {
        id: task.id,
        status: task.status,
        assignee: task.assignee ?? null,
        version: task.version,
      },
      appliedOperations,
      warnings,
    });
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
    return teams.assertCurrentSessionBinding(requestedTeam, agentName, sessionFile);
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
      if (teamName) {
        if (!piSessionFile) throw new Error("Teammate startup requires a durable Pi Session file.");
        const candidate = await teams.currentMembership(teamName, agentName);
        const bound = await teams.withMembershipMutationLease(teamName, candidate.membershipId!, async () => {
          const current = await teams.bindMemberSession(
            teamName!,
            agentName,
            piSessionFile,
            envLaunchId,
            process.env.TMUX_PANE ? { tmuxPaneId: process.env.TMUX_PANE } : {},
            candidate.membershipId,
          );
          // Process-generation publication is part of the lifecycle transition:
          // shutdown uses the same exact-Membership lease, so it observes either
          // the old generation or this complete replacement, never an interleave.
          await runtime.writeRuntimeStatus(teamName!, agentName, {
            pid: process.pid,
            startedAt: Date.now(),
            lastHeartbeatAt: Date.now(),
            ready: false,
            lastError: undefined,
          }, current.membershipId);
          return current;
        });
        currentMembershipId = bound.membershipId;
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
      // process. Refresh both volatile process identity and tmux location.
      if (teams.teamExists(teamName)) {
        const lead = await teams.assertCurrentSessionBinding(teamName, "team-lead", piSessionFile);
        currentMembershipId = lead.membershipId;
        registerLeadSession(teamName, piSessionFile);
        if (process.env.TMUX_PANE) {
          await teams.updateMembership(teamName, lead.membershipId!, { tmuxPaneId: process.env.TMUX_PANE });
        }
      }
      await startDirectMessageDelivery(ctx);
      await startTaskChangeDelivery(ctx);
    }
    await refreshTeamFooter(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
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
    if (stopReason === "error" || stopReason === "aborted") return;
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

  let firstTurn = true;
  pi.on("before_agent_start", async (event, ctx) => {
    if (isTeammate && firstTurn) {
      firstTurn = false;

      if (teamName) {
        await writeCurrentTeammateRuntime(ctx, {
          lastHeartbeatAt: Date.now(),
        });
      }

      let modelInfo = "";
      if (teamName) {
        try {
          const teamConfig = await teams.readConfig(teamName);
          const member = teamConfig.members.find(m => m.name === agentName);
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

      const inboxInstruction = directMessageSessionEligible
        ? "Direct Messages are delivered in context by stable Message ID. Do not call read_inbox merely to discover or fetch them; read_inbox remains available for explicit inspection."
        : "This fork is a new Session identity and is not bound to the source recipient inbox. Do not consume the source inbox.";
      const taskInstruction = taskChangeSessionEligible
        ? "Assigned Task changes are delivered in context by authority-scoped TaskChangeRef. Treat the payload as a versioned snapshot and re-read the Task authority before a conflicting write."
        : "This fork is a new Session identity and receives none of the source Agent's pending Task changes.";
      return {
        systemPrompt: event.systemPrompt + `\n\nYou are teammate '${agentName}' on team '${teamName}'.\nYour lead is 'team-lead'.${modelInfo}\n${inboxInstruction}\n${taskInstruction}`,
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

    if (!terminal) {
      throw new Error(`Cannot stop ${member.name}: no terminal adapter is available and no exact Membership-bound runtime record proves the process exited.`);
    }

    if (member.windowId) {
      terminal.killWindow(member.windowId);
      if (terminal.isWindowAlive(member.windowId)) {
        throw new Error(
          `Cannot confirm shutdown of ${member.name}: ${terminal.name} did not stop window ${member.windowId}. ` +
          "The Membership remains current; close the process manually and retry.",
        );
      }
      if (observedGeneration) await runtime.deleteRuntimeStatus(teamName, member.name, observedGeneration);
      return {
        kind: "terminal_window_stopped",
        adapter: terminal.name,
        target: member.windowId,
        membershipId: member.membershipId,
      };
    }

    if (member.tmuxPaneId) {
      terminal.kill(member.tmuxPaneId);
      if (terminal.isAlive(member.tmuxPaneId)) {
        throw new Error(
          `Cannot confirm shutdown of ${member.name}: ${terminal.name} did not stop pane ${member.tmuxPaneId}. ` +
          "The Membership remains current; close the process manually and retry.",
        );
      }
      if (observedGeneration) await runtime.deleteRuntimeStatus(teamName, member.name, observedGeneration);
      return {
        kind: "terminal_pane_stopped",
        adapter: terminal.name,
        target: member.tmuxPaneId,
        membershipId: member.membershipId,
      };
    }

    throw new Error(
      `Cannot stop ${member.name}: this Membership has no terminal binding and no exact Membership-bound runtime record proves the process exited. ` +
      "The Membership remains current.",
    );
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

  type PreparedLaunchTarget = { terminalId: string; isWindow: boolean };

  async function compensatePreparedLaunch(
    targetTeamName: string,
    prepared: Member,
    target: PreparedLaunchTarget | null,
  ): Promise<void> {
    if (!prepared.membershipId) throw new Error(`Prepared Membership for ${prepared.name} has no stable identity.`);
    await teams.withCurrentMembershipLease(targetTeamName, prepared.membershipId, async (current) => {
      if (target) {
        if (!terminal) throw new Error(`cannot stop ${target.terminalId}: no terminal adapter is available`);
        if (target.isWindow) {
          terminal.killWindow(target.terminalId);
          if (terminal.isWindowAlive(target.terminalId)) {
            throw new Error(`${terminal.name} did not stop window ${target.terminalId}`);
          }
        } else {
          terminal.kill(target.terminalId);
          if (terminal.isAlive(target.terminalId)) {
            throw new Error(`${terminal.name} did not stop pane ${target.terminalId}`);
          }
        }
        const status = await runtime.readRuntimeStatus(targetTeamName, current.name);
        const generation = exactRuntimeGeneration(current, status);
        if (generation) await runtime.deleteRuntimeStatus(targetTeamName, current.name, generation);
      }
      await teams.deactivateMembership(targetTeamName, prepared.membershipId!, "replaced");
    });
  }

  async function launchPreparedMembership(
    targetTeamName: string,
    prepared: Member,
    initialMessage: () => Promise<unknown>,
    spawn: () => PreparedLaunchTarget | Promise<PreparedLaunchTarget>,
  ): Promise<PreparedLaunchTarget> {
    let target: PreparedLaunchTarget | null = null;
    try {
      await initialMessage();
      target = await spawn();
      if (!target.terminalId) throw new Error("terminal adapter returned an empty target ID");
      await teams.updateMembership(
        targetTeamName,
        prepared.membershipId!,
        target.isWindow ? { windowId: target.terminalId } : { tmuxPaneId: target.terminalId },
      );
      return target;
    } catch (launchError) {
      try {
        await compensatePreparedLaunch(targetTeamName, prepared, target);
      } catch (cleanupError) {
        const targetText = target
          ? `${target.isWindow ? "window" : "pane"} ${target.terminalId}`
          : "the prepared Membership before terminal spawn";
        throw new Error(
          `Failed to launch ${prepared.name}: ${launchError instanceof Error ? launchError.message : String(launchError)}. `
          + `Compensation failed for ${targetText}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. `
          + "The Membership remains current because process shutdown could not be confirmed.",
        );
      }
      throw new Error(
        `Failed to launch ${prepared.name}: ${launchError instanceof Error ? launchError.message : String(launchError)}. `
        + "The exact prepared Membership was deactivated after compensation.",
      );
    }
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
      const leadSessionFile = ctx?.sessionManager?.getSessionFile?.();
      if (!leadSessionFile) throw new Error("team_create requires a durable Pi Session file.");
      const safeTeamName = paths.sanitizeName(params.team_name);
      return teams.withTeamTopologyLease(safeTeamName, async (topologyLease) => {
      const taskAuthority = await tasks.resolveTeamTaskAuthority(safeTeamName);
      const config = await teams.createTeam(
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
      );
      // Register this session as the lead so it can receive inbox messages.
      registerLeadSession(safeTeamName, leadSessionFile);
      // Update teamName and start native custom delivery for the lead.
      isTeammate = false;
      agentName = "team-lead";
      teamName = safeTeamName;
      currentMembershipId = config.members.find((member) => member.name === "team-lead" && member.isActive !== false)?.membershipId;
      await startDirectMessageDelivery(ctx);
      await startTaskChangeDelivery(ctx);
      await refreshTeamFooter(ctx);
      return {
        content: [{ type: "text", text: `Team ${safeTeamName} created.` }],
        details: { config },
      };
      });
    },
  });

  pi.registerTool({
    name: "spawn_teammate",
    label: "Spawn Teammate",
    description: "Spawn a new teammate in a terminal pane or separate window.",
    parameters: Type.Object({
      team_name: Type.String(),
      name: Type.String(),
      prompt: Type.String(),
      cwd: Type.String(),
      model: Type.Optional(Type.String({ description: "Model for this teammate. Omit this parameter to use the team or Pi default; set it only when the user explicitly requests a specific model." })),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"])),
      separate_window: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const safeName = paths.sanitizeName(params.name);
      const safeTeamName = paths.sanitizeName(params.team_name);

      if (safeName === "team-lead") {
        throw new Error("'team-lead' is reserved for the Team leader and cannot be used as a teammate name.");
      }

      return teams.withTeamTopologyLease(safeTeamName, async () => {
      // The caller may have become stale while waiting for another topology
      // transaction. Revalidate only after this Team's lease is held.
      await assertCurrentSessionBinding(ctx, safeTeamName);

      if (!teams.teamExists(safeTeamName)) {
        throw new Error(`Team ${params.team_name} does not exist`);
      }

      if (!terminal) {
        throw new Error("No terminal adapter detected.");
      }

      const teamConfig = await teams.readConfig(safeTeamName);
      
      // Check if a teammate with this name already exists - kill them first
      // This handles the case where the user aborts mid-execution and restarts
      const existingMember = [...teamConfig.members].reverse().find(m => m.name === safeName && m.agentType === "teammate" && m.isActive !== false);
      if (existingMember) {
        await transitionCurrentMembership(safeTeamName, existingMember, "replaced", true);
      }
      
      let chosenModel = params.model || teamConfig.defaultModel;

      // Resolve model to provider/model format
      if (chosenModel) {
        if (!chosenModel.includes('/')) {
          // Try to resolve using available models from pi --list-models
          const resolved = resolveModelWithProvider(chosenModel);
          if (resolved) {
            chosenModel = resolved;
          } else if (teamConfig.defaultModel && teamConfig.defaultModel.includes('/')) {
            // Fall back to team default provider
            const [provider] = teamConfig.defaultModel.split('/');
            chosenModel = `${provider}/${chosenModel}`;
          }
        }
      }

      const useSeparateWindow = params.separate_window ?? teamConfig.separateWindows ?? false;
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
        tmuxPaneId: "",
        cwd: params.cwd,
        subscriptions: [],
        isActive: true,
        prompt: params.prompt,
        color: "blue",
        thinking: params.thinking,
      };

      await teams.addMember(safeTeamName, member);

      const agentDef = predefined.getAgentDefinition(safeName, params.cwd);
      const piCmd = buildPiArgv(getPiLaunchArgv(), chosenModel, params.thinking, agentDef?.tools);

      const env: Record<string, string> = {
        ...process.env,
        PI_TEAM_NAME: safeTeamName,
        PI_AGENT_NAME: safeName,
        PI_AGENT_LAUNCH_ID: member.pendingLaunchId!,
      };

      const launch = await launchPreparedMembership(
        safeTeamName,
        member,
        () => messaging.sendPlainMessage(safeTeamName, "team-lead", safeName, params.prompt, "Initial prompt"),
        () => {
        if (useSeparateWindow) {
          const terminalId = terminal.spawnWindow({
            name: safeName,
            cwd: params.cwd,
            argv: piCmd,
            env: env,
            teamName: safeTeamName,
          });
          return { terminalId, isWindow: true };
        }
        if (terminal instanceof Iterm2Adapter) {
          const teammates = teamConfig.members.filter(m => m.agentType === "teammate" && m.tmuxPaneId.startsWith("iterm_"));
          const lastTeammate = teammates.length > 0 ? teammates[teammates.length - 1] : null;
          if (lastTeammate?.tmuxPaneId) {
            terminal.setSpawnContext({ lastSessionId: lastTeammate.tmuxPaneId.replace("iterm_", "") });
          } else {
            terminal.setSpawnContext({});
          }
        }

        const leadMember = teamConfig.members.find(m => m.name === "team-lead");
        const anchorPaneId = terminal.name === "tmux"
          ? leadMember?.tmuxPaneId || process.env.TMUX_PANE || undefined
          : undefined;

        const terminalId = terminal.spawn({
          name: safeName,
          cwd: params.cwd,
          argv: piCmd,
          env: env,
          anchorPaneId,
        });
        return { terminalId, isWindow: false };
        },
      );

      return {
        content: [{ type: "text", text: `Teammate ${params.name} spawned in ${launch.isWindow ? 'window' : 'pane'} ${launch.terminalId}.` }],
        details: { agentId: member.agentId, membershipId: member.membershipId, terminalId: launch.terminalId, isWindow: launch.isWindow },
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
    name: "task_create",
    label: "Create Task",
    description: "Create a team Task and return its post-state receipt; do not immediately task_read or task_list the same result.",
    parameters: Type.Object({
      team_name: Type.String(),
      title: Type.String(),
      description: Type.String(),
      design: Type.Optional(Type.String()),
      assignee: Type.Optional(Type.String()),
      idempotency_key: Type.Optional(Type.String()),
    }) as any,
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const actorMembership = await assertCurrentSessionBinding(ctx, params.team_name);
      const actingSessionFile = ctx?.sessionManager?.getSessionFile?.();
      const task = await tasks.createTask(params.team_name, {
        title: params.title,
        description: params.description,
        design: params.design,
        assignee: params.assignee,
        idempotencyKey: params.idempotency_key,
      }, actorMembership.membershipId && actingSessionFile
        ? { actor: agentName, actingMembershipId: actorMembership.membershipId, actingSessionFile }
        : undefined);
      return {
        content: [{ type: "text", text: taskMutationContent(task, ["create"]) }],
        details: { task },
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
    description: "Apply one semantic Task mutation and return its post-state receipt; do not immediately task_read or task_list the same result.",
    parameters: Type.Object({
      team_name: Type.String(),
      task_id: Type.String(),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
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
      const result = await tasks.applySemanticTaskUpdate(params.team_name, params.task_id, {
        title: params.title,
        description: params.description,
        design: params.design,
        status: params.status,
        assignee: params.assignee,
        claim: params.claim,
        appendNote: params.append_note,
      }, { actor: agentName, expectedVersion: params.expected_version, actingSessionFile, actingMembershipId: actorMembership.membershipId });
      return {
        content: [{
          type: "text",
          text: taskMutationContent(result.task, result.appliedOperations, result.deliveryWarnings),
        }],
        details: result,
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
      const actingSessionFile = ctx?.sessionManager?.getSessionFile?.();
      const actorMembership = await assertCurrentSessionBinding(ctx, params.team_name);
      const result = await tasks.mutateTaskLink(params.team_name, params.task_id, {
        relation: params.relation,
        targetId: params.target_id,
        action: params.action,
      }, {
        actor: agentName,
        expectedVersion: params.expected_version,
        actingSessionFile,
        actingMembershipId: actorMembership.membershipId,
      });
      return {
        content: [{ type: "text", text: taskMutationContent(result.task, result.appliedOperations, result.deliveryWarnings) }],
        details: result,
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
      await assertCurrentSessionBinding(ctx, teamName);
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
        const details = {
          taskAuthorityRetained: true,
          agentSessionCleanupPerformed: false,
          deactivatedMembers: deactivated.map((member) => member.name),
          failures,
          stopEvidence,
          staleBindings: finalConfig.members.filter((member) => member.isActive === false && !!(member.tmuxPaneId || member.windowId)).map((member) => ({
            name: member.name,
            sessionFile: member.sessionFile,
            tmuxPaneId: member.tmuxPaneId,
            windowId: member.windowId,
          })),
        };
        await refreshTeamFooter(ctx);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: failures.length === 0 ? "shut_down" : "partially_shut_down",
              teamName,
              ...details,
            }),
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
    name: "cleanup_agent_sessions",
    label: "Cleanup Agent Sessions",
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
      const task = await tasks.readTask(params.team_name, params.task_id);
      return {
        content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
        details: { task },
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
      if (member.windowId && terminal) {
        alive = terminal.isWindowAlive(member.windowId);
      } else if (member.tmuxPaneId && terminal) {
        alive = terminal.isAlive(member.tmuxPaneId);
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
        agentLoopReady: !!runtimeStatus?.ready,
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
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });

  pi.registerTool({
    name: "process_shutdown_approved",
    label: "Process Shutdown Approved",
    description: "Stop one teammate and deactivate its current Membership only after shutdown is confirmed.",
    parameters: Type.Object({
      team_name: Type.String(),
      agent_name: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const safeTeamName = paths.sanitizeName(params.team_name);
      const safeAgentName = paths.sanitizeName(params.agent_name);
      return teams.withTeamTopologyLease(safeTeamName, async () => {
        await assertCurrentSessionBinding(ctx, safeTeamName);
        const config = await teams.readConfig(safeTeamName);
        const member = [...config.members].reverse().find(m => m.name === safeAgentName && m.isActive !== false);
        if (!member) throw new Error(`Teammate ${safeAgentName} not found`);
        if (member.name === "team-lead" || member.agentType === "lead") {
          throw new Error("process_shutdown_approved cannot shut down the team leader; use team_shutdown for whole-team lifecycle closure.");
        }

        const changed = await transitionCurrentMembership(safeTeamName, member, "process_shutdown", true);
        return {
          content: [{ type: "text", text: `Teammate ${safeAgentName} stopped and its current Membership was deactivated.` }],
          details: {
            deactivatedMembershipId: changed.member?.membershipId,
            stopEvidence: changed.stopEvidence,
          },
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
      );
      registerLeadSession(safeTeamName, leadSessionFile);
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
            tmuxPaneId: "",
            cwd: params.cwd,
            subscriptions: [],
            prompt: agentDef.prompt,
            color: "blue",
            thinking: agentDef.thinking,
          };

          await teams.addMember(safeTeamName, member);

          const piCmd = buildPiArgv(getPiLaunchArgv(), chosenModel, agentDef.thinking, agentDef.tools);

          const env: Record<string, string> = {
            ...process.env,
            PI_TEAM_NAME: safeTeamName,
            PI_AGENT_NAME: safeName,
            PI_AGENT_LAUNCH_ID: member.pendingLaunchId!,
          };

          await launchPreparedMembership(
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
              return { terminalId, isWindow: true };
            }
            if (terminal instanceof Iterm2Adapter) {
              const teammates = (await teams.readConfig(safeTeamName)).members.filter(m => m.agentType === "teammate" && m.tmuxPaneId.startsWith("iterm_"));
              const lastTeammate = teammates.length > 0 ? teammates[teammates.length - 1] : null;
              if (lastTeammate?.tmuxPaneId) {
                terminal.setSpawnContext({ lastSessionId: lastTeammate.tmuxPaneId.replace("iterm_", "") });
              } else {
                terminal.setSpawnContext({});
              }
            }

            const leadMember = (await teams.readConfig(safeTeamName)).members.find(m => m.name === "team-lead");
            const anchorPaneId = terminal.name === "tmux"
              ? leadMember?.tmuxPaneId || process.env.TMUX_PANE || undefined
              : undefined;

            const terminalId = terminal.spawn({
              name: safeName,
              cwd: params.cwd,
              argv: piCmd,
              env: env,
              anchorPaneId,
            });
            return { terminalId, isWindow: false };
            },
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
        details: { teamName: safeTeamName, predefinedTeam: params.predefined_team, results: spawnResults },
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
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      await assertCurrentSessionBinding(ctx, params.team_name);
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
      });

      // Build summary message
      const agentSummary = result.savedAgents.map(a => 
        `  - ${a.name}: ${a.existed ? "updated" : "created"} at ${a.path}`
      ).join("\n");
      
      const message = `Team "${teamName}" saved as template "${params.template_name}".

Agents saved:
${agentSummary}

Template location: ${result.teamsYamlPath}

You can now use this template with:
  create_predefined_team({ team_name: "new-team", predefined_team: "${params.template_name}", cwd: "..." })`;

      return {
        content: [{ type: "text", text: message }],
        details: {
          teamName,
          templateName: params.template_name,
          agentsDir: result.agentsDir,
          teamsYamlPath: result.teamsYamlPath,
          savedAgents: result.savedAgents,
          templateExisted: result.templateExisted,
        },
      };
    },
  });

}
