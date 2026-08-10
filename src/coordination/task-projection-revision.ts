import crypto from "node:crypto";
import type { TaskCard, TaskCardWarning } from "../task-authority/task-domain";

/** Stable revision of the complete projected Task state used by Coordination. */
export function taskProjectionRevision(tasks: readonly TaskCard[], warnings: readonly TaskCardWarning[] = []): string {
  return crypto.createHash("sha256").update(JSON.stringify({ tasks, warnings })).digest("hex");
}
