import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SYNC_LIVENESS_POLICY_VERSION = "1" as const;
export const DEFAULT_SYNC_WAIT_SECONDS = 120;
export const DEFAULT_SYNC_NUDGE_DELAY_SECONDS = 1_200;
export const MAX_SYNC_TIMER_SECONDS = 3_600;

export interface SyncLivenessSettings {
  waitSeconds: number;
  nudgeEnabled: boolean;
  nudgeDelaySeconds?: number;
  policyVersion: typeof SYNC_LIVENESS_POLICY_VERSION;
  diagnostics: string[];
}

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);
const activeAgentDir = () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");

function readJson(file: string, diagnostics: string[]): RecordValue | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    if (fs.existsSync(file)) diagnostics.push(`Pi Team settings at ${file} are unreadable; sync liveness uses defaults.`);
    return undefined;
  }
}

function teamSettings(root: RecordValue | undefined): RecordValue | undefined {
  const namespace = root?.pi_team_bright;
  return isRecord(namespace) && isRecord(namespace.team) ? namespace.team : undefined;
}

function boundedSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_SYNC_TIMER_SECONDS;
}

/** Read only global Pi settings. Project settings cannot change a live Team epoch. */
export function loadSyncLivenessSettings(input: { agentDir?: string } = {}): SyncLivenessSettings {
  const diagnostics: string[] = [];
  const file = path.join(input.agentDir ?? activeAgentDir(), "settings.json");
  const team = teamSettings(readJson(file, diagnostics));
  const waitSeconds = team?.wait_seconds === undefined
    ? DEFAULT_SYNC_WAIT_SECONDS
    : boundedSeconds(team.wait_seconds) ? team.wait_seconds : DEFAULT_SYNC_WAIT_SECONDS;
  if (team?.wait_seconds !== undefined && !boundedSeconds(team.wait_seconds)) diagnostics.push(`pi_team_bright.team.wait_seconds must be from 0 through ${MAX_SYNC_TIMER_SECONDS} seconds; default 120 seconds was used.`);

  const nudgeEnabled = team?.nudge_enabled === undefined
    ? true
    : typeof team.nudge_enabled === "boolean" ? team.nudge_enabled : true;
  if (team?.nudge_enabled === undefined) diagnostics.push("pi_team_bright.team.nudge_enabled is absent; nudges are enabled by default.");
  else if (typeof team.nudge_enabled !== "boolean") diagnostics.push("pi_team_bright.team.nudge_enabled must be boolean; nudges are enabled by default.");

  const nudgeDelaySeconds = team?.nudge_delay_seconds === undefined
    ? DEFAULT_SYNC_NUDGE_DELAY_SECONDS
    : boundedSeconds(team.nudge_delay_seconds) ? team.nudge_delay_seconds : DEFAULT_SYNC_NUDGE_DELAY_SECONDS;
  if (team?.nudge_delay_seconds === undefined) diagnostics.push("pi_team_bright.team.nudge_delay_seconds is absent; the 1200 second default is used.");
  else if (!boundedSeconds(team.nudge_delay_seconds)) diagnostics.push(`pi_team_bright.team.nudge_delay_seconds must be from 0 through ${MAX_SYNC_TIMER_SECONDS} seconds; the 1200 second default is used.`);

  return { waitSeconds, nudgeEnabled, ...(nudgeDelaySeconds === undefined ? {} : { nudgeDelaySeconds }), policyVersion: SYNC_LIVENESS_POLICY_VERSION, diagnostics };
}
