import { hostEnv } from "../env/host-env";
import { deliveryRetryTime } from "./delivery-retry-time";
import { stripVTControlCharacters } from "node:util";
import { humanCarrierAttentionMessage, type CarrierView } from "../carrier-observation";
import fs from "node:fs";
import { DurableGraphTaskAuthority } from "../adapters/durable-graph-task-authority";
import * as paths from "./paths";
import * as teams from "./teams";

export function isLegacyAdoptionCandidate(view: CarrierView): boolean {
  return !!view.generation && !view.generation.osBirthToken && !view.lastStop && view.processSample?.probe.kind !== "absent";
}

export function formatCarrierStatus(view: CarrierView, taskIds?: string[]): { line: string; facts: { worker: string; process?: string; launch?: string } } {
  const facts = { worker: view.worker,
    ...(view.process === "unknown" ? { process: view.attention ? `${view.attention.reason}; ${view.attention.nextActionHint}; ${humanCarrierAttentionMessage(view.attention)}` : view.evidence.find(item => item.source === "process_generation")?.fact } : {}),
    ...(view.launch === "unknown" ? { launch: view.evidence.find(item => item.source === "launch")?.fact } : {}) };
  const suffix = (fact?: string): string => {
    if (!fact) return "";
    const text = stripVTControlCharacters(fact).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
    return ` (${text.length > 120 ? `${text.slice(0, 119)}…` : text})`;
  };
  return { line: `${view.worker}: process ${view.process}${suffix(facts.process)}; launch ${view.launch}${suffix(facts.launch)}; terminal ${view.terminal}; activity ${view.activity}; pane ${view.paneId ?? "unknown"}; lastStop=${view.lastStop?.piReason ?? "none"}; suspectedHumanStop=${view.lastStop?.suspectedHumanStop ?? false}; nonterminalTaskIds=${taskIds ? taskIds.join(",") || "none" : "unavailable"}.${view.deliveryDegraded?.map(failure => ` ${failure.engine} delivery degraded${suffix(`${failure.operation}: ${failure.message}`)}; ${deliveryRetryTime(failure.retryAt)}.`).join("") ?? ""}`, facts };
}

export const PI_TEAMS_COMMAND_USAGE = "Usage: /pi-team-bright [status|help]";

const COMMANDS = [
  { value: "status", label: "status", description: "Diagnose the current Team and its graph authority" },
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
    graphPath: string;
  };
  taskAuthority: {
    backend: "graph";
    health: "verified" | "degraded";
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
  verifyGraphAuthority?: (teamName: string) => Promise<unknown>;
  now?: () => Date;
}

function shellQuoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Build a read-only diagnosis from TeamConfig and required graph authority. */
export async function diagnoseTeam(teamName: string, options: DiagnoseTeamOptions): Promise<TeamStatusReport> {
  const safeTeamName = paths.sanitizeName(teamName);
  const config = await teams.readConfig(safeTeamName);
  const teamDirectory = paths.teamDir(safeTeamName);
  const currentMembers = config.members.filter((member) => member.isActive !== false);
  const currentWorkers = currentMembers.filter((member) => member.agentType === "teammate");
  let health: TeamStatusReport["taskAuthority"]["health"] = "verified";
  let detail = "Graph Task authority verified.";
  try {
    await (options.verifyGraphAuthority ?? ((name) => new DurableGraphTaskAuthority().readTasks(name)))(safeTeamName);
  } catch (error) {
    health = "degraded";
    detail = error instanceof Error ? error.message : String(error);
  }

  return {
    schema: "pi-teams-status/1",
    generatedAt: (options.now ?? (() => new Date(hostEnv().clock.now())))().toISOString(),
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
      graphPath: paths.graphTaskAuthorityPath(safeTeamName),
    },
    taskAuthority: {
      backend: "graph",
      health,
      detail,
    },
    externalAccess: {
      inspectTeam: `cd ${shellQuoted(teamDirectory)}`,
      inspectTasks: "Use task_read or /ptb tasks.",
      editTasks: "Use task_graph_apply and task_update.",
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
  lines.push(`Task graph: ${report.storage.graphPath}`);
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
