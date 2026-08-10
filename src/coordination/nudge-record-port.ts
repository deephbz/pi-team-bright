import type { SyncNudgeRecord } from "../utils/sync-nudge";

/** Pi Session presentation consumes these derived nudge records. It does not own their durable format. */
export interface CoordinationNudgeRecordPort {
  readPresented(teamName: string): SyncNudgeRecord[];
  findReservation(teamName: string, debtKey: string, branchLineage: readonly string[]): SyncNudgeRecord | undefined;
  reserve(record: SyncNudgeRecord): void;
  present(record: SyncNudgeRecord, presentedAt?: string): SyncNudgeRecord;
}
