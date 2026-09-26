import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Check, Value } from "typebox/value";
import { THINKING_LEVELS, type ThinkingLevel, type WorkerModelBinding } from "../team-authority/contracts";
import { MAX_SYNC_TIMER_SECONDS } from "./sync-liveness-settings";
import { TeamPaneLayoutSchema } from "./team-pane-layout";

/** Owns the extension settings contract. Pi owns every other settings namespace. */
export interface ModelRole {
  model: string;
  thinking: ThinkingLevel;
  use: string;
}

export type ModelRoleDiagnosticCode =
  | "malformed_json" | "unreadable" | "invalid_shape" | "invalid_value"
  | "unknown_key" | "obsolete_key" | "dangling_reference"
  | "unavailable_model" | "unsupported_thinking";

export interface ModelRoleDiagnostic {
  source: "global" | "project";
  file: string;
  path: string;
  code: ModelRoleDiagnosticCode;
  message: string;
  consequence: string;
}

export interface ModelRoleSettings {
  roles: Readonly<Record<string, ModelRole>>;
  defaultRole?: string;
  diagnostics: ModelRoleDiagnostic[];
  /** A broken project entry shadows the global entry of the same name. */
  invalidRoles: ReadonlySet<string>;
  invalidDefault: boolean;
  /** A broken source or map cannot prove that inherited roles were not overridden. */
  invalidRoleMap: boolean;
  invalidGlobalRoleMap: boolean;
  invalidProjectRoleMap: boolean;
  roleSources: Readonly<Record<string, "global" | "project">>;
  sourceFiles: Readonly<Record<"global" | "project", string>>;
}

export interface AvailableModelRoles extends ReadonlySet<string> {
  thinkingLevelsByKey?: ReadonlyMap<string, ReadonlySet<ThinkingLevel>>;
}

type JsonRecord = Record<string, unknown>;
type Source = "global" | "project";
type ParsedSource = {
  roles: Record<string, ModelRole>;
  invalidRoles: Set<string>;
  invalidRoleMap: boolean;
  hasDefault: boolean;
  defaultRole?: string;
  invalidDefault: boolean;
};

const isRecord = (value: unknown): value is JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (record: JsonRecord, key: string) => Object.hasOwn(record, key);
const activeAgentDir = () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const roleNamePattern = /^[A-Za-z0-9_-]{1,64}$/;
const modelReferencePattern = /^[^/\s]+\/[^\s]+$/;

function diagnostic(
  target: ModelRoleDiagnostic[], source: Source, file: string, field: string,
  code: ModelRoleDiagnosticCode, message: string, consequence: string,
): void {
  target.push({ source, file, path: field, code, message, consequence });
}

function keys(
  value: JsonRecord, allowed: readonly string[], obsolete: readonly string[],
  field: string, source: Source, file: string, diagnostics: ModelRoleDiagnostic[],
): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    const old = obsolete.includes(key);
    diagnostic(diagnostics, source, file, `${field}.${key}`, old ? "obsolete_key" : "unknown_key",
      old ? `Obsolete setting ${field}.${key}.` : `Unknown setting ${field}.${key}.`,
      old ? "This setting no longer selects new Workers; update the canonical example." : "This setting has no effect.");
  }
}

function nestedObject(
  owner: JsonRecord, name: string, field: string, source: Source, file: string,
  diagnostics: ModelRoleDiagnostic[],
): JsonRecord | undefined {
  if (!has(owner, name)) return undefined;
  if (isRecord(owner[name])) return owner[name];
  diagnostic(diagnostics, source, file, field, "invalid_shape", `${field} must be an object.`, "Its settings are ignored.");
  return undefined;
}

