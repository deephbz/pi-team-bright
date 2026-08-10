import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import * as paths from "../src/utils/paths";
import * as teams from "../src/utils/teams";
import * as runtime from "../src/utils/runtime";
import { DirectMessageDelivery, messagePollMs } from "../src/alert-authority/direct-delivery";
import { TaskChangeDelivery, taskPollMs } from "../src/utils/task-delivery";
import { SyncNudgeConductor, type SyncNudgeDebt } from "../src/utils/sync-nudge-conductor";
import { createSyncNudgeRecord, findSyncNudgeReservation, presentSyncNudge, readSyncNudges, reserveSyncNudge, SYNC_NUDGE_CUSTOM_TYPE, validateSyncNudgeRecord, syncNudgeContent } from "../src/utils/sync-nudge";
import { clearTeamFooter, syncTeamFooter } from "../src/utils/team-footer";
import { loadWorkerResourcePolicy, materializeWorkerAggregate, ownsWorkerAggregate, projectWorkerTools, removeWorkerAggregate, type WorkerResourcePolicy } from "../src/utils/worker-resource-projection";
import type { Member, TeamConfig } from "../src/team-authority/contracts";
import { placeSessionTerminal, type TeamIdentitySource, type TeamSessionAdmission } from "../src/utils/session-terminal";
import { exactLeaderSessionId } from "../src/model-tool-contract/runtime";
import type { ModelToolLifecycle } from "../src/model-tool-contract/durable-model-tool-port";
import { BeadsTaskReconciliationQuery } from "../src/task-authority/beads-reconciliation-query";
import type { TeamLifecycleService } from "../src/team-authority/team-lifecycle-service";
import type { TeamSessionLifecycleService } from "../src/team-authority/team-session-lifecycle-service";
import { diagnoseTeam, formatTeamStatus, getPiTeamsArgumentCompletions, knownTeamNames, parsePiTeamsCommand, PI_TEAMS_COMMAND_USAGE, type TeamSessionBindingStatus } from "../src/utils/team-status";
import { getTerminalAdapter } from "../src/adapters/terminal-registry";

