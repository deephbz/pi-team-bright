import fs from "node:fs";
import path from "node:path";
import * as paths from "../utils/paths";
import * as runtime from "../utils/runtime";
import * as teams from "../utils/teams";
import { admitTeamSession, type SessionTerminalPlacement, type TeamIdentitySource, type TeamSessionAdmission } from "../utils/session-terminal";
import type { Member } from "./contracts";
import type { TeamLifecyclePublication } from "./team-lifecycle-publication";

export type SessionStartup =
  | { kind: "refused"; reason: string; exitProcess: boolean }
  | { kind: "admitted"; action: "claim" | "already_current"; member: Member };

export class TeamSessionLifecycleService {
  constructor(private readonly lifecyclePublication: TeamLifecyclePublication) {}

  async admitWorker(input: { teamName: string; workerName: string; sessionFile: string; placement: SessionTerminalPlacement; identitySource: TeamIdentitySource; launchId?: string; expectedMembershipId?: string }): Promise<SessionStartup> {
    const config = await teams.readConfig(input.teamName);
    const admission = admitTeamSession(config, input.workerName, input.placement, input.identitySource);
    if (admission.kind === "refused") return admission;
    const candidate = await teams.currentMembership(input.teamName, input.workerName);
    if (input.expectedMembershipId && candidate.membershipId !== input.expectedMembershipId) {
      return { kind: "refused", reason: `Worker ${input.workerName} started for stale Membership ${input.expectedMembershipId}.`, exitProcess: true };
    }
    return teams.withCurrentMembershipLease(input.teamName, candidate.membershipId!, async (current) => {
      if (input.expectedMembershipId) {
        const exact = await teams.currentMembership(input.teamName, input.workerName);
        if (exact.membershipId !== current.membershipId || exact.membershipId !== input.expectedMembershipId) {
          return { kind: "refused", reason: `Worker ${input.workerName} started for a Membership that is no longer current.`, exitProcess: true };
        }
      }
      const runtimeAdmission = runtime.admitRuntimeStartup(current, input.sessionFile, await runtime.readRuntimeStatus(input.teamName, input.workerName), process.pid, runtime.probePidPresence, input.launchId);
      if (runtimeAdmission.kind === "refused") return { ...runtimeAdmission, exitProcess: true };
      if (runtimeAdmission.action === "already_current") return { kind: "admitted", action: "already_current", member: current };
      const startedAt = Date.now();
      await runtime.writeRuntimeStatus(input.teamName, input.workerName, { pid: process.pid, startedAt, lastHeartbeatAt: startedAt, ready: false, lastError: undefined }, current.membershipId);
      const bound = await teams.bindMemberSession(input.teamName, input.workerName, input.sessionFile, input.launchId, admission.update ?? {}, current.membershipId);
      await this.lifecyclePublication.recordWorkerSessionBound({ teamName: input.teamName, workerName: input.workerName, membershipId: bound.membershipId!, generation: { membershipId: bound.membershipId!, pid: process.pid, startedAt } });
      return { kind: "admitted", action: "claim", member: bound };
    });
  }

  async admitLead(input: { teamName: string; sessionFile: string; placement: SessionTerminalPlacement; identitySource: TeamIdentitySource; allowFirstRuntimeGeneration?: boolean }): Promise<SessionStartup> {
    const config = await teams.readConfig(input.teamName);
    const admission = admitTeamSession(config, "team-lead", input.placement, input.identitySource);
    if (admission.kind === "refused") return admission;
    const lead = await teams.assertCurrentSessionBinding(input.teamName, "team-lead", input.sessionFile);
    if (!lead.membershipId) throw new Error(`Current lead Membership for ${input.teamName} has no stable identity.`);
    return teams.withCurrentMembershipLease(input.teamName, lead.membershipId, async (lead) => {
      const status = await runtime.readRuntimeStatus(input.teamName, "team-lead");
      const runtimeAdmission = input.allowFirstRuntimeGeneration && status === null ? { kind: "admitted" as const, action: "claim" as const } : runtime.admitRuntimeStartup(lead, input.sessionFile, status);
      if (runtimeAdmission.kind === "refused") return { ...runtimeAdmission, exitProcess: true };
      if (runtimeAdmission.action === "already_current") return { kind: "admitted", action: "already_current", member: lead };
      const membershipId = lead.membershipId;
      if (!membershipId) throw new Error(`Current lead Membership for ${input.teamName} has no stable identity.`);
      const startedAt = Date.now();
      await runtime.writeRuntimeStatus(input.teamName, "team-lead", { pid: process.pid, startedAt }, membershipId);
      if (admission.update) await teams.updateMembership(input.teamName, membershipId, admission.update);
      const recordPath = paths.leadSessionPath(input.teamName);
      const dir = path.dirname(recordPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(recordPath, JSON.stringify({ pid: process.pid, sessionFile: input.sessionFile, startedAt }));
      return { kind: "admitted", action: "claim", member: lead };
    });
  }

  async recordAdmissionFailure(teamName: string, workerName: string): Promise<void> {
    const candidate = await teams.currentMembership(teamName, workerName);
    if (candidate.membershipId) await this.lifecyclePublication.recordWorkerFailed({ teamName, workerName, membershipId: candidate.membershipId });
  }

  async writeBoundWorkerRuntime(input: { teamName: string; workerName: string; sessionFile: string; membershipId?: string; updates: Partial<runtime.AgentRuntimeStatus> }): Promise<string> {
    const member = await teams.assertCurrentSessionBinding(input.teamName, input.workerName, input.sessionFile);
    if (!member.membershipId || (input.membershipId && input.membershipId !== member.membershipId)) throw new Error(`Runtime update rejected for stale Membership of ${input.workerName} on team ${input.teamName}.`);
    await runtime.writeRuntimeStatus(input.teamName, input.workerName, input.updates, member.membershipId);
    return member.membershipId;
  }
}
