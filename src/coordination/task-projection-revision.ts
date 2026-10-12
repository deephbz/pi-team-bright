import crypto from "node:crypto";
import type { CanonicalTaskCard, TaskCardWarning } from "../task-authority/task-domain";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
}

/** Branch reconstruction and authority reads can enumerate the same Tasks in different orders. */
export function taskProjectionRevision(tasks: readonly CanonicalTaskCard[], warnings: readonly TaskCardWarning[] = []): string {
  return crypto.createHash("sha256").update(JSON.stringify(canonical({ tasks: [...tasks].sort((a, b) => a.id.localeCompare(b.id)), warnings: [...warnings].sort((a, b) => JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b)))) }))).digest("hex");
}