function validateSharedNamespace(
  namespace: JsonRecord, source: Source, file: string, diagnostics: ModelRoleDiagnostic[],
): void {
  keys(namespace, ["model_roles", "default_model_role", "worker", "team"],
    ["model_profiles", "default_model_profile"], "pi_team_bright", source, file, diagnostics);

  const worker = nestedObject(namespace, "worker", "pi_team_bright.worker", source, file, diagnostics);
  if (worker) {
    keys(worker, ["agents", "tools"], ["default_model"], "pi_team_bright.worker", source, file, diagnostics);
    const agents = nestedObject(worker, "agents", "pi_team_bright.worker.agents", source, file, diagnostics);
    if (agents) {
      keys(agents, ["replace_global", "append_global"], [], "pi_team_bright.worker.agents", source, file, diagnostics);
      for (const key of ["replace_global", "append_global"]) {
        if (has(agents, key) && (typeof agents[key] !== "string" || !path.isAbsolute(agents[key]))) {
          diagnostic(diagnostics, source, file, `pi_team_bright.worker.agents.${key}`, "invalid_value",
            `pi_team_bright.worker.agents.${key} must be an absolute path.`, "The prompt override is ignored.");
        }
      }
    }
    const tools = nestedObject(worker, "tools", "pi_team_bright.worker.tools", source, file, diagnostics);
    if (tools) {
      keys(tools, ["enable", "disable"], [], "pi_team_bright.worker.tools", source, file, diagnostics);
      for (const key of ["enable", "disable"]) {
        if (has(tools, key) && (!Array.isArray(tools[key]) || tools[key].some((name: unknown) => typeof name !== "string" || !name.trim()))) {
          diagnostic(diagnostics, source, file, `pi_team_bright.worker.tools.${key}`, "invalid_value",
            `pi_team_bright.worker.tools.${key} must be an array of tool names.`, "The tool override is ignored.");
        }
      }
    }
  }

  const team = nestedObject(namespace, "team", "pi_team_bright.team", source, file, diagnostics);
  if (!team) return;
  keys(team, ["pane_layout", "wait_seconds", "nudge_enabled", "nudge_delay_seconds"], [],
    "pi_team_bright.team", source, file, diagnostics);
  if (source === "project") {
    for (const key of ["wait_seconds", "nudge_enabled", "nudge_delay_seconds"]) {
      if (has(team, key)) diagnostic(diagnostics, source, file, `pi_team_bright.team.${key}`, "invalid_value",
        `pi_team_bright.team.${key} is global-only.`, "This project value has no effect on Team sync policy.");
    }
  }
  for (const key of ["wait_seconds", "nudge_delay_seconds"]) {
    const value = team[key];
    if (has(team, key) && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_SYNC_TIMER_SECONDS)) {
      diagnostic(diagnostics, source, file, `pi_team_bright.team.${key}`, "invalid_value",
        `pi_team_bright.team.${key} must be from 0 through ${MAX_SYNC_TIMER_SECONDS} seconds.`, "The default timer is used.");
    }
  }
  if (has(team, "nudge_enabled") && typeof team.nudge_enabled !== "boolean") {
    diagnostic(diagnostics, source, file, "pi_team_bright.team.nudge_enabled", "invalid_value",
      "pi_team_bright.team.nudge_enabled must be boolean.", "The default nudge policy is used.");
  }
  const layout = nestedObject(team, "pane_layout", "pi_team_bright.team.pane_layout", source, file, diagnostics);
  if (layout) {
    keys(layout, ["leader_share", "worker_tiling"], [], "pi_team_bright.team.pane_layout", source, file, diagnostics);
    if (!Check(TeamPaneLayoutSchema, layout)) {
      for (const error of Value.Errors(TeamPaneLayoutSchema, layout)) {
        const names = error.keyword === "required" ? error.params.requiredProperties : [error.instancePath.split("/").filter(Boolean)[0]];
        for (const key of names) {
          if (key && !["leader_share", "worker_tiling"].includes(key)) continue;
          const field = `pi_team_bright.team.pane_layout${key ? `.${key}` : ""}`;
          diagnostic(diagnostics, source, file, field, "invalid_value",
            `${field} is invalid: ${error.message}.`, "The pane layout is refused when this Team setting is selected.");
        }
      }
    }
  }
}

