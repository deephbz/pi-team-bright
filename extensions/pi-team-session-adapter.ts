import { adoptLegacyGeneration } from "../src/team-authority/legacy-generation-adoption";
import { CarrierObserver } from "../src/carrier-observation";
import { hostEnv, type TimerHandle } from "../src/env/host-env";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as paths from "../src/utils/paths";
import * as runtime from "../src/utils/runtime";
import * as teams from "../src/utils/teams";
import { DirectMessageDelivery, messagePollMs } from "../src/alert-authority/direct-delivery";
import type { AlertMembershipPort } from "../src/alert-authority/contracts";
import { TaskChangeDelivery, taskPollMs, type TaskDeliveryMembershipPort } from "../src/utils/task-delivery";
import { RecipientDeliveryLifecycle, type RecipientDeliveryBinding, type DeliveryEngineName } from "../src/utils/recipient-delivery-lifecycle";
import { SyncNudgeConductor, type SyncNudgeDebt } from "../src/utils/sync-nudge-conductor";
import { DEFAULT_AUTO_SYNC_DELAY_SECONDS, DEFAULT_AUTO_SYNC_UPDATE_THRESHOLD } from "../src/utils/sync-liveness-settings";
import { clearTeamFooter, initializeTeamFooter, syncTeamFooter } from "../src/utils/team-footer";
import { teamTerminalTitle } from "../src/utils/team-labels";
import { loadWorkerResourcePolicy, materializeWorkerAggregate, ownsWorkerAggregate, projectWorkerTools, removeWorkerAggregate, type WorkerResourcePolicy } from "../src/utils/worker-resource-projection";
import type { PiSessionCurrentWorkerMember, PiSessionTeamQueryPort } from "../src/team-authority/pi-session-team-query";
import { placeSessionTerminal, type TeamIdentitySource, type TeamSessionAdmission } from "../src/utils/session-terminal";
import { exactLeaderSessionId } from "../src/model-tool-contract/runtime";
import type { ModelToolLifecycle } from "../src/model-tool-contract/durable-model-tool-port";
import type { GraphTaskRecoveryQuery } from "../src/utils/task-delivery";
import type { TeamLifecycleService } from "../src/team-authority/team-lifecycle-service";
import type { TeamSessionLifecycleService } from "../src/team-authority/team-session-lifecycle-service";
import type { GraphTaskOrchestrationPort } from "../src/task-authority/graph-orchestration";
import { diagnoseTeam, formatTeamStatus, formatCarrierStatus, isLegacyAdoptionCandidate, getPiTeamsArgumentCompletions, knownTeamNames, parsePiTeamsCommand, PI_TEAMS_COMMAND_USAGE, type TeamSessionBindingStatus } from "../src/utils/team-status";
import { collectPtbDoctorContext, PTB_DOCTOR_CUSTOM_TYPE } from "../src/utils/ptb-doctor-command";
import { getPtbArgumentCompletions, parsePtbCommand, PTB_COMMAND_USAGE, type PtbAction, type PtbSettingsScope } from "../src/utils/ptb-command";
import { getTerminalAdapter } from "../src/adapters/terminal-registry";
import { TaskGraphPaneService, type TaskGraphControlReadSource } from "../src/task-graph-view/integration";
import { withSemanticTrace } from "../src/utils/trace";
import { createSettingsWarningPresenter } from "./settings-warning";
import { createProcessGenerationWarning } from "./process-generation-warning";
import { CompactionDeliveryGate, DELIVERY_HOLD_CHANNEL, isDeliveryHoldSignal } from "./compaction-delivery-gate";
import { openPtbCommandPalette } from "./ptb-command-palette";
import { TeamUpdateController } from "./team-update";

export interface PiTeamSessionAdapter {
  readonly modelToolLifecycle: ModelToolLifecycle;
  readonly isTeammate: () => boolean;
  readonly resolveCurrentWorkerContext: (ctx: any) => Promise<{ teamName: string; member: PiSessionCurrentWorkerMember }>;
  register(): void;
}

