import { createHash } from "node:crypto";
import { Type } from "typebox";

export type TaskVersionRef = `v_${string}`;
export const TaskVersionRefSchema = Type.String({ pattern: "^v_[0-9a-f]{16}$", minLength: 18, maxLength: 18 });

/** Stable model-facing version token. Authority versions never leave the shell. */
export function taskVersionRef(sourceRevision: string): TaskVersionRef {
  return `v_${createHash("sha256").update(sourceRevision).digest("hex").slice(0, 16)}`;
}
