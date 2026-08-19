import * as paths from "../utils/paths";
import * as runtime from "../utils/runtime";
import * as teams from "../utils/teams";
import { assertTeamTerminalTarget, memberTerminalTarget } from "../utils/terminal-target";
import { assertTargetSupportedByTerminal, terminalForTeam } from "../utils/team-terminal";
import type { Member } from "./contracts";
import type { AssignedWorkGuard } from "./assigned-work-guard";
import type { TeamLifecyclePublication } from "./team-lifecycle-publication";

export type TeamWorkerStopResult =
  | { kind: "stopped"; worker: string }
  | { kind: "refused"; worker: string; reason: "worker_not_found" | "nonterminal_tasks_assigned" | "stop_not_confirmed" | "leader_reserved"; message: string; guardingTaskIds?: string[] };

export type TeamShutdownResult =
  | { kind: "shutdown"; stoppedWorkers: string[]; unfinishedTaskIds: string[] }
  | { kind: "partial"; stoppedWorkers: string[]; failedWorkers: string[]; unfinishedTaskIds: string[] };

export interface TeamLifecycleServiceDependencies {
  assignedWorkGuard: AssignedWorkGuard;
  lifecyclePublication: TeamLifecyclePublication;
}

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

export class TeamLifecycleService {
  constructor(private readonly dependencies: TeamLifecycleServiceDependencies) {}