export function createPiTeamSessionAdapter(options: {
  pi: ExtensionAPI;
  teamSessionLifecycleService: TeamSessionLifecycleService;
  teamLifecycleService: TeamLifecycleService;
  getModelToolJourney: () => any;
  modelToolBranchIds: (ctx: any) => string[];
  projectTrust: (ctx: any) => boolean | undefined;
  lifecyclePublication: { recordWorkerFailed(input: { teamName: string; workerName: string; membershipId: string }): Promise<unknown> };
  alertMembership: AlertMembershipPort;
  taskDeliveryMembership: TaskDeliveryMembershipPort;
  graphTaskAuthority: GraphTaskRecoveryQuery;
  teamQuery: PiSessionTeamQueryPort;
  leaderToolNames: ReadonlySet<string>;
  workerToolNames: ReadonlySet<string>;
  refreshAlertToolProjection: () => void;
  registerRecoveredWorkerTools: () => void;
  taskReadyReconciliation?: Pick<GraphTaskOrchestrationPort, "reconcileReady">;
  taskGraphControlSource: TaskGraphControlReadSource;
}): PiTeamSessionAdapter {
  const { pi, teamSessionLifecycleService, teamLifecycleService, getModelToolJourney, modelToolBranchIds, projectTrust, lifecyclePublication, alertMembership, taskDeliveryMembership, graphTaskAuthority, teamQuery, leaderToolNames, workerToolNames, refreshAlertToolProjection, registerRecoveredWorkerTools, taskReadyReconciliation, taskGraphControlSource } = options;
  const terminal = getTerminalAdapter();
  const taskGraphPane = new TaskGraphPaneService({ graphControlSource: taskGraphControlSource });
  let isTeammate = !!hostEnv().process.env.PI_AGENT_NAME && hostEnv().process.env.PI_AGENT_NAME !== "team-lead";
  const envAgentName = hostEnv().process.env.PI_AGENT_NAME;
  let agentName = envAgentName || "team-lead";
  const envTeamName = hostEnv().process.env.PI_TEAM_NAME;
  const envLaunchId = hostEnv().process.env.PI_AGENT_LAUNCH_ID;
  const envMembershipId = hostEnv().process.env.PI_TEAM_MEMBERSHIP_ID;
  let teamName: string | null = envTeamName || teamQuery.findLeadTeamForSession();
  let currentMembershipId: string | undefined;
  let syncNudgeConductor: SyncNudgeConductor | null = null;
  let stopSyncNudgeMonitor: (() => void) | null = null;
  let leaderRunSettled = false;
  let leaderContext: any;
  let deliveryContext: any;
  let holdWarningContext: any;
  const recipientDeliveries: RecipientDeliveryLifecycle = new RecipientDeliveryLifecycle({
    makePair: (binding, failed) => createDeliveryPair(binding, deliveryContext, failed),
    isCurrentBinding: async binding => {
      if (!await alertMembership.isCurrentSessionBinding(binding)) return false;
      const status = await runtime.readRuntimeStatus(binding.teamName, binding.recipient);
      return status?.membershipId === binding.membershipId && status.pid === hostEnv().process.pid && !status.lastStop;
    },
    publishState: async (binding, engine, state) => {
      const transition = await teamSessionLifecycleService.writeDeliveryState(binding, engine, state, () => recipientDeliveries.binding === binding);
      if (!transition || recipientDeliveries.binding !== binding) return;
      const label = engine === "alert" ? "Alert" : "Task";
      deliveryContext?.ui?.notify?.(state.state === "degraded"
        ? `${label} delivery is degraded: ${state.message}. Retry is scheduled.`
        : `${label} delivery recovered.`, state.state === "degraded" ? "warning" : "info");
    },
  });
  let footerModel: any;
  let workerResourcePolicy: WorkerResourcePolicy | undefined;
  let workerActiveToolBaseline: string[] | undefined;
  const settingsWarnings = createSettingsWarningPresenter();
  const warnMissingGenerationHelper = createProcessGenerationWarning();
  let doctorGeneration = 0;
  let titleOwned = false;
  let titleGeneration = 0;
  const titleTimers = new Set<TimerHandle>();
  const identitySource: TeamIdentitySource = hostEnv().process.env.PI_AGENT_NAME ? "launch_env" : "resumed_session";

  initializeTeamFooter(pi);
  const modelToolJourney = () => getModelToolJourney();
  // Every Pi Team Bright message to the model passes this gate.
  const compactionGate = new CompactionDeliveryGate({
    onError: (error) => console.error("[pi-teams] held delivery failed after compaction:", error),
    onExternalHoldExpired: (holder) => {
      (holdWarningContext ?? leaderContext ?? deliveryContext)?.ui?.notify?.(
        `PTB delivery hold from ${holder} expired after 30 minutes. Delivery protection is degraded; messages can resume when other holds clear.`,
        "warning",
      );
    },
  });
  const messageSink = compactionGate.sink(pi);
  compactionGate.onOpen(() => syncNudgeConductor?.notify());
  const frameworkSync = new TeamUpdateController({
    pi: messageSink,
    current: () => {
      const ctx = leaderContext;
      const sessionId = ctx?.sessionManager?.getSessionId?.();
      const sessionFile = ctx?.sessionManager?.getSessionFile?.();
      const branch = ctx?.sessionManager?.getBranch?.();
      if (isTeammate || !teamName || !sessionId || !sessionFile || !Array.isArray(branch)) return undefined;
      return { sessionId, sessionFile, branch };
    },
    executeNow: (sessionId, view, signal, toolCallId) => modelToolJourney()!.executors.teamSyncNow(exactLeaderSessionId(sessionId), { view }, signal, toolCallId),
    readTeamBinding: async (name, sessionFile) => {
      if (name !== teamName || isTeammate || agentName !== "team-lead") return undefined;
      const generation = doctorGeneration;
      const membershipId = currentMembershipId;
      const config = await teams.readConfig(name);
      if (generation !== doctorGeneration || name !== teamName || membershipId !== currentMembershipId
        || isTeammate || agentName !== "team-lead") return undefined;
      const lead = config.members.find((member) => member.name === "team-lead" && member.agentType === "lead" && member.isActive !== false && member.sessionFile === sessionFile);
      return config.epochId && config.leadSessionId === sessionFile && membershipId && lead?.membershipId === membershipId
        ? { epochId: config.epochId, membershipId } : undefined;
    },
    pendingObservation: (sessionId) => modelToolJourney()?.port.coordination.getPendingObservation?.(exactLeaderSessionId(sessionId)),
    setBranchEntries: (sessionId, branch) => modelToolJourney()!.port.coordination.setBranchEntries?.(exactLeaderSessionId(sessionId), branch),
    clearPending: (sessionId, toolCallId) => modelToolJourney()?.port.coordination.discardPendingObservation?.(exactLeaderSessionId(sessionId), toolCallId),
    isBusy: (ownToolCallId) => {
      const ctx = leaderContext;
      const sessionId = ctx?.sessionManager?.getSessionId?.();
      if (sessionId) modelToolJourney()?.port.coordination.setBranchEntries?.(exactLeaderSessionId(sessionId), ctx.sessionManager.getBranch());
      const pending = sessionId ? modelToolJourney()?.port.coordination.getPendingObservation?.(exactLeaderSessionId(sessionId)) : undefined;
      return !leaderRunSettled || compactionGate.isClosed || ctx?.isIdle?.() === false || !!ctx?.hasPendingMessages?.()
        || (!!pending && pending.toolCallId !== ownToolCallId);
    },
    notify: (message, level = "info") => {
      const ctx = leaderContext;
      if (ctx?.hasUI !== false && ctx?.ui?.notify) ctx.ui.notify(message, level);
      else process.stderr.write(`${message}\n`);
    },
  });

function configureWorkerResources(ctx: any): void {
  if (!isTeammate) return;
  const cwd = ctx.cwd ?? hostEnv().process.cwd();
  workerResourcePolicy = loadWorkerResourcePolicy({ cwd, projectTrusted: projectTrust(ctx) === true });
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
}

function commandOwner(ctx: any) {
  const owner = {
    generation: doctorGeneration,
    sessionId: ctx.sessionManager?.getSessionId?.(),
    sessionFile: ctx.sessionManager?.getSessionFile?.(),
    leafId: ctx.sessionManager?.getLeafId?.(),
    teamName,
    role: agentName,
    membershipId: currentMembershipId,
    isTeammate,
    cwd: ctx.cwd ?? hostEnv().process.cwd(),
    projectTrusted: projectTrust(ctx) === true,
  };
  const isCurrent = () => owner.generation === doctorGeneration
    && owner.sessionId === ctx.sessionManager?.getSessionId?.()
    && owner.sessionFile === ctx.sessionManager?.getSessionFile?.()
    && owner.leafId === ctx.sessionManager?.getLeafId?.()
    && owner.teamName === teamName && owner.role === agentName
    && owner.membershipId === currentMembershipId && owner.isTeammate === isTeammate
    && owner.cwd === (ctx.cwd ?? hostEnv().process.cwd()) && owner.projectTrusted === (projectTrust(ctx) === true);
  return { ...owner, isCurrent };
}

function presentCommand(ctx: any, text: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI !== false && ctx.ui?.notify) ctx.ui.notify(text, level);
  else process.stderr.write(`${text}\n`);
}

