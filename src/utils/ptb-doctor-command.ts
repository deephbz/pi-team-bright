import fs from "node:fs";
import path from "node:path";
import packageJson from "../../package.json";
import * as paths from "./paths";

const SUBCOMMANDS = [
  { value: "help", argument: "", description: "Show /ptb usage" },
  { value: "doctor", argument: " [team-name]", description: "Send the Team doctor guide and sampled Team metadata to the agent" },
] as const;

export const PTB_COMMAND_USAGE = `Usage: ${SUBCOMMANDS.map((command) => `/ptb ${command.value}${command.argument}`).join(" | ")}. Bare /ptb shows help.`;
export const PTB_DOCTOR_CUSTOM_TYPE = "pi-team-bright.doctor";

export type PtbCommand =
  | { kind: "help" }
  | { kind: "doctor"; teamName?: string }
  | { kind: "invalid" };

export function parsePtbCommand(args = ""): PtbCommand {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: "help" };
  const command = SUBCOMMANDS.find((candidate) => candidate.value === tokens[0]);
  if (command?.value === "help" && tokens.length === 1) return { kind: "help" };
  if (command?.value === "doctor" && tokens.length <= 2) {
    if (tokens.length === 1) return { kind: "doctor" };
    if (/^[A-Za-z0-9_-]{1,64}$/.test(tokens[1])) return { kind: "doctor", teamName: tokens[1] };
  }
  return { kind: "invalid" };
}

export function getPtbArgumentCompletions(prefix: string) {
  const token = String(prefix ?? "").trimStart();
  if (/\s/.test(token)) return null;
  const matches = SUBCOMMANDS.filter((command) => command.value.startsWith(token));
  return matches.length ? matches.map(({ value, description }) => ({ value, label: value, description })) : null;
}

const packageRoot = path.resolve(__dirname, "../..");
export const PTB_DOCTOR_GUIDE_PATH = path.join(packageRoot, "skills/pi-team-bright/references/team-doctor.md");

export interface PtbDoctorCoordinates {
  requestedAt: string;
  selectedTeamName?: string;
  boundTeamName?: string;
  role: string;
  membershipId?: string;
  sessionId?: string;
  sessionFile?: string;
  leafId?: string;
}

function bounded(value: string | undefined, limit: number): string | undefined {
  return value && value.length <= limit ? value : undefined;
}

function fileState(file: string, limit: number): "missing" | "unreadable" | "too_large" | "within_limit" {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return "unreadable";
    return stat.size <= limit ? "within_limit" : "too_large";
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "unreadable";
  }
}

