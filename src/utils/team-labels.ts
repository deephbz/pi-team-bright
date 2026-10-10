import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Global-only naming policy for new Teams. Existing names remain unchanged. */
export function loadTeamDatePrefix(agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")): boolean {
  let root: any;
  try { root = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  const value = root?.pi_team_bright?.team?.date_prefix;
  if (value === undefined) return true;
  if (typeof value !== "boolean") throw new Error("pi_team_bright.team.date_prefix must be boolean.");
  return value;
}

export function datePrefixedTeamName(name: string, enabled: boolean, date = new Date()): string {
  if (!enabled || /^\d{8}-/.test(name)) return name;
  const prefix = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  const resolved = `${prefix}-${name}`;
  if (resolved.length > 64) throw new Error("Date-prefixed Team name exceeds 64 characters; shorten the name or disable pi_team_bright.team.date_prefix.");
  return resolved;
}

export function teamTerminalTitle(team: string, role: string): string {
  return role === "team-lead" ? `leader-${team}` : role;
}

/** Only bound Workers have a PTB-owned Session name. */
export function teamSessionName(team: string, role: string): string | undefined {
  return role === "team-lead" ? undefined : `${team}/${role}`;
}
