import { hostEnv } from "../env/host-env";
import fs from "node:fs";
import path from "node:path";
import * as paths from "../utils/paths";
import * as runtime from "../utils/runtime";
import * as teams from "../utils/teams";
import { withUnboundedLockWait } from "../utils/lock";
import { admitTeamSession, type SessionTerminalPlacement, type TeamIdentitySource, type TeamSessionAdmission } from "../utils/session-terminal";
import { recordWorkerLaunchStage, withSemanticTrace } from "../utils/trace";
import type { Member } from "./contracts";
import type { TeamLifecyclePublication } from "./team-lifecycle-publication";

export type SessionStartup =
  | { kind: "refused"; reason: string; exitProcess: boolean }
  | { kind: "admitted"; action: "claim" | "already_current"; member: Member };

export class TeamSessionLifecycleService {
  constructor(private readonly lifecyclePublication: TeamLifecyclePublication) {}

  async admitWorker(input: { teamName: string; workerName: string; sessionFile: string; placement: SessionTerminalPlacement; identitySource: TeamIdentitySource; launchId?: string; expectedMembershipId?: string }): Promise<SessionStartup> {
    return withSemanticTrace(
      "worker_session_admission",
      { teamName: input.teamName, workerName: input.workerName },
      () => withUnboundedLockWait(() => this.admitWorkerWithTrace(input)),
    );
  }

  private async admitWorkerWithTrace(input: { teamName: string; workerName: string; sessionFile: string; placement: SessionTerminalPlacement; identitySource: TeamIdentitySource; launchId?: string; expectedMembershipId?: string }): Promise<SessionStartup> {
    const admissionStartedAt = hostEnv().clock.now();
    recordWorkerLaunchStage("worker_session_started");
    const config = await teams.readConfig(input.teamName);
    const admission = admitTeamSession(config, input.workerName, input.placement, input.identitySource);
    if (admission.kind === "refused") return admission;
    const candidate = await teams.currentMembership(input.teamName, input.workerName);
    recordWorkerLaunchStage("membership_validated", { membershipId: candidate.membershipId });
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
      if (input.launchId && current.launch && current.launch.launchId !== input.launchId) {
        return { kind: "refused", reason: "Startup belongs to a superseded launchId.", exitProcess: true };
      }
      const status = await runtime.readRuntimeStatus(input.teamName, input.workerName);
      if (status?.lastStop && status.lastStop.observedAt > admissionStartedAt) return { kind: "refused", reason: "A newer shutdown superseded this admission.", exitProcess: false };
      const runtimeAdmission = runtime.admitRuntimeStartup(current, input.sessionFile, status, hostEnv().process.pid, undefined, input.launchId);
      if (runtimeAdmission.kind === "refused") {
        recordWorkerLaunchStage("runtime_admission_refused", { membershipId: current.membershipId! });
        return { ...runtimeAdmission, exitProcess: true };
      }
      if (runtimeAdmission.action === "already_current") {
        const identity = runtime.ownBirthIdentity();
        if (status && (status.lastStop || (identity.osBirthToken && status.osBirthToken !== identity.osBirthToken))) await runtime.writeRuntimeStatus(input.teamName, input.workerName, { ...identity, lastStop: undefined }, current.membershipId);
        return { kind: "admitted", action: "already_current", member: current };
      }
      const startedAt = hostEnv().clock.now();
      await runtime.writeRuntimeStatus(input.teamName, input.workerName, { pid: hostEnv().process.pid, ...runtime.ownBirthIdentity(), startedAt, lastHeartbeatAt: startedAt, ready: false, lastError: undefined }, current.membershipId);
      recordWorkerLaunchStage("runtime_generation_claimed", { membershipId: current.membershipId! });
      const bound = await teams.bindMemberSession(input.teamName, input.workerName, input.sessionFile, input.launchId, admission.update ?? {}, current.membershipId);
      recordWorkerLaunchStage("session_bound_persisted", { membershipId: bound.membershipId! });
      await this.lifecyclePublication.recordWorkerSessionBound({ teamName: input.teamName, workerName: input.workerName, membershipId: bound.membershipId!, generation: { membershipId: bound.membershipId!, pid: hostEnv().process.pid, startedAt } });
      recordWorkerLaunchStage("session_bound_published", { membershipId: bound.membershipId! });
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
      if (runtimeAdmission.action === "already_current") {
        const identity = runtime.ownBirthIdentity();
        if (status && (status.lastStop || (identity.osBirthToken && status.osBirthToken !== identity.osBirthToken))) await runtime.writeRuntimeStatus(input.teamName, "team-lead", { ...identity, lastStop: undefined }, lead.membershipId);
        return { kind: "admitted", action: "already_current", member: lead };
      }
      const membershipId = lead.membershipId;
      if (!membershipId) throw new Error(`Current lead Membership for ${input.teamName} has no stable identity.`);
      const startedAt = hostEnv().clock.now();
      await runtime.writeRuntimeStatus(input.teamName, "team-lead", { pid: hostEnv().process.pid, ...runtime.ownBirthIdentity(), startedAt }, membershipId);
      if (admission.update) await teams.updateMembership(input.teamName, membershipId, admission.update);
      const recordPath = paths.leadSessionPath(input.teamName);
      const dir = path.dirname(recordPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(recordPath, JSON.stringify({ pid: hostEnv().process.pid, sessionFile: input.sessionFile, startedAt }));
      return { kind: "admitted", action: "claim", member: lead };
    });
  }

  async recordStop(input: { teamName: string; workerName: string; sessionFile: string; membershipId: string; piReason: NonNullable<runtime.AgentRuntimeStatus["lastStop"]>["piReason"]; targetSessionFile?: string }): Promise<void> {
    const observedAt = hostEnv().clock.now();
    await teams.withCurrentSessionBinding(input.teamName, input.workerName, input.sessionFile, input.membershipId, async () => {
      const status = await runtime.readRuntimeStatus(input.teamName, input.workerName);
      if (status?.pid !== hostEnv().process.pid || status.membershipId !== input.membershipId) return;
      await runtime.writeRuntimeStatus(input.teamName, input.workerName, { lastStop: {
        piReason: input.piReason, targetSessionFile: input.targetSessionFile,
        observedAt, suspectedHumanStop: !status.stopRequested && input.piReason !== "reload",
      } }, input.membershipId);
    });
  }

  async recordAdmissionFailure(teamName: string, workerName: string): Promise<void> {
    const candidate = await teams.currentMembership(teamName, workerName);
    if (candidate.membershipId) await this.lifecyclePublication.recordWorkerFailed({ teamName, workerName, membershipId: candidate.membershipId });
  }

  async writeBoundWorkerRuntime(input: { teamName: string; workerName: string; sessionFile: string; membershipId?: string; updates: Partial<runtime.AgentRuntimeStatus> }): Promise<string> {
    const member = await teams.assertCurrentSessionBinding(input.teamName, input.workerName, input.sessionFile);
    if (!member.membershipId || (input.membershipId && input.membershipId !== member.membershipId)) throw new Error(`Runtime update rejected for stale Membership of ${input.workerName} on team ${input.teamName}.`);
    await teams.withCurrentSessionBinding(input.teamName, input.workerName, input.sessionFile, member.membershipId, async () => {
      await runtime.writeRuntimeStatus(input.teamName, input.workerName, input.updates, member.membershipId);
    });
    return member.membershipId;
  }
}
