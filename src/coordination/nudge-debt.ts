import { createHash } from "node:crypto";
import type { CoordinationLeaderBindingEvidence } from "./queries";
import type { CoordinationSyncProbe } from "./observation-contracts";

export type SyncNudgeDebt =
  | { kind: "none" }
  | {
      kind: "eligible";
      /** Exact content coordinate. Changes as canonical unseen content changes. */
      debtKey: string;
      /** Exact binding and native branch baseline. Stays stable as content accumulates. */
      scopeKey: string;
      /** Count from the shared canonical, nonblocking observation projection. */
      updateCount: number;
      requestedView: "snapshot" | "updates";
      teamEpochId: string;
      leaderSessionId: string;
      leaderMembershipId: string;
      branchLineage: string[];
      branchId: string;
      policyVersion: string;
    }
  | { kind: "indeterminate"; message: string }
  | { kind: "unavailable"; message: string };

type BoundNudgeTeam = {
  teamName: string;
  sessionFile: string;
  config: CoordinationLeaderBindingEvidence & {
    epochId: string;
    syncLiveness: {
      autoSyncEnabled?: boolean;
      /** Persisted old Team records retain this evidence. */
      nudgeEnabled?: boolean;
      policyVersion?: string;
    };
  };
};

export interface CoordinationNudgeProbeReader {
  selectTeamSyncView(file: string, ids: string[]): Promise<"snapshot" | "updates">;
  peekTeamSync(
    exactSessionFile: string,
    view: "snapshot" | "updates",
    branchLineage: string[],
  ): Promise<CoordinationSyncProbe>;
}

function currentLead(config: CoordinationLeaderBindingEvidence, sessionFile: string) {
  return [...config.members].reverse().find((member) =>
    member.name === "team-lead" && member.agentType === "lead" &&
    member.isActive !== false && member.sessionFile === sessionFile);
}

/** Derive scheduling debt from the same canonical projection used for model delivery. */
export class CoordinationNudgeDebtService {
  constructor(
    private readonly probe: CoordinationNudgeProbeReader,
  ) {}

  async read(bound: BoundNudgeTeam, branchLineage: string[]): Promise<SyncNudgeDebt> {
    const { config } = bound;
    if (!(config.syncLiveness.autoSyncEnabled ?? config.syncLiveness.nudgeEnabled ?? true)) return { kind: "none" };
    const branchId = branchLineage.at(-1);
    if (!branchId || new Set(branchLineage).size !== branchLineage.length) return { kind: "none" };
    const lead = currentLead(config, bound.sessionFile);
    if (!lead?.membershipId) return { kind: "none" };
    const requestedView = await this.probe.selectTeamSyncView(bound.sessionFile, branchLineage);
    let projection: CoordinationSyncProbe;
    try {
      projection = await this.probe.peekTeamSync(bound.sessionFile, requestedView, branchLineage);
    } catch {
      return { kind: "indeterminate", message: "Team observation probe is unavailable; automatic sync is suppressed." };
    }
    if (projection.kind === "quiet") return { kind: "none" };
    if (projection.kind === "indeterminate") return projection;
    if (projection.kind === "unavailable" || projection.kind === "contract_gap" || projection.kind === "snapshot_required") {
      return { kind: "unavailable", message: projection.message };
    }
    if (projection.kind !== "prepared") {
      return { kind: "indeterminate", message: "Team observation probe returned a mismatched view; automatic sync is suppressed." };
    }
    if (!Number.isSafeInteger(projection.updateCount) || projection.updateCount < 0 || !projection.scopeKey) {
      return { kind: "indeterminate", message: "Team observation probe lacks an exact update count or scope; automatic sync is suppressed." };
    }
    // A bounded current page may contain only leader changes while a one-scan
    // lookahead proves an eligible external change on a later page. Schedule
    // this canonical page by deadline; do not count raw lookahead evidence.
    if (projection.updateCount === 0 && projection.continuationEligible !== true) return { kind: "none" };
    const debtKey = createHash("sha256")
      .update(JSON.stringify([projection.scopeKey, projection.result]))
      .digest("hex");
    return {
      kind: "eligible", debtKey, scopeKey: projection.scopeKey,
      updateCount: projection.updateCount, requestedView: projection.result.kind,
      teamEpochId: config.epochId, leaderSessionId: bound.sessionFile,
      leaderMembershipId: lead.membershipId, branchLineage: [...branchLineage],
      branchId, policyVersion: config.syncLiveness.policyVersion ?? "legacy",
    };
  }
}