function readSource(file: string, source: Source, diagnostics: ModelRoleDiagnostic[]): ParsedSource {
  const result: ParsedSource = { roles: Object.create(null), invalidRoles: new Set(), invalidRoleMap: false, hasDefault: false, invalidDefault: false };
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    diagnostic(diagnostics, source, file, "pi_team_bright", "unreadable", "Pi settings could not be read.", "Model roles from this source are unavailable.");
    result.invalidRoleMap = true;
    result.invalidDefault = true;
    result.hasDefault = true;
    return result;
  }
  let root: unknown;
  try { root = JSON.parse(text); } catch {
    diagnostic(diagnostics, source, file, "pi_team_bright", "malformed_json", "Pi settings contain malformed JSON.", "Model roles from this source are unavailable.");
    result.invalidRoleMap = true;
    result.invalidDefault = true;
    result.hasDefault = true;
    return result;
  }
  if (!isRecord(root)) {
    diagnostic(diagnostics, source, file, "pi_team_bright", "invalid_shape", "Pi settings root must be an object.", "Model roles from this source are unavailable.");
    result.invalidRoleMap = true;
    result.invalidDefault = true;
    result.hasDefault = true;
    return result;
  }
  if (!has(root, "pi_team_bright")) return result;
  if (!isRecord(root.pi_team_bright)) {
    diagnostic(diagnostics, source, file, "pi_team_bright", "invalid_shape", "pi_team_bright must be an object.", "Model roles from this source are unavailable.");
    result.invalidRoleMap = true;
    result.invalidDefault = true;
    result.hasDefault = true;
    return result;
  }
  const namespace = root.pi_team_bright;
  validateSharedNamespace(namespace, source, file, diagnostics);
  if (has(namespace, "model_roles")) {
    if (!isRecord(namespace.model_roles)) {
      diagnostic(diagnostics, source, file, "pi_team_bright.model_roles", "invalid_shape", "pi_team_bright.model_roles must map names to roles.", "Role selection from this source is refused.");
      result.invalidRoleMap = true;
    } else {
      for (const [name, raw] of Object.entries(namespace.model_roles)) {
        const field = `pi_team_bright.model_roles.${name}`;
        if (!roleNamePattern.test(name) || !isRecord(raw)) {
          diagnostic(diagnostics, source, file, field, "invalid_value", `${field} must have a valid name and object value.`, "This role cannot be selected.");
          result.invalidRoles.add(name);
          continue;
        }
        keys(raw, ["model", "thinking", "use"], [], field, source, file, diagnostics);
        const valid = typeof raw.model === "string" && modelReferencePattern.test(raw.model)
          && typeof raw.thinking === "string" && THINKING_LEVELS.includes(raw.thinking as ThinkingLevel)
          && typeof raw.use === "string" && !!raw.use.trim()
          && Object.keys(raw).every(key => ["model", "thinking", "use"].includes(key));
        if (!valid) {
          diagnostic(diagnostics, source, file, field, "invalid_value",
            `${field} requires a qualified model, supported thinking name, and nonempty use.`, "This role cannot be selected.");
          result.invalidRoles.add(name);
          continue;
        }
        result.roles[name] = { model: raw.model as string, thinking: raw.thinking as ThinkingLevel, use: (raw.use as string).trim() };
      }
    }
  }
  if (has(namespace, "default_model_role")) {
    result.hasDefault = true;
    if (typeof namespace.default_model_role !== "string" || !roleNamePattern.test(namespace.default_model_role)) {
      diagnostic(diagnostics, source, file, "pi_team_bright.default_model_role", "invalid_value",
        "pi_team_bright.default_model_role must name one model role.", "Omitted Worker selection is refused.");
      result.invalidDefault = true;
    } else result.defaultRole = namespace.default_model_role;
  }
  return result;
}

export function loadModelRoleSettings(input: { cwd: string; projectTrusted: boolean; agentDir?: string }): ModelRoleSettings {
  const sourceFiles = {
    global: path.join(input.agentDir ?? activeAgentDir(), "settings.json"),
    project: path.join(input.cwd, ".pi", "settings.json"),
  };
  const diagnostics: ModelRoleDiagnostic[] = [];
  const global = readSource(sourceFiles.global, "global", diagnostics);
  const project = input.projectTrusted === true ? readSource(sourceFiles.project, "project", diagnostics) : undefined;
  const roles: Record<string, ModelRole> = Object.assign(Object.create(null), global.roles);
  const roleSources: Record<string, Source> = Object.create(null);
  for (const name of Object.keys(global.roles)) roleSources[name] = "global";
  const invalidRoles = new Set(global.invalidRoles);
  if (project) {
    for (const name of project.invalidRoles) {
      delete roles[name];
      delete roleSources[name];
      invalidRoles.add(name);
    }
    for (const [name, role] of Object.entries(project.roles)) {
      roles[name] = role;
      roleSources[name] = "project";
      invalidRoles.delete(name);
    }
  }
  const selectedDefault = project?.hasDefault ? project : global;
  const defaultRole = selectedDefault.defaultRole;
  let invalidDefault = selectedDefault.invalidDefault;
  if (defaultRole && (!Object.hasOwn(roles, defaultRole) || invalidRoles.has(defaultRole))) {
    const source: Source = project?.hasDefault ? "project" : "global";
    diagnostic(diagnostics, source, sourceFiles[source], "pi_team_bright.default_model_role", "dangling_reference",
      `Default model role '${defaultRole}' has no valid definition.`, "Omitted Worker selection is refused.");
    invalidDefault = true;
  }
  return { roles, defaultRole, diagnostics, invalidRoles, invalidDefault,
    invalidRoleMap: global.invalidRoleMap || !!project?.invalidRoleMap,
    invalidGlobalRoleMap: global.invalidRoleMap, invalidProjectRoleMap: !!project?.invalidRoleMap,
    roleSources, sourceFiles };
}

export type WorkerModelRoleErrorCode = "missing_default" | "invalid_default" | "invalid_role" | "unknown_role"
  | "invalid_map" | "catalog_unavailable" | "unavailable_model" | "unsupported_thinking";

