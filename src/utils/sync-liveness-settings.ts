import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SYNC_LIVENESS_POLICY_VERSION = "2" as const;
export const DEFAULT_SYNC_WAIT_SECONDS = 120;
export const DEFAULT_AUTO_SYNC_DELAY_SECONDS = 20;
export const DEFAULT_AUTO_SYNC_UPDATE_THRESHOLD = 3;
export const MAX_SYNC_TIMER_SECONDS = 3_600;
export const MAX_AUTO_SYNC_UPDATE_THRESHOLD = 1_000;

export interface SyncLivenessSettings {
  waitSeconds: number;
  autoSyncEnabled: boolean;
  autoSyncDelaySeconds: number;
  autoSyncUpdateThreshold: number;
  policyVersion: typeof SYNC_LIVENESS_POLICY_VERSION;
  diagnostics: string[];
}

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);
const activeAgentDir = () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");

function readJson(file: string, diagnostics: string[]): RecordValue | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (isRecord(value)) return value;
    diagnostics.push(`Pi Team settings at ${file} require an object root; auto sync uses defaults.`);
    return undefined;
  } catch {
    if (fs.existsSync(file)) diagnostics.push(`Pi Team settings at ${file} are unreadable; auto sync uses defaults.`);
    return undefined;
  }
}

function teamSettings(root: RecordValue | undefined, diagnostics: string[]): RecordValue | undefined {
  const namespace = root?.pi_team_bright;
  if (namespace === undefined) return undefined;
  if (!isRecord(namespace)) {
    diagnostics.push("pi_team_bright must be an object; auto sync uses defaults.");
    return undefined;
  }
  if (namespace.team === undefined) return undefined;
  if (!isRecord(namespace.team)) {
    diagnostics.push("pi_team_bright.team must be an object; auto sync uses defaults.");
    return undefined;
  }
  return namespace.team;
}

function boundedSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_SYNC_TIMER_SECONDS;
}

function threshold(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_AUTO_SYNC_UPDATE_THRESHOLD;
}

/** Read one global policy for a new Team epoch. Project settings cannot change sync policy. */
export function loadSyncLivenessSettings(input: { agentDir?: string } = {}): SyncLivenessSettings {
  const diagnostics: string[] = [];
  const file = path.join(input.agentDir ?? activeAgentDir(), "settings.json");
  const team = teamSettings(readJson(file, diagnostics), diagnostics);
  const waitSeconds = team?.wait_seconds === undefined
    ? DEFAULT_SYNC_WAIT_SECONDS
    : boundedSeconds(team.wait_seconds) ? team.wait_seconds : DEFAULT_SYNC_WAIT_SECONDS;
  if (team?.wait_seconds !== undefined && !boundedSeconds(team.wait_seconds)) {
    diagnostics.push(`pi_team_bright.team.wait_seconds must be from 0 through ${MAX_SYNC_TIMER_SECONDS}; default ${DEFAULT_SYNC_WAIT_SECONDS} was used.`);
  }

  const hasNewEnabled = team !== undefined && Object.hasOwn(team, "auto_sync_enabled");
  const hasNewDelay = team !== undefined && Object.hasOwn(team, "auto_sync_delay_seconds");
  const hasOldEnabled = team !== undefined && Object.hasOwn(team, "nudge_enabled");
  const hasOldDelay = team !== undefined && Object.hasOwn(team, "nudge_delay_seconds");
  if (hasOldEnabled) diagnostics.push(`pi_team_bright.team.nudge_enabled is deprecated; use pi_team_bright.team.auto_sync_enabled. ${hasNewEnabled ? "The new value takes precedence." : "The old value remains effective for this Team epoch."}`);
  if (hasOldDelay) diagnostics.push(`pi_team_bright.team.nudge_delay_seconds is deprecated; use pi_team_bright.team.auto_sync_delay_seconds. ${hasNewDelay ? "The new value takes precedence." : "The old value remains effective for this Team epoch."}`);

  const enabledValue = hasNewEnabled ? team!.auto_sync_enabled : hasOldEnabled ? team!.nudge_enabled : undefined;
  const autoSyncEnabled = enabledValue === undefined ? true : typeof enabledValue === "boolean" ? enabledValue : true;
  if (enabledValue !== undefined && typeof enabledValue !== "boolean") {
    const key = hasNewEnabled ? "auto_sync_enabled" : "nudge_enabled";
    diagnostics.push(`pi_team_bright.team.${key} must be boolean; default true was used.`);
  }
  const delayValue = hasNewDelay ? team!.auto_sync_delay_seconds : hasOldDelay ? team!.nudge_delay_seconds : undefined;
  const autoSyncDelaySeconds = delayValue === undefined
    ? DEFAULT_AUTO_SYNC_DELAY_SECONDS : boundedSeconds(delayValue) ? delayValue : DEFAULT_AUTO_SYNC_DELAY_SECONDS;
  if (delayValue !== undefined && !boundedSeconds(delayValue)) {
    const key = hasNewDelay ? "auto_sync_delay_seconds" : "nudge_delay_seconds";
    diagnostics.push(`pi_team_bright.team.${key} must be from 0 through ${MAX_SYNC_TIMER_SECONDS}; default ${DEFAULT_AUTO_SYNC_DELAY_SECONDS} was used.`);
  }
  const autoSyncUpdateThreshold = team?.auto_sync_update_threshold === undefined
    ? DEFAULT_AUTO_SYNC_UPDATE_THRESHOLD
    : threshold(team.auto_sync_update_threshold) ? team.auto_sync_update_threshold : DEFAULT_AUTO_SYNC_UPDATE_THRESHOLD;
  if (team?.auto_sync_update_threshold !== undefined && !threshold(team.auto_sync_update_threshold)) {
    diagnostics.push(`pi_team_bright.team.auto_sync_update_threshold must be an integer from 1 through ${MAX_AUTO_SYNC_UPDATE_THRESHOLD}; default ${DEFAULT_AUTO_SYNC_UPDATE_THRESHOLD} was used.`);
  }
  return { waitSeconds, autoSyncEnabled, autoSyncDelaySeconds, autoSyncUpdateThreshold,
    policyVersion: SYNC_LIVENESS_POLICY_VERSION, diagnostics };
}