function boundedJson(file: string, limit: number): { state: "missing" | "unreadable" | "too_large" | "invalid_json" | "parseable_unverified"; value?: unknown } {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) return { state: "unreadable" };
    if (stat.size > limit) return { state: "too_large" };
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!read) return { state: "unreadable" };
      offset += read;
    }
    try {
      return { state: "parseable_unverified", value: JSON.parse(bytes.toString("utf8")) };
    } catch {
      return { state: "invalid_json" };
    }
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "unreadable" };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** Sample local facts only. These separate reads are not an atomic Team snapshot. */
export async function collectPtbDoctorContext(coordinates: PtbDoctorCoordinates): Promise<string> {
  const guideState = fileState(PTB_DOCTOR_GUIDE_PATH, 16 * 1024);
  if (guideState !== "within_limit") throw new Error("doctor_guide_unavailable");
  const guide = await fs.promises.readFile(PTB_DOCTOR_GUIDE_PATH, "utf8");
  const selected = coordinates.selectedTeamName;
  const metadata: Record<string, unknown> = {
    requested_at: coordinates.requestedAt,
    package_version: packageJson.version,
    source_root: bounded(packageRoot, 512) ?? "omitted_over_limit",
    guide_path: bounded(PTB_DOCTOR_GUIDE_PATH, 512) ?? "omitted_over_limit",
    sampling: "separate local reads; refresh before mutation",
    session: {
      id: bounded(coordinates.sessionId, 128) ?? "unavailable",
      file: bounded(coordinates.sessionFile, 512) ?? "unavailable",
      leaf: bounded(coordinates.leafId, 128) ?? "unavailable",
    },
    selection: {
      team: bounded(selected, 64) ?? (selected ? "invalid_name" : "none"),
      runtime_bound_team: bounded(coordinates.boundTeamName, 64) ?? "none",
      role: bounded(coordinates.role, 64) ?? "unavailable",
      runtime_membership_id: bounded(coordinates.membershipId, 128) ?? "unavailable",
    },
  };
  const formatted = () => {
    metadata.sampled_at = new Date().toISOString();
    return `${guide}\n\nInvocation metadata (observations, not authority):\n${JSON.stringify(metadata, null, 2)}`;
  };
  if (selected) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(selected)) {
      metadata.team = { config_state: "invalid_team_name", graph_state: "not_read" };
      return formatted();
    }
    const configFile = paths.configPath(selected);
    const graphFile = paths.graphTaskAuthorityPath(selected);
    const configRead = boundedJson(configFile, 256 * 1024);
    const graphRead = boundedJson(graphFile, 512 * 1024);
    const config = configRead.value;
    const team: Record<string, unknown> = {
      config_path: bounded(configFile, 512) ?? "omitted_over_limit",
      config_state: configRead.state,
      graph_path: bounded(graphFile, 512) ?? "omitted_over_limit",
      graph_state: graphRead.state === "too_large" ? "present_unchecked_large" : graphRead.state,
    };
    if (configRead.state === "parseable_unverified") {
      if (config && typeof config === "object" && !Array.isArray(config)
        && (config as Record<string, unknown>).name === selected
        && Array.isArray((config as Record<string, unknown>).members)) {
        const record = config as Record<string, unknown>;
        const members = record.members as unknown[];
        const active = members.filter((member) => member && typeof member === "object" && !Array.isArray(member)
          && (member as Record<string, unknown>).isActive !== false);
        team.epoch_id = typeof record.epochId === "string" ? bounded(record.epochId, 128) ?? "omitted_over_limit" : "unavailable";
        team.sampled_active_member_entries = active.length;
        team.sampled_worker_entries = active.filter((member) => (member as Record<string, unknown>).agentType === "teammate").length;
        team.task_backend = record.taskBackend === "beads" || record.taskBackend === "legacy" ? record.taskBackend : "unconfigured_or_invalid";
        if (typeof record.taskWorkspace === "string" && path.isAbsolute(record.taskWorkspace)) {
          const workspace = bounded(record.taskWorkspace, 512);
          if (workspace) {
            team.task_workspace = workspace;
            team.beads_metadata_path = bounded(path.join(workspace, ".beads/metadata.json"), 512) ?? "omitted_over_limit";
          }
        }
        if (selected === coordinates.boundTeamName && coordinates.sessionFile && coordinates.membershipId) {
          team.session_binding = active.some((member) => {
            const value = member as Record<string, unknown>;
            return value.name === coordinates.role && value.sessionFile === coordinates.sessionFile
              && value.membershipId === coordinates.membershipId;
          }) ? "matches_sample" : "mismatch_sample";
        }
      } else {
        team.config_state = "invalid_shape";
      }
    }
    team.session_binding ??= selected !== coordinates.boundTeamName ? "not_bound_to_selected_team" : "unavailable";
    team.effective_authority = graphRead.state === "unreadable" ? "graph_unavailable"
      : graphRead.state !== "missing" ? "graph_snapshot_present"
      : team.task_backend === "beads" ? "beads_configured"
        : team.task_backend === "legacy" ? "legacy_configured" : "unconfigured_or_unknown";
    metadata.team = team;
  }
  return formatted();
}