export interface PiTeamSessionAdapter {
  readonly modelToolLifecycle: ModelToolLifecycle;
  readonly isTeammate: () => boolean;
  readonly resolveCurrentWorkerContext: (ctx: any) => Promise<{ teamName: string; member: Member }>;
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
  leaderToolNames: ReadonlySet<string>;
  workerToolNames: ReadonlySet<string>;
  refreshAlertToolProjection: () => void;
  registerRecoveredWorkerTools: () => void;
}): PiTeamSessionAdapter {
  const { pi, teamSessionLifecycleService, teamLifecycleService, getModelToolJourney, modelToolBranchIds, projectTrust, lifecyclePublication, leaderToolNames, workerToolNames, refreshAlertToolProjection, registerRecoveredWorkerTools } = options;
  const terminal = getTerminalAdapter();
  let isTeammate = !!process.env.PI_AGENT_NAME && process.env.PI_AGENT_NAME !== "team-lead";
  let agentName = process.env.PI_AGENT_NAME || "team-lead";
  const envTeamName = process.env.PI_TEAM_NAME;
  const envLaunchId = process.env.PI_AGENT_LAUNCH_ID;
  let teamName: string | null = envTeamName || teams.findLeadTeamForSession();
  let currentMembershipId: string | undefined;
  let directMessageDelivery: DirectMessageDelivery | null = null;
  let taskChangeDelivery: TaskChangeDelivery | null = null;
  let syncNudgeConductor: SyncNudgeConductor | null = null;
  let stopSyncNudgeMonitor: (() => void) | null = null;
  let leaderRunSettled = false;
  let leaderContext: any;
  let directMessageSessionEligible = true;
  let taskChangeSessionEligible = true;
  let footerModel: any;
  let workerResourcePolicy: WorkerResourcePolicy | undefined;
  let workerActiveToolBaseline: string[] | undefined;
  const identitySource: TeamIdentitySource = process.env.PI_AGENT_NAME ? "launch_env" : "resumed_session";

  const modelToolJourney = () => getModelToolJourney();

function configureWorkerResources(ctx: any): void {
  if (!isTeammate) return;
  const cwd = ctx.cwd ?? process.cwd();
  workerResourcePolicy = loadWorkerResourcePolicy({ cwd, projectTrusted: projectTrust(ctx) ?? true });
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
  for (const message of workerResourcePolicy.diagnostics) ctx.ui?.notify?.(`Pi Team Bright Worker settings: ${message}`, "warning");
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

function stopSyncNudgeConductor() {
  syncNudgeConductor?.stop();
  syncNudgeConductor = null;
  stopSyncNudgeMonitor?.();
  stopSyncNudgeMonitor = null;
}

function syncNudgeMessageDelivered(ctx: any, record: { id: string; branchLineage: readonly string[] }): boolean {
  const branch = ctx?.sessionManager?.getBranch?.() ?? [];
  const ids = branch.map((entry: any) => entry.id);
  if (record.branchLineage.some((id, index) => ids[index] !== id)) return false;
  return branch.some((entry: any) => {
    if (entry.type !== "custom_message" || entry.customType !== SYNC_NUDGE_CUSTOM_TYPE) return false;
    const details = validateSyncNudgeRecord(entry.details);
    return details?.kind === "presented" && details.id === record.id
      && details.branchLineage.length === record.branchLineage.length
      && details.branchLineage.every((value, index) => value === record.branchLineage[index]);
  });
}

function startSyncNudgeConductor(ctx: any) {
  stopSyncNudgeConductor();
  if (isTeammate || !teamName || agentName !== "team-lead" || !modelToolJourney()?.port.readSyncNudgeDebt) return;
  let config: TeamConfig;
  try { config = JSON.parse(fs.readFileSync(paths.configPath(teamName), "utf8")) as TeamConfig; } catch { return; }
  const policy = config.syncLiveness;
  if (!policy?.nudgeEnabled || policy.nudgeDelaySeconds === undefined) return;
  const delayMs = Math.max(0, policy.nudgeDelaySeconds * 1000);
  // Model-tool registration normally binds lazily on the first tool call.
  // Resume nudge reconciliation has no such call, so bind the exact current
  // Pi Session before it can ask the port for debt.
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  if (!sessionId || !sessionFile) return;
  modelToolJourney().port.setLeaderSessionFile?.(exactLeaderSessionId(sessionId), sessionFile);
  const debt = async (): Promise<SyncNudgeDebt> => {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    const branch = modelToolBranchIds(ctx);
    if (!sessionId || branch.length === 0) return { kind: "none" };
    return modelToolJourney()!.port.readSyncNudgeDebt!(exactLeaderSessionId(sessionId), branch);
  };
  const busy = (): boolean => {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    return !leaderRunSettled || ctx?.isIdle?.() === false || !!ctx?.hasPendingMessages?.()
      || (!!sessionId && !!modelToolJourney()?.port.getPendingObservation?.(exactLeaderSessionId(sessionId)));
  };
  syncNudgeConductor = new SyncNudgeConductor({
    clock: { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
    delayMs,
    readDebt: debt,
    isSettled: () => leaderRunSettled,
    isBusy: busy,
    alreadyPresented: (debtKey, branchLineage) => readSyncNudges(teamName!).some((record) => record.debtKey === debtKey && record.branchLineage.length === branchLineage.length && record.branchLineage.every((value, index) => value === branchLineage[index])),
    present: async (candidate) => {
      const sessionFile = ctx?.sessionManager?.getSessionFile?.();
      const sessionId = ctx?.sessionManager?.getSessionId?.();
      const branch = modelToolBranchIds(ctx);
      if (!sessionFile || !sessionId || branch.length === 0 || busy()) return;
      const current = await teams.readConfig(teamName!);
      if (current.epochId !== candidate.teamEpochId || current.leadSessionId !== sessionFile) return;
      const currentLead = await teams.assertCurrentSessionBinding(teamName!, "team-lead", sessionFile);
      if (currentLead.membershipId !== candidate.leaderMembershipId) return;
      const latest = await modelToolJourney()!.port.readSyncNudgeDebt!(exactLeaderSessionId(sessionId), branch);
      if (latest.kind !== "eligible" || latest.debtKey !== candidate.debtKey || latest.branchId !== candidate.branchId || latest.leaderMembershipId !== candidate.leaderMembershipId || latest.branchLineage.length !== candidate.branchLineage.length || latest.branchLineage.some((value: string, index: number) => value !== candidate.branchLineage[index]) || busy()) return;
      const existing = findSyncNudgeReservation(teamName!, candidate.debtKey, candidate.branchLineage);
      if (existing && syncNudgeMessageDelivered(ctx, existing)) {
        presentSyncNudge(existing);
        return;
      }
      const record = existing ?? createSyncNudgeRecord({
        kind: "reserved",
        id: randomUUID(), teamName: teamName!, teamEpochId: candidate.teamEpochId,
        leaderSessionId: candidate.leaderSessionId, leaderMembershipId: candidate.leaderMembershipId,
        branchLineage: [...candidate.branchLineage], branchId: candidate.branchId, debtKey: candidate.debtKey,
        requestedView: candidate.requestedView, reservedAt: new Date().toISOString(), policyVersion: candidate.policyVersion,
      });
      if (!existing) reserveSyncNudge(record);
      const presented = createSyncNudgeRecord({ ...record, kind: "presented", presentedAt: new Date().toISOString() });
      // Reservation is internal. The model receives only the validated
      // presented semantic record; persistence follows exact Session proof.
      pi.sendMessage({ customType: SYNC_NUDGE_CUSTOM_TYPE, content: syncNudgeContent(presented), display: true, details: presented }, { triggerTurn: true, deliverAs: "followUp" });
      // Promote only after the durable Session contains this exact custom
      // message on the same full branch lineage.
      if (syncNudgeMessageDelivered(ctx, presented)) presentSyncNudge(record, presented.presentedAt);
    },
  });
  const eventDirectory = path.join(paths.teamDir(teamName), "events");
  fs.mkdirSync(eventDirectory, { recursive: true });
  const watcher = fs.watch(eventDirectory, () => syncNudgeConductor?.notify());
  watcher.on("error", () => syncNudgeConductor?.notify());
  const interval = setInterval(() => syncNudgeConductor?.notify(), Math.max(5_000, Math.min(30_000, Math.max(100, delayMs))));
  interval.unref?.();
  syncNudgeConductor.start();
  stopSyncNudgeMonitor = () => { watcher.close(); clearInterval(interval); };
}

function stopDeliveries() {
  stopSyncNudgeConductor();
  directMessageDelivery?.stop();
  directMessageDelivery = null;
  taskChangeDelivery?.stop();
  taskChangeDelivery = null;
}

/** Resolve the one exact current Team and Worker identity for Worker tools. */
async function resolveCurrentWorkerContext(ctx: any): Promise<{ teamName: string; member: Member }> {
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  if (!sessionFile) throw new Error("A durable Pi Session is required for every Worker tool operation.");
  const binding = await teams.resolveCurrentTeammateSessionBinding(sessionFile);
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
    reconciliationQuery: new BeadsTaskReconciliationQuery(teamName),
  });
  await taskChangeDelivery.start(ctx.sessionManager?.buildContextEntries?.() ?? ctx.sessionManager?.getEntries?.() ?? []);
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
  if (!shutdownCandidate) {
    await teamSessionLifecycleService.recordAdmissionFailure(refusedTeam, role).catch(() => undefined);
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

function registerSessionHooks() {
  pi.on("session_start", async (event, ctx) => {
  paths.ensureDirs();
  stopDeliveries();
  leaderRunSettled = false;
  leaderContext = ctx;
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
      refreshAlertToolProjection();
      registerRecoveredWorkerTools();
    }
  }
  // A fresh lead process has no lead environment variables either. Match
  // its resumed Pi session to the durable lead record.
  if (!isTeammate && !teamName) {
    teamName = teams.findLeadTeamForSession(piSessionFile);
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
      let startup: Awaited<ReturnType<typeof teamSessionLifecycleService.admitWorker>>;
      try {
        startup = await teamSessionLifecycleService.admitWorker({
          teamName,
          workerName: agentName,
          sessionFile: piSessionFile,
          placement: placeSessionTerminal(teamConfig, terminal, process.env.TMUX_PANE),
          identitySource,
          launchId: envLaunchId,
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
      let runtimeAdmission: Awaited<ReturnType<typeof teamSessionLifecycleService.admitLead>>;
      try {
        runtimeAdmission = await teamSessionLifecycleService.admitLead({
          teamName,
          sessionFile: piSessionFile,
          placement: placeSessionTerminal(teamConfig, terminal, process.env.TMUX_PANE),
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
        await refuseTeamSession(ctx, teamName, "team-lead", { kind: "refused", reason: runtimeAdmission.reason, exitProcess: true }, true);
        return;
      }
      currentMembershipId = runtimeAdmission.member.membershipId;
    }
    await startDirectMessageDelivery(ctx);
    await startTaskChangeDelivery(ctx);
  }
  if (!isTeammate) {
    // A resumed/reloaded idle Session has no active agent run. This is
    // positive settled evidence, unlike a fresh startup before agent_start.
    leaderRunSettled = event.reason === "resume" || event.reason === "reload";
    startSyncNudgeConductor(ctx);
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
      const policy = loadWorkerResourcePolicy({ cwd, projectTrusted: projectTrust(ctx) ?? true });
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

pi.on("agent_start", async (_event, ctx) => {
  leaderRunSettled = false;
  syncNudgeConductor?.notify();
  if (isTeammate && teamName) {
    await writeCurrentTeammateRuntime(ctx, { runState: "active", lastHeartbeatAt: Date.now() });
  }
});

pi.on("agent_settled", async (_event, ctx) => {
  if (isTeammate && teamName) {
    await writeCurrentTeammateRuntime(ctx, { runState: "settled", lastHeartbeatAt: Date.now() });
  } else {
    leaderRunSettled = true;
    syncNudgeConductor?.notify();
  }
});

pi.on("turn_end", async (event, ctx) => {
  const stopReason = event.message?.role === "assistant" ? event.message.stopReason : undefined;
  if (stopReason === "error" || stopReason === "aborted") {
    if (isTeammate && teamName && currentMembershipId) {
      await lifecyclePublication.recordWorkerFailed({ teamName, workerName: agentName, membershipId: currentMembershipId }).catch(() => undefined);
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
      ? "Assigned Tasks are your work contracts. Canonical Task changes are delivered in context, but presentation never changes Task state. Stopped-epoch migration is explicit and never runs during normal runtime. Set an accepted Task in_progress when work starts. When you finish, call task_update yourself to set it closed and append verification evidence; never leave completion only in a TUI reply. If the work is blocked, call task_update with status blocked, concrete blocker evidence, and the next action. Use alert_send only for exceptional clarification or escalation; an alert never completes or blocks a Task. Re-read Task authority before a conflicting write."
      : "This fork is a new Session identity and receives none of the source Agent's pending Task changes.";
    return {
      systemPrompt: event.systemPrompt + `\n\nYou are Worker '${agentName}' on Team '${teamName}'.\nYour lead is 'team-lead'.${modelInfo}${profileInfo}\n${taskInstruction}`,
    };
  }
});
}

  return {
    modelToolLifecycle: {
      teamCreated: async (targetTeamName, sessionFile) => {
        isTeammate = false;
        agentName = "team-lead";
        teamName = targetTeamName;
        const config = await teams.readConfig(targetTeamName);
        currentMembershipId = config.members.find((member) => member.name === "team-lead" && member.isActive !== false)?.membershipId;
        const admission = await teamSessionLifecycleService.admitLead({ teamName: targetTeamName, sessionFile, placement: { kind: "unlocated" }, identitySource: "resumed_session", allowFirstRuntimeGeneration: true });
        if (admission.kind === "admitted") currentMembershipId = admission.member.membershipId;
        startSyncNudgeConductor(leaderContext);
      },
      stopWorker: (targetTeamName, worker) => teamLifecycleService.stopWorker(targetTeamName, worker),
      shutdownTeam: (targetTeamName) => teamLifecycleService.shutdownTeam(targetTeamName),
    },
    isTeammate: () => isTeammate,
    resolveCurrentWorkerContext,
    register() {
      // Hook registration remains one ordered lifecycle boundary.
      registerSessionHooks();
    },
  };
}
