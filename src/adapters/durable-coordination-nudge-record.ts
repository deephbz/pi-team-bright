import type { CoordinationNudgeRecordPort } from "../coordination/nudge-record-port";
import { findSyncNudgeReservation, presentSyncNudge, readSyncNudges, reserveSyncNudge } from "../utils/sync-nudge";

/** Durable implementation of Pi's consumer-owned derived-nudge record port. */
export class DurableCoordinationNudgeRecord implements CoordinationNudgeRecordPort {
  readPresented(teamName: string) { return readSyncNudges(teamName); }
  findReservation(teamName: string, debtKey: string, branchLineage: readonly string[]) { return findSyncNudgeReservation(teamName, debtKey, branchLineage); }
  reserve(record: Parameters<typeof reserveSyncNudge>[0]) { reserveSyncNudge(record); }
  present(record: Parameters<typeof presentSyncNudge>[0], presentedAt?: string) { return presentSyncNudge(record, presentedAt); }
}