async function openCommandPalette(ctx: any, initialSettingsScope?: PtbSettingsScope): Promise<void> {
  if (ctx.hasUI === false || ctx.mode !== "tui" || !ctx.ui?.custom) {
    presentCommand(ctx, `${PTB_COMMAND_USAGE}\nThe command palette and settings editor require an interactive TUI.`);
    return;
  }
  const owner = commandOwner(ctx);
  await openPtbCommandPalette(ctx, {
    isCurrent: owner.isCurrent,
    runAction: async (action: PtbAction) => {
      if (!owner.isCurrent()) {
        presentCommand(ctx, "Command cancelled because the Session or Team changed. Run /ptb again.", "warning");
        return;
      }
      await runPtbAction(action, ctx);
    },
    teamName: owner.teamName ?? undefined,
    role: owner.role,
    graphAvailable: terminal?.name === "herdr",
    projectTrusted: projectTrust(ctx) === true,
    initialSettingsScope,
  });
}

const registerCommand = (pi as any).registerCommand?.bind(pi);
registerCommand?.("pi-team-bright-settings", {
  description: "Legacy alias for /ptb settings check",
  handler: async (_args: string, ctx: any) => runPtbAction({ kind: "settings_check" }, ctx),
});
const runSync = async (_args: string, ctx: any) => {
    leaderContext = ctx;
    if (isTeammate || !teamName || agentName !== "team-lead") {
      ctx.ui?.notify?.("No current leader Team is bound to this Pi Session.", "warning");
      return;
    }
    const owner = commandOwner(ctx);
    if (ctx?.isIdle?.() !== false) leaderRunSettled = true;
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    const sessionFile = ctx?.sessionManager?.getSessionFile?.();
    const branch = modelToolBranchIds(ctx);
    if (!sessionId || !sessionFile || !branch.length) return;
    modelToolJourney()?.port.coordination.setBranchEntries?.(exactLeaderSessionId(sessionId), ctx.sessionManager.getBranch());
    if (!owner.isCurrent()) return;
    const view = await modelToolJourney()?.port.coordination.selectTeamSyncView?.(exactLeaderSessionId(sessionId), branch) ?? "updates";
    if (!owner.isCurrent() || ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getSessionFile() !== sessionFile
      || modelToolBranchIds(ctx).some((id: string, index: number) => id !== branch[index]) || modelToolBranchIds(ctx).length !== branch.length) return;
    await frameworkSync.execute(owner.teamName!, "command", view);
};
registerCommand?.("teamsync", {
  description: "Legacy alias for /ptb sync",
  handler: runSync,
});
const runDoctor = async (ctx: any, requestedTeamName?: string) => {
    holdWarningContext = ctx;
    const present = (text: string, level: "info" | "warning" | "error" = "info") => presentCommand(ctx, text, level);
    const owner = commandOwner(ctx);
    const selectedTeamName = requestedTeamName ?? owner.teamName ?? undefined;
    let content: string;
    try {
      content = await collectPtbDoctorContext({
        requestedAt: new Date(hostEnv().clock.now()).toISOString(),
        selectedTeamName,
        boundTeamName: owner.teamName ?? undefined,
        role: owner.role,
        membershipId: owner.membershipId,
        sessionId: owner.sessionId,
        sessionFile: owner.sessionFile,
        leafId: owner.leafId ?? undefined,
      });
    } catch {
      present("Doctor guide or metadata is unavailable. Check the installed package and retry.", "error");
      return;
    }
    if (selectedTeamName) {
      const observer = selectedTeamName === owner.teamName && carrierObserver ? carrierObserver : new CarrierObserver(selectedTeamName);
      await observer.refresh().catch(() => undefined);
      content = `CarrierView (current observations):\n${JSON.stringify([...observer.views.values()], null, 2)}\n\n${content}`;
    }
    if (!owner.isCurrent()) {
      present("Doctor request cancelled because the Session or Team changed. Run /ptb doctor again.", "warning");
      return;
    }
    const queued = ctx.isIdle?.() !== true || compactionGate.isClosed;
    try {
      messageSink.sendMessage({ customType: PTB_DOCTOR_CUSTOM_TYPE, content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
      present(queued ? "Doctor queued after current turn." : "Doctor context submitted.");
    } catch {
      present("Doctor context could not be sent. Retry /ptb doctor.", "error");
    }
};
registerCommand?.("ptb", {
  description: "Pi Team Bright command palette and direct commands",
  getArgumentCompletions: getPtbArgumentCompletions,
  handler: async (args: string, ctx: any) => {
    const command = parsePtbCommand(args);
    if (command.kind === "invalid") { presentCommand(ctx, PTB_COMMAND_USAGE, "warning"); return; }
    if (command.kind === "palette") { await openCommandPalette(ctx); return; }
    await runPtbAction(command, ctx);
  },
});

const runGraph = async (args: string, ctx: any) => {
    const present = (text: string, level: "info" | "warning" | "error" = "info") => {
      if (ctx.hasUI !== false && ctx.ui?.notify) ctx.ui.notify(text, level);
      else process.stderr.write(`${text}\n`);
    };
    const owner = commandOwner(ctx);
    if (!owner.teamName) {
      present("No current Team is bound to this Pi Session. Create or resume a Team first.", "warning");
      return;
    }
    if (!owner.isCurrent()) return;
    try {
      const result = await taskGraphPane.toggle({
        teamName: owner.teamName,
        actor: owner.role,
        cwd: ctx.cwd ?? hostEnv().process.cwd(),
        limitText: args,
      });
      if (!owner.isCurrent()) return;
      present(result.kind === "opened"
        ? "Task graph pane opened in this Herdr tab. Run /pi-team-graph again to close it."
        : "Task graph pane closed.");
    } catch (error) {
      if (!owner.isCurrent()) return;
      present(`Task graph pane failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
};
registerCommand?.("pi-team-graph", {
  description: "Legacy alias for /ptb graph (limit: 25, 50, 100, 200, or all)",
  getArgumentCompletions: (prefix: string) => ["25", "50", "100", "200", "all"]
    .filter((value) => value.startsWith(prefix.trim()))
    .map((value) => ({ value, label: value })),
  handler: runGraph,
});

const declinedAdoptionSessions = new Set<string>();
const runStatus = async (ctx: any) => {
    const present = (text: string, level: "info" | "warning" | "error" = "info") => {
      if (ctx.hasUI !== false && ctx.ui?.notify) ctx.ui.notify(text, level);
      else process.stderr.write(`${text}\n`);
    };
    const owner = commandOwner(ctx);
    if (!owner.teamName) {
      const known = knownTeamNames();
      present(`No current Team is bound to this Pi Session.${known.length ? ` Known Teams: ${known.slice(0, 8).join(", ")}.` : " Create a Team first with team_create."}`, "warning"); return;
    }
    const sessionFile = owner.sessionFile;
    let sessionBinding: TeamSessionBindingStatus = sessionFile ? "stale" : "unavailable";
    let sessionDetail = sessionFile ? undefined : "durable Pi Session file unavailable";
    if (sessionFile) try {
      const member = await teamQuery.currentSessionBinding(owner.teamName, owner.role, sessionFile);
      if (owner.membershipId && member.membershipId !== owner.membershipId) sessionDetail = "current Team membership differs from this runtime generation";
      else sessionBinding = "current";
    } catch (error) { sessionDetail = error instanceof Error ? error.message : String(error); }
    if (!owner.isCurrent()) return;
    try {
      const report = await diagnoseTeam(owner.teamName, { role: owner.role, sessionBinding, sessionDetail });
      if (!owner.isCurrent()) return;
      const lines = [formatTeamStatus(report)];
      const carrierFacts: ReturnType<typeof formatCarrierStatus>["facts"][] = [];
      if (owner.role === "team-lead" && sessionBinding === "current") {
        const observer = carrierObserver ?? new CarrierObserver(owner.teamName);
        await observer.refresh();
        const tasks = taskGraphControlSource?.hasGraph(owner.teamName) ? (await taskGraphControlSource.trace(owner.teamName)).tasks : undefined;
        if (!owner.isCurrent()) return;
        const views = [...observer.views.values()];
        for (const view of views) {
          const taskIds = tasks?.filter(task => task.assignee === view.worker && !["goal_achieved", "goal_failed", "cancelled"].includes(task.state.kind)).map(task => task.id);
          const status = formatCarrierStatus(view, taskIds);
          lines.push(status.line);
          if (status.facts.process || status.facts.launch) carrierFacts.push(status.facts);
        }
        const declineKey = JSON.stringify([owner.teamName, owner.membershipId, sessionFile]);
        const candidates = views.filter(isLegacyAdoptionCandidate);
        if (candidates.length && !declinedAdoptionSessions.has(declineKey) && ctx.hasUI !== false && ctx.ui?.confirm) {
          const accepted = await ctx.ui.confirm("Adopt legacy Worker generations?", `Verify and record OS birth tokens for these Workers? Each requires an exact matching Herdr Session.\n${candidates.map(view => `${view.worker}: pane ${view.paneId ?? "unknown"}`).join("\n")}`);
          if (!owner.isCurrent()) return;
          if (!accepted) declinedAdoptionSessions.add(declineKey);
          else for (const view of candidates) {
            const adopted = await adoptLegacyGeneration(owner.teamName, view.worker, view.membership);
            if (!owner.isCurrent()) return;
            lines.push(adopted ? `${view.worker}: generation adopted; run status to refresh.` : `${view.worker}: adoption refused; evidence changed or is unavailable.`);
          }
        }
      }
      if (!owner.isCurrent()) return;
      messageSink.appendEntry("ptb.status", { lines, ...(carrierFacts.length ? { carrierFacts } : {}) });
      if (ctx.mode !== "tui") present(lines.join("\n"), report.taskAuthority.health === "verified" && sessionBinding === "current" ? "info" : "warning");
    } catch (error) {
      if (owner.isCurrent()) present(`Pi Team Bright status failed for ${owner.teamName}. ${error instanceof Error ? error.message : String(error)}`, "error");
    }
};
registerCommand?.("pi-team-bright", {
  description: "Legacy alias for /ptb status or /ptb help",
  getArgumentCompletions: getPiTeamsArgumentCompletions,
  handler: async (args: string, ctx: any) => {
    const command = parsePiTeamsCommand(args);
    if (!command.ok) { presentCommand(ctx, command.usage, "warning"); return; }
    if (command.subcommand === "help") {
      presentCommand(ctx, `${PI_TEAMS_COMMAND_USAGE}\nstatus is the default and reads TeamConfig plus graph authority diagnostics.`);
      return;
    }
    await runStatus(ctx);
  },
});

async function runPtbAction(command: PtbAction, ctx: any): Promise<void> {
  switch (command.kind) {
    case "help":
      presentCommand(ctx, `${PTB_COMMAND_USAGE}\n/ptb doctor sends a guide and sampled metadata to the agent and starts a model turn.`);
      return;
    case "status": return runStatus(ctx);
    case "sync": return runSync("", ctx);
    case "graph": return runGraph(command.limit ?? "", ctx);
    case "doctor": return runDoctor(ctx, command.teamName);
    case "settings_check":
      settingsWarnings.showAll(ctx, projectTrust(ctx) === true);
      return;
    case "settings": return openCommandPalette(ctx, command.scope ?? "global");
  }
}

function releaseTeamTitle(ctx: any) {
  titleGeneration++;
  for (const timer of titleTimers) hostEnv().clock.clearTimeout(timer);
  titleTimers.clear();
  if (!titleOwned) return;
  titleOwned = false;
  // Re-emit only the exact current name to restore Pi's default title.
  // This chooses no new name; leader/unbound name ownership remains unchanged.
  try { pi.setSessionName?.(ctx.sessionManager.getSessionName?.() ?? ""); }
  catch { console.warn("[pi-teams] Pi's default terminal title could not be restored."); }
}

function clearTeamProjection(ctx: any) {
  clearTeamFooter(ctx, pi);
  releaseTeamTitle(ctx);
}

async function refreshTeamFooter(ctx: any) {
  if (!ctx?.ui) return undefined;
  const generation = ++titleGeneration;
  footerModel = ctx?.model ?? footerModel;
  const binding = await syncTeamFooter(pi, ctx, {
    teamName,
    role: agentName,
    membershipId: currentMembershipId,
  }, () => footerModel);
  if (generation !== titleGeneration) return undefined;
  if (!binding) { releaseTeamTitle(ctx); return undefined; }
  // setSessionName can replace the terminal title. Apply our label after it.
  const label = teamTerminalTitle(binding.teamName, binding.role);
  try {
    ctx.ui.setTitle?.(label);
    terminal?.setTitle(label);
    titleOwned = true;
  } catch { console.warn("[pi-teams] Team terminal title could not be set."); }
  return binding;
}

function scheduleTeamTitleRefresh(ctx: any) {
  for (const delay of [500, 2000, 5000]) {
    const timer = hostEnv().clock.setTimeout(() => {
      titleTimers.delete(timer);
      void refreshTeamFooter(ctx);
    }, delay);
    if ("unref" in timer) timer.unref();
    titleTimers.add(timer);
  }
}

function stopSyncNudgeConductor() {
  carrierObserver?.stop();
  carrierObserver = undefined;
  frameworkSync.invalidate();
  syncNudgeConductor?.stop();
  syncNudgeConductor = null;
  stopSyncNudgeMonitor?.();
  stopSyncNudgeMonitor = null;
}

let carrierObserver: CarrierObserver | undefined;
async function startSyncNudgeConductor(ctx: any) {
  stopSyncNudgeConductor();
  if (teamName && !isTeammate && agentName === "team-lead") {
    carrierObserver = new CarrierObserver(teamName, text => ctx.ui?.notify?.(text, "warning"));
    carrierObserver.start();
  }
  if (isTeammate || !teamName || agentName !== "team-lead" || !modelToolJourney()?.port.coordination.readSyncNudgeDebt) return;
  let policy;
  try { policy = await teamQuery.syncNudgePolicy(teamName); } catch { return; }
  if (!(policy?.autoSyncEnabled ?? policy?.nudgeEnabled ?? true)) return;
  const delayMs = Math.max(0, (policy?.autoSyncDelaySeconds ?? policy?.nudgeDelaySeconds ?? DEFAULT_AUTO_SYNC_DELAY_SECONDS) * 1000);
  // Model-tool registration normally binds lazily on the first tool call.
  // Resume nudge reconciliation has no such call, so bind the exact current
  // Pi Session before it can ask the port for debt.
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  if (!sessionId || !sessionFile) return;
  modelToolJourney().port.team.setLeaderSessionFile?.(exactLeaderSessionId(sessionId), sessionFile);
  const debt = async (): Promise<SyncNudgeDebt> => {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    const branch = modelToolBranchIds(ctx);
    if (!sessionId || branch.length === 0) return { kind: "none" };
    modelToolJourney()!.port.coordination.setBranchEntries?.(exactLeaderSessionId(sessionId), ctx.sessionManager.getBranch());
    return modelToolJourney()!.port.coordination.readSyncNudgeDebt!(exactLeaderSessionId(sessionId), branch);
  };
  const busy = (): boolean => {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    if (sessionId) modelToolJourney()?.port.coordination.setBranchEntries?.(exactLeaderSessionId(sessionId), ctx.sessionManager.getBranch());
    return !leaderRunSettled || compactionGate.isClosed || ctx?.isIdle?.() === false || !!ctx?.hasPendingMessages?.()
      || frameworkSync.isRunning
      || (!!sessionId && !!modelToolJourney()?.port.coordination.getPendingObservation?.(exactLeaderSessionId(sessionId)));
  };
  syncNudgeConductor = new SyncNudgeConductor({
    clock: { setTimeout: (callback, ms) => hostEnv().clock.setTimeout(callback, ms), clearTimeout: (handle) => hostEnv().clock.clearTimeout(handle as TimerHandle) },
    delayMs,
    updateThreshold: policy?.autoSyncUpdateThreshold ?? DEFAULT_AUTO_SYNC_UPDATE_THRESHOLD,
    readDebt: debt,
    isSettled: () => leaderRunSettled,
    isBusy: busy,
    alreadyPresented: () => false,
    present: async (candidate) => {
      const sessionFile = ctx?.sessionManager?.getSessionFile?.();
      const sessionId = ctx?.sessionManager?.getSessionId?.();
      const branch = modelToolBranchIds(ctx);
      if (!sessionFile || !sessionId || branch.length === 0 || busy()) return false;
      if (!await teamQuery.matchesSyncNudgeCandidate({
        teamName: teamName!,
        teamEpochId: candidate.teamEpochId,
        leaderSessionFile: sessionFile,
        leaderMembershipId: candidate.leaderMembershipId,
      })) return false;
      const latest = await modelToolJourney()!.port.coordination.readSyncNudgeDebt!(exactLeaderSessionId(sessionId), branch);
      if (latest.kind !== "eligible" || latest.debtKey !== candidate.debtKey || latest.scopeKey !== candidate.scopeKey || latest.branchId !== candidate.branchId || latest.leaderMembershipId !== candidate.leaderMembershipId || latest.branchLineage.length !== candidate.branchLineage.length || latest.branchLineage.some((value: string, index: number) => value !== candidate.branchLineage[index]) || busy()) return false;
      const result = await frameworkSync.execute(teamName!, "automatic", candidate.requestedView);
      return result === "published";
    },
  });
  const eventDirectory = path.join(paths.teamDir(teamName), "events");
  fs.mkdirSync(eventDirectory, { recursive: true });
  const watcher = hostEnv().watch.watchDirectory(eventDirectory, (filename) => {
    if (typeof filename === "string" && filename === "team-events.jsonl") syncNudgeConductor?.notify();
  });
  watcher.onError(() => syncNudgeConductor?.notify());
  const interval = hostEnv().clock.setInterval(() => syncNudgeConductor?.notify(), Math.max(5_000, Math.min(30_000, Math.max(100, delayMs))));
  if ("unref" in interval) interval.unref();
  syncNudgeConductor.start();
  stopSyncNudgeMonitor = () => { watcher.close(); hostEnv().clock.clearInterval(interval); };
}

function stopDeliveries() {
  stopSyncNudgeConductor();
  recipientDeliveries.deactivate();
  deliveryContext = undefined;
}

/** Resolve the one exact current Team and Worker identity for Worker tools. */
async function resolveCurrentWorkerContext(ctx: any): Promise<{ teamName: string; member: PiSessionCurrentWorkerMember }> {
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  if (!sessionFile) throw new Error("A durable Pi Session is required for every Worker tool operation.");
  const binding = await teamQuery.resolveCurrentTeammateSessionBinding(sessionFile);
  if (binding.status !== "bound") {
    throw new Error(`Current Worker Session binding is unavailable: ${binding.reason}.`);
  }
  return binding;
}

async function writeCurrentTeammateRuntime(ctx: any, updates: Partial<runtime.AgentRuntimeStatus>) {
  if (!isTeammate || !teamName) return;
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  if (!sessionFile) throw new Error("A durable Pi Session is required for teammate runtime updates.");
  currentMembershipId = await teamSessionLifecycleService.writeBoundWorkerRuntime({
    teamName,
    workerName: agentName,
    sessionFile,
    membershipId: currentMembershipId,
    updates,
  });
}

function createDeliveryPair(binding: RecipientDeliveryBinding, ctx: any, failed: (engine: DeliveryEngineName, error: unknown) => void) {
  if (!ctx || ctx.sessionManager?.getSessionFile?.() !== binding.sessionFile) {
    throw new Error("Recipient delivery activation requires its exact current Pi Session context.");
  }
  const entries = () => ctx.sessionManager?.buildContextEntries?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
  const direct = new DirectMessageDelivery(messageSink, {
    teamName: binding.teamName,
    recipient: binding.recipient,
    membershipId: binding.membershipId,
    sessionFile: binding.sessionFile,
    pollMs: messagePollMs(),
    membership: alertMembership,
    onError: error => failed("alert", error),
  });
  const task = new TaskChangeDelivery(messageSink, {
    teamName: binding.teamName, recipient: binding.recipient, membershipId: binding.membershipId, sessionFile: binding.sessionFile,
    pollMs: taskPollMs(), membership: taskDeliveryMembership,
    onError: error => failed("task", error),
    graphAuthority: graphTaskAuthority,
    ...(isTeammate && taskReadyReconciliation ? {
      // One Team lease selects the entire ready frontier, so any bound Worker
      // can repair delivery for quiet siblings without a per-Worker scan.
      reconcileReady: () => withSemanticTrace(
        "worker_periodic_ready_reconciliation",
        { teamName: binding.teamName, workerName: binding.recipient },
        () => taskReadyReconciliation.reconcileReady(binding.teamName),
      ),
    } : {}),
  });
  return {
    direct: {
      start: () => direct.start(entries()),
      stop: () => direct.stop(),
      observeContext: (messages: readonly unknown[]) => direct.observeContext(messages as any),
      commitPresentedAfterSuccessfulTurn: (reason: unknown) => direct.commitPresentedAfterSuccessfulTurn(reason),
    },
    task: {
      start: async () => {
        await task.start(entries());
        if (!isTeammate || !taskReadyReconciliation) return;
        try {
          const warnings = await withSemanticTrace("worker_session_ready_reconciliation", { teamName: binding.teamName, workerName: binding.recipient }, () => taskReadyReconciliation.reconcileReady(binding.teamName, binding.recipient));
          for (const warning of warnings) ctx.ui?.notify?.(`Pi Team Bright ready delivery: ${warning}`, "warning");
        } catch (error) {
          ctx.ui?.notify?.(`Pi Team Bright ready delivery is deferred: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
      },
      stop: () => task.stop(),
      observeContext: (messages: readonly unknown[]) => task.observeContext(messages as any),
      commitPresentedAfterSuccessfulTurn: (reason: unknown) => task.commitPresentedAfterSuccessfulTurn(reason),
    },
  };
}

async function activateRecipientDeliveries(ctx: any): Promise<void> {
  if (!teamName) return;
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  if (!sessionFile) return;
  const member = await teamQuery.currentSessionBinding(teamName, agentName, sessionFile);
  if (!member.membershipId) throw new Error(`Current Membership for ${agentName} has no membershipId.`);
  currentMembershipId = member.membershipId;
  deliveryContext = ctx;
  await recipientDeliveries.activate({ teamName, recipient: agentName, membershipId: member.membershipId, sessionFile });
}

/**
 * A launcher that sets the teammate environment owns the contract it broke;
 * a Session recognized from its own file belongs to the operator's terminal.
 */

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
  doctorGeneration++;
  if (identitySource === "launch_env" && envTeamName === refusedTeam
    && envAgentName === role && role !== "team-lead" && envMembershipId) {
    // Publish the launch identity even if authority now names a replacement.
    // The launch observer matches exact Membership IDs before accepting failure.
    await lifecyclePublication.recordWorkerFailed({ teamName: refusedTeam, workerName: role, membershipId: envMembershipId }).catch(() => undefined);
  } else if (!shutdownCandidate) {
    await teamSessionLifecycleService.recordAdmissionFailure(refusedTeam, role).catch(() => undefined);
  }
  stopDeliveries();
  isTeammate = false;
  teamName = null;
  currentMembershipId = undefined;
  ctx?.ui?.notify?.(admission.reason, "error");
  ctx?.ui?.setStatus?.("pi-teams", shutdownCandidate ? "startup admission refused" : "terminal backend mismatch");
  clearTeamProjection(ctx);
  if (admission.exitProcess) ctx?.shutdown?.();
}

