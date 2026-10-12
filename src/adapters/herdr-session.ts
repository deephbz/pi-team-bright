/** Decode Herdr AgentSessionInfo. A missing or foreign identity proves no Session match. */
export function herdrPiSessionPath(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const session = value as Record<string, unknown>;
  return session.source === "herdr:pi" && session.agent === "pi" && session.kind === "path"
    && typeof session.value === "string" && session.value.length > 0 ? session.value : undefined;
}
