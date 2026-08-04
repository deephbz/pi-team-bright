import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Check, Value } from "typebox/value";
import { Type, type Static } from "typebox";

/** Durable pane placement policy captured by a Team epoch. */
export const TeamPaneLayoutSchema = Type.Object({
  leader_share: Type.Number({ minimum: 0.6, exclusiveMaximum: 1 }),
  worker_tiling: Type.Enum(["linear", "grid"]),
}, { additionalProperties: false });

export type TeamPaneLayout = Static<typeof TeamPaneLayoutSchema>;

export const DEFAULT_TEAM_PANE_LAYOUT: TeamPaneLayout = Object.freeze({
  leader_share: 0.6,
  worker_tiling: "linear",
});

export type TeamPaneLayoutSource = "team_create" | "trusted project Pi settings" | "global Pi settings";

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord => !!value && typeof value === "object" && !Array.isArray(value);

function parsePolicy(value: unknown, source: TeamPaneLayoutSource): TeamPaneLayout {
  if (!Check(TeamPaneLayoutSchema, value)) {
    let detail = "must contain leader_share >= 0.6 and < 1, and worker_tiling linear or grid";
    try {
      detail = Value.Errors(TeamPaneLayoutSchema, value).at(0)?.message ?? detail;
    } catch {
      // Keep the stable contract error when TypeBox cannot describe the value.
    }
    throw new Error(`Invalid pane_layout from ${source}: ${detail}.`);
  }
  return { leader_share: value.leader_share, worker_tiling: value.worker_tiling };
}

function settingsPaneLayout(file: string, source: TeamPaneLayoutSource): unknown | undefined {
  if (!fs.existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Invalid pane_layout settings file ${file}: ${error instanceof Error ? error.message : String(error)}.`);
  }
  const namespace = isRecord(parsed) && isRecord(parsed.pi_team_bright) ? parsed.pi_team_bright : undefined;
  const team = namespace && isRecord(namespace.team) ? namespace.team : undefined;
  return team && Object.hasOwn(team, "pane_layout")
    ? team.pane_layout
    : undefined;
}

function agentDirectory(agentDir?: string): string {
  return agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

/** Read only the global policy and, when trusted, the nearest project policy. */
export function loadTeamPaneLayoutSettings(input: {
  cwd: string;
  projectTrusted: boolean;
  agentDir?: string;
}): { project?: unknown; global?: unknown } {
  const globalFile = path.join(agentDirectory(input.agentDir), "settings.json");
  const projectFile = path.join(input.cwd, ".pi", "settings.json");
  return {
    ...(input.projectTrusted ? { project: settingsPaneLayout(projectFile, "trusted project Pi settings") } : {}),
    global: settingsPaneLayout(globalFile, "global Pi settings"),
  };
}

/** Refuse policies that the selected terminal adapter cannot implement. */
export function assertTeamPaneLayoutSupported(policy: TeamPaneLayout, backend: string): void {
  if (policy.worker_tiling === "grid" && backend !== "herdr") {
    throw new Error(`Pane worker_tiling=grid is unsupported by terminal backend ${backend}; use worker_tiling=linear or a Herdr Team.`);
  }
  if (backend === "tmux" && Math.floor((1 - policy.leader_share) * 100) < 1) {
    throw new Error(`Pane leader_share=${policy.leader_share} leaves tmux no Worker pane; use leader_share <= 0.99.`);
  }
}

/** Resolve explicit input, trusted project settings, global settings, then defaults. */
export function resolveTeamPaneLayout(input: {
  explicit?: unknown;
  project?: unknown;
  global?: unknown;
  backend: string;
}): TeamPaneLayout {
  const selected = input.explicit !== undefined
    ? { value: input.explicit, source: "team_create" as const }
    : input.project !== undefined
      ? { value: input.project, source: "trusted project Pi settings" as const }
      : input.global !== undefined
        ? { value: input.global, source: "global Pi settings" as const }
        : undefined;
  const policy = selected ? parsePolicy(selected.value, selected.source) : { ...DEFAULT_TEAM_PANE_LAYOUT };
  assertTeamPaneLayoutSupported(policy, input.backend);
  return policy;
}

/** Validate a policy already loaded from a TeamConfig or a direct adapter caller. */
export function normalizeTeamPaneLayout(value: unknown, backend?: string): TeamPaneLayout {
  const policy = value === undefined ? { ...DEFAULT_TEAM_PANE_LAYOUT } : parsePolicy(value, "team_create");
  if (backend) assertTeamPaneLayoutSupported(policy, backend);
  return policy;
}
