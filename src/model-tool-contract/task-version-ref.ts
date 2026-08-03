import { createHash } from "node:crypto";

export type TaskVersionRef = `v_${string}`;

/** Stable model-facing version token. Authority versions never leave the shell. */
export function taskVersionRef(authorityVersion: string): TaskVersionRef {
  return `v_${createHash("sha256").update(authorityVersion).digest("hex").slice(0, 16)}`;
}
