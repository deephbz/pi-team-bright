import fs from "node:fs";
import path from "node:path";
import type { BeadsAuthorityFingerprint, TeamConfig } from "../team-authority/contracts";
import { verifyTaskAuthority } from "../model-tool-contract/beads-authority-adapter";
import * as paths from "./paths";
import * as teams from "./teams";

export const PI_TEAMS_COMMAND_USAGE = "Usage: /pi-team-bright [status|help]";

const COMMANDS = [
  { value: "status", label: "status", description: "Diagnose the current Team and its Beads authority" },
  { value: "help", label: "help", description: "Show Pi Team Bright command usage" },
] as const;

export type PiTeamsCommand =
  | { ok: true; subcommand: "status" | "help" }
  | { ok: false; usage: string };

export function parsePiTeamsCommand(input = ""): PiTeamsCommand {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { ok: true, subcommand: "status" };
  if (tokens.length === 1 && (tokens[0] === "status" || tokens[0] === "help")) {
    return { ok: true, subcommand: tokens[0] };
  }
  return { ok: false, usage: PI_TEAMS_COMMAND_USAGE };
}

export function getPiTeamsArgumentCompletions(prefix: string) {
  const normalized = String(prefix ?? "").trimStart();
  if (normalized.includes(" ")) return null;
  const matches = COMMANDS.filter((command) => command.value.startsWith(normalized));
  return matches.length > 0 ? matches.map((command) => ({ ...command })) : null;
}

export type TeamSessionBindingStatus = "current" | "unbound" | "stale" | "unavailable";

export interface TeamStatusReport {
  schema: "pi-teams-status/1";
  generatedAt: string;
  team: {
    name: string;
    lifecycle: "active" | "stopped";
    createdAt: string;
    terminalBackend: string;
    currentMembers: string[];
    currentWorkers: string[];
    historicalMemberships: number;
  };
  session: {
    role: string;
    binding: TeamSessionBindingStatus;
    detail?: string;
  };
  storage: {
    teamDirectory: string;
    configPath: string;
    taskWorkspace?: string;
    beadsMetadataPath?: string;
  };
  taskAuthority: {
    backend: "beads" | "legacy" | "unconfigured";
    health: "verified" | "degraded" | "unconfigured";
    authorityId?: string;
    database?: string;
    projectId?: string;
    detail: string;
  };
  externalAccess: {
    inspectTeam: string;
    inspectTasks?: string;
    editTasks?: string;
  };
}

export interface DiagnoseTeamOptions {
  role: string;
  sessionBinding: TeamSessionBindingStatus;
  sessionDetail?: string;
  verifyBeadsAuthority?: (config: TeamConfig) => Promise<BeadsAuthorityFingerprint>;
  now?: () => Date;
}

function shellQuoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const verifyConfiguredBeads = verifyTaskAuthority;