function registerSessionHooks() {
  pi.events?.on(DELIVERY_HOLD_CHANNEL, (payload) => {
    if (!isDeliveryHoldSignal(payload)) return;
    if (payload.active) compactionGate.beginExternal(payload.holder, payload.token);
    else compactionGate.endExternal(payload.holder, payload.token);
  });
  pi.on("session_before_switch", () => { frameworkSync.invalidate(); });
  pi.on("session_before_fork", () => { frameworkSync.invalidate(); });
  pi.on("session_before_tree", () => { frameworkSync.invalidate(); doctorGeneration++; });
  pi.on("session_before_compact", () => { compactionGate.begin(); frameworkSync.invalidate(); doctorGeneration++; });
  pi.on("session_compact", () => { compactionGate.end(); });
  // Pi 0.83 lacks this event; the gate's hold limit covers that version.
  (pi.on as (event: string, handler: () => void) => void)("session_compact_failed", () => { compactionGate.end(); });
  pi.on("session_start", async (event, ctx) => {
  warnMissingGenerationHelper(ctx);
  compactionGate.reset();
  doctorGeneration++;
  paths.ensureDirs();
  stopDeliveries();
  leaderRunSettled = false;
  leaderContext = ctx;
  holdWarningContext = ctx;
  footerModel = ctx.model;
  clearTeamProjection(ctx);
  let projectionBound = false;

  if (event.reason === "fork") {
    // A fork is a new Session identity, not a continuation of the source
    // member. Keep it unbound until an explicit team_create/rebind action.
    isTeammate = false;
    agentName = "unbound-session";
    teamName = null;
    currentMembershipId = undefined;
    settingsWarnings.refresh(ctx, projectTrust(ctx) === true, true);
    return;
  }

  // A fresh `pi -r` process has no teammate environment variables. A
  // teammate's first startup persists its Pi session file, which is enough
  // to restore its identity before the normal teammate lifecycle runs.
  const piSessionFile = ctx.sessionManager?.getSessionFile?.();
  if (!isTeammate && !teamName && piSessionFile) {
    const resumedMember = teamQuery.findTeammateBySessionFile(piSessionFile);
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
    teamName = teamQuery.findLeadTeamForSession(piSessionFile);
  }

  settingsWarnings.refresh(ctx, projectTrust(ctx) === true, !isTeammate);

  if (envTeamName && !teamQuery.teamExists(envTeamName)) {
    throw new Error(
      `Explicit PI_TEAM_NAME '${envTeamName}' does not name a current team. ` +
      "Refusing implicit fallback or team-state creation; choose an existing team or create it explicitly.",
    );
  }

  let recoveredWorker = false;
  if (isTeammate) {
    configureWorkerResources(ctx);
    if (teamName) {
      if (!piSessionFile) throw new Error("Teammate startup requires a durable Pi Session file.");
      const teamConfig = await teamQuery.terminalPlacement(teamName);
      let startup: Awaited<ReturnType<typeof teamSessionLifecycleService.admitWorker>>;
      try {
        startup = await teamSessionLifecycleService.admitWorker({
          teamName,
          workerName: agentName,
          sessionFile: piSessionFile,
          placement: placeSessionTerminal(teamConfig, terminal, hostEnv().process.env.TMUX_PANE),
          identitySource,
          launchId: envLaunchId,
          expectedMembershipId: envMembershipId,
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
        await refuseTeamSession(ctx, teamName, agentName, startup, true);
        return;
      }
      currentMembershipId = startup.member!.membershipId;
      recoveredWorker = startup.recovered === true;
    }
    ctx.ui.notify(`Teammate: ${agentName} (Team: ${teamName})`, "info");
    // Establish the Worker-owned Session name before any Task delivery activates.
    projectionBound = !!await refreshTeamFooter(ctx);
    if (teamName) {
      await activateRecipientDeliveries(ctx);
      if (recoveredWorker && currentMembershipId && piSessionFile && taskGraphControlSource?.hasGraph(teamName)) {
        const active = (await taskGraphControlSource.trace(teamName)).tasks.filter(task => task.assignee === agentName && task.state.kind === "in_progress");
        if (active.length) await teams.withCurrentSessionBinding(teamName, agentName, piSessionFile, currentMembershipId, async () => {
          if (ctx.sessionManager.getSessionFile() !== piSessionFile) return;
          messageSink.sendMessage({ customType: "ptb.worker-recovery", content: `Your exact Worker Session resumed. Continue the current Attempt for ${active.map(task => task.id).join(", ")}. Use task_read for current authority. Recovery changed no Task state.`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
        });
      }
    }
  } else if (teamName) {
    if (!piSessionFile) throw new Error("Lead resume requires a durable Pi Session file.");
    // Lead reconnecting to an existing team, including a new `pi -r`
    // process. Refresh both volatile process identity and terminal location.
    if (teamQuery.teamExists(teamName)) {
      const teamConfig = await teamQuery.terminalPlacement(teamName);
      let runtimeAdmission: Awaited<ReturnType<typeof teamSessionLifecycleService.admitLead>>;
      try {
        runtimeAdmission = await teamSessionLifecycleService.admitLead({
          teamName,
          sessionFile: piSessionFile,
          placement: placeSessionTerminal(teamConfig, terminal, hostEnv().process.env.TMUX_PANE),
          identitySource,
        });
      } catch (error) {
        await refuseTeamSession(ctx, teamName, "team-lead", {
          kind: "refused",
          reason: `Lead startup failed after candidate admission: ${error instanceof Error ? error.message : String(error)}. The candidate process was stopped; its runtime fence remains until PID exit.`,
          exitProcess: true,
        }, true);
        return;
      }
      if (runtimeAdmission.kind === "refused") {
        await refuseTeamSession(ctx, teamName, "team-lead", runtimeAdmission, true);
        return;
      }
      currentMembershipId = runtimeAdmission.member.membershipId;
    }
    await activateRecipientDeliveries(ctx);
  }
  if (!isTeammate) {
    // A resumed/reloaded idle Session has no active agent run. This is
    // positive settled evidence, unlike a fresh startup before agent_start.
    leaderRunSettled = event.reason === "resume" || event.reason === "reload";
    await startSyncNudgeConductor(ctx);
  }
  if (!isTeammate) projectionBound = !!await refreshTeamFooter(ctx);
  if (projectionBound) scheduleTeamTitleRefresh(ctx);
});

pi.on("session_shutdown", async (event, ctx) => {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (teamName && currentMembershipId && sessionFile) {
    await teamSessionLifecycleService.recordStop({ teamName, workerName: agentName, sessionFile,
      membershipId: currentMembershipId, piReason: event.reason, targetSessionFile: event.targetSessionFile,
    }).catch(() => undefined);
  }
  compactionGate.reset();
  settingsWarnings.clear(ctx);
  doctorGeneration++;
  if (isTeammate && event.reason === "reload") {
    // Pi captures active tools after this hook and replaces this extension
    // closure. Restore the immutable baseline before that capture.
    if (workerActiveToolBaseline) pi.setActiveTools?.(workerActiveToolBaseline);
    const aggregate = hostEnv().process.env.PI_TEAM_BRIGHT_WORKER_AGGREGATE;
    if (aggregate && ownsWorkerAggregate(aggregate)) {
      const cwd = ctx.cwd ?? hostEnv().process.cwd();
      const policy = loadWorkerResourcePolicy({ cwd, projectTrusted: projectTrust(ctx) === true });
      // Keep the fixed CLI path, but overwrite it atomically even if both
      // entries disappeared. Pi reload then sees native global/ancestor/project content.
      materializeWorkerAggregate({ cwd, policy, target: aggregate, force: true });
    } else if (aggregate) {
      ctx.ui?.notify?.("Pi Team Bright Worker aggregate path is not package-owned; reload refresh skipped.", "warning");
    }
  } else if (isTeammate && hostEnv().process.env.PI_TEAM_BRIGHT_WORKER_AGGREGATE) {
    // Best effort only: this disposable file is never orchestration authority.
    removeWorkerAggregate(hostEnv().process.env.PI_TEAM_BRIGHT_WORKER_AGGREGATE);
  }
  carrierObserver?.stop();
  carrierObserver = undefined;
  stopDeliveries();
  taskGraphPane.shutdown();
  clearTeamProjection(ctx);
});

pi.on("session_before_switch", () => { doctorGeneration++; });
pi.on("session_before_fork", () => { doctorGeneration++; });
pi.on("session_tree", (_event, ctx) => { compactionGate.reset(); doctorGeneration++; clearTeamProjection(ctx); });

pi.on("model_select", async (event) => {
  footerModel = event.model;
});

pi.on("context", async (event, ctx) => {
  await recipientDeliveries.observeContext(event.messages);
  if (isTeammate) return;
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  if (sessionId) modelToolJourney()?.port.coordination.setBranchEntries?.(exactLeaderSessionId(sessionId), ctx.sessionManager.getBranch());
});

pi.on("agent_start", async (_event, ctx) => {
  leaderRunSettled = false;
  syncNudgeConductor?.notify();
  if (isTeammate && teamName) {
    await writeCurrentTeammateRuntime(ctx, { runState: "active", lastHeartbeatAt: hostEnv().clock.now() });
  }
});

pi.on("agent_settled", async (_event, ctx) => {
  if (isTeammate && teamName) {
    await writeCurrentTeammateRuntime(ctx, { runState: "settled", lastHeartbeatAt: hostEnv().clock.now() });
  } else {
    leaderRunSettled = true;
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    if (sessionId) modelToolJourney()?.port.coordination.setBranchEntries?.(exactLeaderSessionId(sessionId), ctx.sessionManager.getBranch());
    syncNudgeConductor?.notify();
  }
});

pi.on("turn_end", async (event, ctx) => {
  const stopReason = event.message?.role === "assistant" ? event.message.stopReason : undefined;
  if (stopReason === "error" || stopReason === "aborted") {
    // An interrupted or failed turn does not change Worker liveness.
    return;
  }
  if (isTeammate && teamName) {
    await writeCurrentTeammateRuntime(ctx, {
      ready: true,
      lastHeartbeatAt: hostEnv().clock.now(),
      lastError: undefined,
    });
  }
  await recipientDeliveries.commitPresentedAfterSuccessfulTurn(stopReason);
});

pi.on("session_info_changed", async (_event, ctx) => {
  if (titleOwned) await refreshTeamFooter(ctx);
});

pi.on("turn_start", async (_event, ctx) => {
  await refreshTeamFooter(ctx);
  if (isTeammate) {
    if (teamName) {
      await writeCurrentTeammateRuntime(ctx, {
        lastHeartbeatAt: hostEnv().clock.now(),
      });
    }
  }
});

pi.on("before_agent_start", async (event, ctx) => {
  if (isTeammate) {
    if (teamName) {
      await writeCurrentTeammateRuntime(ctx, {
        lastHeartbeatAt: hostEnv().clock.now(),
      });
    }

    let modelInfo = "";
    let profileInfo = "";
    if (teamName) {
      try {
        const member = await teamQuery.workerProfile(teamName, agentName);
        if (member?.prompt) profileInfo = `\nYour standing Worker profile: ${member.prompt}`;
        if (member?.model || member?.modelAlias) {
          modelInfo = `\nYour configured initial model assignment: ${member.modelAlias ? `profile '${member.modelAlias}'` : member.model}`;
        }
      } catch {
        // Ignore unavailable Worker evidence.
      }
    }
    const currentModel = ctx.model;
    if (currentModel?.provider && currentModel?.id) {
      modelInfo += `\nYour current Pi model selection is ${currentModel.provider}/${currentModel.id} with thinking level ${ctx.thinkingLevel}. This is runtime Session evidence.`;
    }

    const taskInstruction = "Assigned Tasks are your work contracts. Canonical Task changes are delivered in context, but presentation never changes Task state. Waiting and ready are derived. Claim a ready Task before work. When the goal passes its external criteria, call task_update with goal_achieved and exact evidence. Use goal_failed when criteria fail; Task authority then applies any bounded failure edge. Use block only for an external blocker, and include blocker evidence. Use alert_send only for exceptional clarification or escalation; an alert never changes Task state. Re-read Task authority before a conflicting write.";
    return {
      systemPrompt: event.systemPrompt + `\n\nYou are Worker '${agentName}' on Team '${teamName}'.\nYour lead is 'team-lead'.${modelInfo}${profileInfo}\n${taskInstruction}`,
    };
  }
});
}

  return {
    modelToolLifecycle: {
      teamCreated: async (targetTeamName, sessionFile) => {
        doctorGeneration++;
        isTeammate = false;
        agentName = "team-lead";
        teamName = targetTeamName;
        currentMembershipId = await teamQuery.activeMembershipId(targetTeamName, "team-lead");
        const admission = await teamSessionLifecycleService.admitLead({ teamName: targetTeamName, sessionFile, placement: { kind: "unlocated" }, identitySource: "resumed_session", allowFirstRuntimeGeneration: true });
        if (admission.kind === "refused") {
          await refuseTeamSession(leaderContext, targetTeamName, "team-lead", admission, true);
          // team_create has already committed; preserve its established
          // post-commit callback failure projection rather than reporting a
          // created Team whose Pi Session admission was refused.
          throw new Error(admission.reason);
        }
        currentMembershipId = admission.member.membershipId;
        await activateRecipientDeliveries(leaderContext);
        await startSyncNudgeConductor(leaderContext);
        await refreshTeamFooter(leaderContext);
      },
      stopWorker: (targetTeamName, worker) => teamLifecycleService.stopWorker(targetTeamName, worker),
      shutdownTeam: async (targetTeamName) => {
        const result = await teamLifecycleService.shutdownTeam(targetTeamName);
        if (result.kind === "shutdown" && targetTeamName === teamName) {
          doctorGeneration++;
          stopDeliveries();
          teamName = null;
          currentMembershipId = undefined;
          clearTeamProjection(leaderContext);
        }
        return result;
      },
    },
    isTeammate: () => isTeammate,
    resolveCurrentWorkerContext,
    register() {
      // Hook registration remains one ordered lifecycle boundary.
      registerSessionHooks();
    },
  };
}