  async stopWorker(teamName: string, worker: string): Promise<TeamWorkerStopResult> {
    const safeTeamName = paths.sanitizeName(teamName);
    const safeWorker = paths.sanitizeName(worker);
    return teams.withTeamTopologyLease(safeTeamName, async () => {
      const config = await teams.readConfig(safeTeamName);
      const member = [...config.members].reverse().find((candidate) => candidate.name === safeWorker && candidate.isActive !== false);
      if (!member) return { kind: "refused", worker: safeWorker, reason: "worker_not_found", message: `Worker ${safeWorker} is not current.` };
      if (member.name === "team-lead" || member.agentType === "lead") return { kind: "refused", worker: safeWorker, reason: "leader_reserved", message: "The Team leader is reserved; use team_shutdown for whole-Team closure." };
      const guardingTaskIds = await this.dependencies.assignedWorkGuard.nonterminalTaskIdsAssignedToWorker(safeTeamName, safeWorker);
      if (guardingTaskIds.length > 0) return { kind: "refused", worker: safeWorker, reason: "nonterminal_tasks_assigned", message: `Worker ${safeWorker} has nonterminal Tasks.`, guardingTaskIds };
      try {
        const changed = await this.transitionCurrentMembership(safeTeamName, member, "process_shutdown", true);
        await this.dependencies.lifecyclePublication.recordWorkerStopped({ teamName: safeTeamName, workerName: safeWorker, membershipId: member.membershipId! });
        if (!changed.member) return { kind: "refused", worker: safeWorker, reason: "stop_not_confirmed", message: `Worker ${safeWorker} was not deactivated.` };
        return { kind: "stopped", worker: safeWorker };
      } catch (error) {
        return { kind: "refused", worker: safeWorker, reason: "stop_not_confirmed", message: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async shutdownTeam(teamName: string): Promise<TeamShutdownResult> {
    const safeTeamName = paths.sanitizeName(teamName);
    return teams.withTeamTopologyLease(safeTeamName, async () => {
      const config = await teams.readConfig(safeTeamName);
      // This authoritative snapshot is the shutdown admission preflight. Do
      // not stop a carrier or deactivate any Membership until it succeeds.
      const unfinishedTaskIds = await this.dependencies.assignedWorkGuard.nonterminalTaskIds(safeTeamName);
      const current = config.members.filter((member) => member.isActive !== false);
      const teammates = current.filter((member) => member.name !== "team-lead" && member.agentType !== "lead");
      const stoppedWorkers: string[] = [];
      const failedWorkers: string[] = [];
      await Promise.all(teammates.map(async (member) => {
        try {
          const changed = await this.transitionCurrentMembership(safeTeamName, member, "team_shutdown", true);
          if (changed.member) stoppedWorkers.push(member.name);
        } catch {
          failedWorkers.push(member.name);
        }
      }));
      if (failedWorkers.length === 0) {
        const lead = current.find((member) => member.name === "team-lead" || member.agentType === "lead");
        if (lead) {
          const leadStatus = await runtime.readRuntimeStatus(safeTeamName, lead.name);
          const leadRuntime = exactRuntimeGeneration(lead, leadStatus);
          // A non-null record is evidence that must match this exact lead
          // Membership. Never deactivate the lead around malformed or foreign
          // runtime evidence, and never delete evidence we do not own.
          if (leadStatus && !leadRuntime) {
            failedWorkers.push(lead.name);
          } else {
            let deleted = false;
            try {
              // Exact deletion is fenced before Membership deactivation. If the
              // latter cannot commit, restore this exact generation so the lead
              // remains wholly current and the established partial result can
              // be retried without a dangling active Membership.
              if (leadRuntime) {
                deleted = await runtime.deleteRuntimeStatus(safeTeamName, lead.name, leadRuntime);
                if (!deleted) throw new Error("Lead runtime generation changed before exact cleanup.");
              }
              const changed = await this.transitionCurrentMembership(safeTeamName, lead, "team_shutdown", false);
              if (!changed.member) throw new Error("Lead Membership changed before shutdown deactivation.");
            } catch {
              if (deleted && leadStatus) {
                try {
                  await runtime.restoreRuntimeStatus(safeTeamName, lead.name, leadStatus, leadRuntime!);
                } catch {
                  // The shutdown result remains partial; the caller retains the
                  // Membership and can retry exact runtime reconciliation.
                }
              }
              failedWorkers.push(lead.name);
            }
          }
        }
      }
      if (failedWorkers.length > 0) return { kind: "partial", stoppedWorkers: stoppedWorkers.sort(), failedWorkers: failedWorkers.sort(), unfinishedTaskIds };
      return { kind: "shutdown", stoppedWorkers: stoppedWorkers.sort(), unfinishedTaskIds };
    });
  }

  private async killTeammate(teamName: string, member: Member): Promise<void> {
    if (member.name === "team-lead") throw new Error("The team leader has no teammate terminal stop operation.");
    if (!member.membershipId) throw new Error(`Cannot stop ${member.name}: its current Membership has no stable identity.`);
    const status = await runtime.readRuntimeStatus(teamName, member.name);
    const observedGeneration = exactRuntimeGeneration(member, status);
    if (exactBoundProcessAlreadyExited(observedGeneration)) {
      const deleted = await runtime.deleteRuntimeStatus(teamName, member.name, observedGeneration!);
      if (!deleted) throw new Error(`Cannot confirm shutdown of ${member.name}: its runtime process generation changed after exit evidence. The Membership remains current; inspect the resumed process and retry.`);
      return;
    }
    const teamConfig = await teams.readConfig(teamName);
    const teamTerminal = terminalForTeam(teamConfig);
    const target = teamConfig.terminalBackend ? assertTeamTerminalTarget(teamConfig, member) : memberTerminalTarget(member, teamTerminal.name);
    if (!target) throw new Error(`Cannot stop ${member.name}: this Membership has no terminal binding and no exact Membership-bound runtime record proves the process exited. The Membership remains current.`);
    assertTargetSupportedByTerminal(teamTerminal, target);
    if (target.kind === "window") {
      teamTerminal.killWindow(target.targetId);
      if (teamTerminal.isWindowAlive(target.targetId)) throw new Error(`Cannot confirm shutdown of ${member.name}: ${teamTerminal.name} did not stop window ${target.targetId}. The Membership remains current; close the process manually and retry.`);
    } else {
      teamTerminal.kill(target.targetId);
      if (teamTerminal.isAlive(target.targetId)) throw new Error(`Cannot confirm shutdown of ${member.name}: ${teamTerminal.name} did not stop pane ${target.targetId}. The Membership remains current; close the process manually and retry.`);
    }
    if (observedGeneration) await runtime.deleteRuntimeStatus(teamName, member.name, observedGeneration);
  }

  private async transitionCurrentMembership(teamName: string, member: Member, reason: NonNullable<Member["deactivationReason"]>, stopTerminal: boolean): Promise<{ member: Member | null }> {
    if (!member.membershipId) throw new Error(`Current Membership for ${member.name} on team ${teamName} has no membershipId.`);
    return teams.withCurrentMembershipLease(teamName, member.membershipId, async (current) => {
      if (stopTerminal) await this.killTeammate(teamName, current);
      return { member: await teams.deactivateMembership(teamName, member.membershipId!, reason) };
    });
  }
}