/** Build a read-only diagnosis from TeamConfig plus an exact `bd where` check. */
export async function diagnoseTeam(teamName: string, options: DiagnoseTeamOptions): Promise<TeamStatusReport> {
  const safeTeamName = paths.sanitizeName(teamName);
  const config = await teams.readConfig(safeTeamName);
  const teamDirectory = paths.teamDir(safeTeamName);
  const currentMembers = config.members.filter((member) => member.isActive !== false);
  const currentWorkers = currentMembers.filter((member) => member.agentType === "teammate");
  const workspace = config.taskWorkspace;
  const fingerprint = config.taskAuthorityFingerprint;
  let health: TeamStatusReport["taskAuthority"]["health"] = "unconfigured";
  let detail = config.taskBackend === "legacy"
    ? "Legacy JSON Task authority is configured; migrate before relying on Beads diagnostics."
    : "No Task authority is configured.";

  if (config.taskBackend === "beads") {
    try {
      const observed = await (options.verifyBeadsAuthority ?? verifyConfiguredBeads)(config);
      health = "verified";
      detail = `Exact Beads authority root verified (${observed.backend}/${observed.database}).`;
    } catch (error) {
      health = "degraded";
      detail = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    schema: "pi-teams-status/1",
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    team: {
      name: config.name,
      lifecycle: currentMembers.length > 0 ? "active" : "stopped",
      createdAt: new Date(config.createdAt).toISOString(),
      terminalBackend: config.terminalBackend ?? "unbound",
      currentMembers: currentMembers.map((member) => member.name),
      currentWorkers: currentWorkers.map((member) => member.name),
      historicalMemberships: config.members.length - currentMembers.length,
    },
    session: {
      role: options.role,
      binding: options.sessionBinding,
      ...(options.sessionDetail ? { detail: options.sessionDetail } : {}),
    },
    storage: {
      teamDirectory,
      configPath: paths.configPath(safeTeamName),
      ...(workspace ? {
        taskWorkspace: workspace,
        beadsMetadataPath: path.join(workspace, ".beads", "metadata.json"),
      } : {}),
    },
    taskAuthority: {
      backend: config.taskBackend ?? "unconfigured",
      health,
      ...(config.taskAuthorityId ? { authorityId: config.taskAuthorityId } : {}),
      ...(fingerprint ? { database: fingerprint.doltDatabase, projectId: fingerprint.projectId } : {}),
      detail,
    },
    externalAccess: {
      inspectTeam: `cd ${shellQuoted(teamDirectory)}`,
      ...(workspace ? {
        inspectTasks: `bd --directory ${shellQuoted(workspace)} list --all`,
        editTasks: `Run bd --directory ${shellQuoted(workspace)} …; Beads writes there are authoritative.`,
      } : {}),
    },
  };
}

function list(value: string[]): string {
  return value.length > 0 ? value.join(", ") : "none";
}

export function formatTeamStatus(report: TeamStatusReport): string {
  const authority = report.taskAuthority;
  const lines = [
    `Pi Team Bright · ${report.team.name} · ${report.team.lifecycle}`,
    `Session: ${report.session.role} · binding ${report.session.binding}${report.session.detail ? ` · ${report.session.detail}` : ""}`,
    `Members: ${list(report.team.currentMembers)} · Worker memberships: ${list(report.team.currentWorkers)} · Historical memberships: ${report.team.historicalMemberships}`,
    `Terminal backend: ${report.team.terminalBackend}`,
    `Team workspace: ${report.storage.teamDirectory}`,
    `Team config: ${report.storage.configPath}`,
    `Task authority: ${authority.backend} · ${authority.health}`,
  ];
  if (report.storage.taskWorkspace) lines.push(`Beads workspace: ${report.storage.taskWorkspace}`);
  if (report.storage.beadsMetadataPath) lines.push(`Beads metadata: ${report.storage.beadsMetadataPath}`);
  if (authority.database) lines.push(`Beads database: ${authority.database} · Project: ${authority.projectId ?? "unavailable"}`);
  if (authority.authorityId) lines.push(`Task authority ID: ${authority.authorityId}`);
  lines.push(`Authority check: ${authority.detail}`);
  lines.push(`External Team view: ${report.externalAccess.inspectTeam}`);
  if (report.externalAccess.inspectTasks) lines.push(`External Task view: ${report.externalAccess.inspectTasks}`);
  if (report.externalAccess.editTasks) lines.push(`External Task edits: ${report.externalAccess.editTasks}`);
  return lines.join("\n");
}

export function knownTeamNames(): string[] {
  if (!fs.existsSync(paths.TEAMS_DIR)) return [];
  return fs.readdirSync(paths.TEAMS_DIR, { withFileTypes: true })
    .flatMap((entry) => {
      if (!entry.isDirectory()) return [];
      try {
        return teams.teamExists(entry.name) ? [entry.name] : [];
      } catch {
        return [];
      }
    })
    .sort();
}