export class WorkerModelRoleConfigurationError extends Error {
  constructor(readonly roleName: string | undefined, readonly choices: string[], readonly code: WorkerModelRoleErrorCode, reason: string) {
    super(`Worker model role ${roleName ? `'${roleName}'` : "default"} ${reason}. Verified selectable roles: ${choices.length ? choices.join(", ") : "<none>"}. Edit pi_team_bright.model_roles or default_model_role, then retry before Worker creation.`);
    this.name = "WorkerModelRoleConfigurationError";
  }
}

function selectableChoices(settings: ModelRoleSettings, availableModelKeys?: ReadonlySet<string>): string[] {
  if (!availableModelKeys || settings.invalidProjectRoleMap) return [];
  const capabilities = (availableModelKeys as AvailableModelRoles).thinkingLevelsByKey;
  return Object.entries(settings.roles)
    .filter(([name, role]) => (!settings.invalidGlobalRoleMap || settings.roleSources[name] === "project")
      && availableModelKeys.has(role.model) && capabilities?.get(role.model)?.has(role.thinking))
    .map(([name]) => name).sort();
}

/** Resolve one exact initial binding. A missing catalog cannot establish availability. */
export function resolveWorkerModelRole(
  name: string | undefined, settings: ModelRoleSettings, availableModelKeys?: ReadonlySet<string>,
): WorkerModelBinding {
  const choices = selectableChoices(settings, availableModelKeys);
  const selectedName = name ?? settings.defaultRole;
  if (name === undefined && settings.invalidDefault) throw new WorkerModelRoleConfigurationError(selectedName, choices, "invalid_default", "has an invalid definition or reference");
  if (!selectedName) throw new WorkerModelRoleConfigurationError(undefined, choices, "missing_default", "is not configured");
  if (settings.invalidProjectRoleMap || (settings.invalidGlobalRoleMap && settings.roleSources[selectedName] !== "project")) {
    throw new WorkerModelRoleConfigurationError(selectedName, choices, "invalid_map", "cannot be resolved from malformed settings");
  }
  if (settings.invalidRoles.has(selectedName)) throw new WorkerModelRoleConfigurationError(selectedName, choices, "invalid_role", "has an invalid definition");
  const role = Object.hasOwn(settings.roles, selectedName) ? settings.roles[selectedName] : undefined;
  if (!role) throw new WorkerModelRoleConfigurationError(selectedName, choices, "unknown_role", "is not configured");
  if (!availableModelKeys) throw new WorkerModelRoleConfigurationError(selectedName, [], "catalog_unavailable", "cannot be verified because Pi's model catalog is unavailable");
  if (!availableModelKeys.has(role.model)) {
    throw new WorkerModelRoleConfigurationError(selectedName, choices, "unavailable_model", `references unavailable model ${role.model}`);
  }
  const levels = (availableModelKeys as AvailableModelRoles).thinkingLevelsByKey?.get(role.model);
  if (!levels) throw new WorkerModelRoleConfigurationError(selectedName, [], "catalog_unavailable", "cannot verify supported thinking levels from Pi's model catalog");
  if (!levels.has(role.thinking)) {
    throw new WorkerModelRoleConfigurationError(selectedName, choices, "unsupported_thinking", `requests unsupported thinking ${role.thinking} for ${role.model}`);
  }
  const slash = role.model.indexOf("/");
  return { alias: selectedName, provider: role.model.slice(0, slash), model: role.model.slice(slash + 1), thinking: role.thinking };
}

/** Add local catalog issues to file diagnostics without contacting a provider. */
export function validateModelRoleCatalog(settings: ModelRoleSettings, availableModelKeys?: ReadonlySet<string>): ModelRoleDiagnostic[] {
  if (!availableModelKeys) return [];
  const result: ModelRoleDiagnostic[] = [];
  for (const [name, role] of Object.entries(settings.roles)) {
    const source = settings.roleSources[name];
    const field = `pi_team_bright.model_roles.${name}`;
    if (!availableModelKeys.has(role.model)) {
      diagnostic(result, source, settings.sourceFiles[source], `${field}.model`, "unavailable_model",
        `${role.model} is unavailable in Pi's current model catalog.`, `Role '${name}' cannot be selected.`);
    } else {
      const levels = (availableModelKeys as AvailableModelRoles).thinkingLevelsByKey?.get(role.model);
      if (levels && !levels.has(role.thinking)) diagnostic(result, source, settings.sourceFiles[source], `${field}.thinking`, "unsupported_thinking",
        `${role.thinking} is unsupported for ${role.model}.`, `Role '${name}' cannot be selected without Pi changing its thinking level.`);
    }
  }
  return result;
}
