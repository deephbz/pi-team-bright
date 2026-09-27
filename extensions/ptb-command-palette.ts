import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { openPtbPalette, type PtbPaletteItem, type PtbPaletteTab } from "./ptb-palette";
import { PTB_GRAPH_LIMITS, type PtbAction } from "../src/utils/ptb-command";
import { readPtbSettingsDocument, savePtbSettingsDocument, type PtbSettingsDocument } from "../src/utils/ptb-settings-editor";
import { normalizeTeamPaneLayout } from "../src/utils/team-pane-layout";
import { captureQualifiedAvailableModelKeys } from "../src/utils/worker-resource-projection";
import { THINKING_LEVELS } from "../src/team-authority/contracts";

/** Human command/configuration flow. It edits Pi's PTB namespace, never live Team records. */
type Scope = "global" | "project";
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const clean = (value: unknown) => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const display = (value: unknown, scope: Scope) => value === undefined ? (scope === "project" ? "No project override" : "Not set here") : clean(typeof value === "string" ? value : JSON.stringify(value));
const own = (root: RecordValue, keys: string[]): unknown => keys.reduce<unknown>((value, key) => record(value)[key], root);
function assign(root: RecordValue, keys: string[], value: unknown): void {
  const [key, ...rest] = keys;
  if (rest.length) {
    root[key] = { ...record(root[key]) };
    assign(root[key] as RecordValue, rest, value);
  } else if (value === undefined) delete root[key];
  else Object.defineProperty(root, key, { value, enumerable: true, configurable: true, writable: true });
}

export interface PtbCommandPaletteOptions {
  isCurrent(): boolean;
  runAction(command: PtbAction): Promise<void>;
  teamName?: string;
  graphAvailable?: boolean;
  role: string;
  projectTrusted: boolean;
  initialSettingsScope?: Scope;
}

const FIELDS = [
  { id: "default_model_role", tab: "Models", label: "Default model role", path: ["default_model_role"], kind: "role", description: "Role used for new Workers when no role is specified." },
  { id: "auto_sync_enabled", tab: "Team", label: "Automatic sync", path: ["team", "auto_sync_enabled"], kind: "boolean", global: true, description: "Enable framework synchronization for new Teams." },
  { id: "auto_sync_delay_seconds", tab: "Team", label: "Sync delay (seconds)", path: ["team", "auto_sync_delay_seconds"], kind: "number", global: true, description: "Delay before automatic synchronization. Applies to new Teams." },
  { id: "auto_sync_update_threshold", tab: "Team", label: "Sync update threshold", path: ["team", "auto_sync_update_threshold"], kind: "number", global: true, description: "Number of changes that triggers synchronization. Applies to new Teams." },
  { id: "wait_seconds", tab: "Team", label: "Sync wait (seconds)", path: ["team", "wait_seconds"], kind: "number", global: true, description: "Internal synchronization recheck interval for new Teams." },
  { id: "leader_share", tab: "Team", label: "Leader pane share", path: ["team", "pane_layout", "leader_share"], kind: "number", description: "Fraction of pane space for the leader, above 0.1 and below 1. Applies to new Teams." },
  { id: "worker_tiling", tab: "Team", label: "Worker pane layout", path: ["team", "pane_layout", "worker_tiling"], kind: "tiling", description: "Linear or grid layout for new Teams. Grid requires Herdr." },
  { id: "enable", tab: "Workers", label: "Enable tools", path: ["worker", "tools", "enable"], kind: "array", description: "JSON array of additional tool names for new Worker processes." },
  { id: "disable", tab: "Workers", label: "Disable tools", path: ["worker", "tools", "disable"], kind: "array", description: "JSON array of tool names to remove for new Worker processes." },
  { id: "replace_global", tab: "Workers", label: "Replace global AGENTS", path: ["worker", "agents", "replace_global"], kind: "path", description: "Absolute file path for new Worker processes. Empty removes this override." },
  { id: "append_global", tab: "Workers", label: "Append global AGENTS", path: ["worker", "agents", "append_global"], kind: "path", description: "Absolute file path appended for new Worker processes. Empty removes this override." },
] as const;

export function buildPtbPaletteItems(input: { namespace: unknown; scope: Scope; trusted: boolean; teamName?: string; graphAvailable?: boolean; role: string; settingsError?: string }): PtbPaletteItem[] {
  const namespace = record(input.namespace);
  const malformed = input.namespace === null || typeof input.namespace !== "object" || Array.isArray(input.namespace);
  const action = (id: string, label: string, description: string, disabledReason?: string): PtbPaletteItem => ({ id, tab: "Actions", label, description, currentValue: "Open", disabledReason });
  const items: PtbPaletteItem[] = [
    action("status", "Team status", "Read the current Team and authority diagnostics."),
    action("sync", "Sync now", "Read Team updates once. New changes can continue the leader's model turn.", !input.teamName || input.role !== "team-lead" ? "Requires a bound Team leader." : undefined),
    action("graph", "Task DAG / Timeline", "Choose a Task limit and toggle the read-only Herdr pane. Press v there to switch views.", !input.teamName ? "Requires a bound Team." : input.graphAvailable === false ? "Requires a Herdr terminal." : undefined),
    action("doctor", "Team doctor", "Send the repair guide and sampled metadata to the agent. Starts or queues a model turn."),
    action("settings_check", "Settings diagnostics", "Check configured roles and settings without changing them."),
    action("help", "Command help", "Show direct /ptb commands."),
  ];
  for (const tab of ["Models", "Team", "Workers"] as const) {
    items.push({ id: "scope", tab, label: "Editing scope", currentValue: input.scope, values: input.trusted ? ["global", "project"] : ["global"], description: "Select which Pi settings file to edit. Scope selection does not change or remove overrides." });
    if (input.settingsError) {
      items.push({ id: "unavailable", tab, label: "Settings unavailable", currentValue: "Read failed", description: input.settingsError, disabledReason: "Repair the settings file, then reopen /ptb." });
      continue;
    }
    for (const field of FIELDS.filter((field) => !malformed && field.tab === tab)) {
      if ("global" in field && field.global && input.scope === "project") continue;
      items.push({ id: field.id, tab, label: field.label, currentValue: display(own(namespace, [...field.path]), input.scope), description: `${field.description} Editing ${input.scope} values.`, values: ["Edit"] });
    }
    if (tab === "Models" && !malformed) {
      items.push({ id: "edit_role", tab, label: "Add or edit model role", currentValue: `${Object.keys(record(namespace.model_roles)).length} in this scope`, description: "Choose a model, thinking level, and use. A project role overrides a global role with the same name.", values: ["Edit"] });
    }
    items.push({ id: "json", tab, label: "Edit PTB configuration JSON", currentValue: "Open editor", description: `${malformed ? "This PTB section is malformed. Replace it with a JSON object. " : ""}Edit all PTB settings in this scope, including role removal. Other Pi settings stay unchanged. Save requires confirmation.`, values: ["Edit"] });
  }
  return items;
}

export async function openPtbCommandPalette(ctx: ExtensionCommandContext, options: PtbCommandPaletteOptions): Promise<void> {
  const notify = (message: string, level: "info" | "warning" | "error" = "info") => ctx.ui.notify(message, level);
  if (ctx.mode !== "tui") { notify("The PTB palette requires interactive Pi. Use /ptb help, /ptb status, or /ptb settings check."); return; }
  let scope: Scope = options.initialSettingsScope ?? "global";
  let tab: PtbPaletteTab = options.initialSettingsScope ? "Models" : "Actions";
  const current = () => {
    if (options.isCurrent()) return true;
    notify("PTB selection cancelled because the Session or Team changed. Reopen /ptb.", "warning");
    return false;
  };
  if (scope === "project" && !options.projectTrusted) { notify("Project settings require Pi project trust. No file was read or changed.", "warning"); return; }
  while (current()) {
    let document: PtbSettingsDocument | undefined;
    let settingsError: string | undefined;
    try { document = readPtbSettingsDocument({ cwd: ctx.cwd, projectTrusted: options.projectTrusted, scope }); }
    catch (error) { settingsError = error instanceof Error ? error.message : String(error); }
    const selected = await openPtbPalette(ctx, {
      items: buildPtbPaletteItems({ namespace: document ? document.namespace : {}, scope, trusted: options.projectTrusted, teamName: options.teamName, graphAvailable: options.graphAvailable, role: options.role, settingsError }),
      initialTab: tab,
      scope: "Edits need Save confirmation. Existing Teams and Worker model bindings stay unchanged.",
      isCurrent: options.isCurrent,
      subtitle: `Team: ${clean(options.teamName ?? "unbound")} · ${clean(options.role)} · Editing ${scope}${document ? ` · ${clean(document.file)}` : ""}`,
    });
    if (!selected || !current()) return;
    tab = selected.tab;
    if (selected.id === "scope") { scope = selected.value === "project" && options.projectTrusted ? "project" : "global"; continue; }
    if (tab === "Actions") {
      let command: PtbAction;
      if (selected.id === "graph") {
        const limit = await ctx.ui.select("Task graph limit", [...PTB_GRAPH_LIMITS]);
        if (limit === undefined) continue;
        command = { kind: "graph", limit: limit as "25" | "50" | "100" | "200" | "all" };
      } else if (selected.id === "doctor") {
        const team = await ctx.ui.input("Doctor Team (empty uses current Team)", options.teamName ?? "");
        if (team === undefined) continue;
        if (team && !/^[A-Za-z0-9_-]{1,64}$/.test(team)) { notify("Use a Team name with letters, digits, underscores, or hyphens (1–64 characters).", "warning"); continue; }
        command = { kind: "doctor", ...(team ? { teamName: team } : {}) };
      } else if (["help", "status", "sync", "settings_check"].includes(selected.id)) command = { kind: selected.id } as PtbAction;
      else continue;
      if (current()) await options.runAction(command);
      return;
    }
    if (!document) continue;
    const next = structuredClone(record(document.namespace));
    try {
      if (selected.id === "json") {
        let draft = JSON.stringify(document.namespace, null, 2);
        let saved = false;
        while (current()) {
          const content = await ctx.ui.editor(`PTB ${scope} configuration — Save continues to confirmation`, draft);
          if (content === undefined) break;
          draft = content;
          try {
            const parsed: unknown = JSON.parse(content);
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("PTB configuration must be a JSON object.");
            saved = await save(parsed as RecordValue, document);
            break;
          } catch (error) {
            notify(`Settings were not saved: ${error instanceof Error ? error.message : String(error)}`, "error");
            if (error instanceof Error && "code" in error && error.code !== "invalid_settings") break;
          }
        }
        if (!saved) continue;
      } else if (selected.id === "edit_role") {
        const localRoles = record(next.model_roles);
        const inheritedRoles = scope === "project" ? record(record(readPtbSettingsDocument({ cwd: ctx.cwd, projectTrusted: false, scope: "global" }).namespace).model_roles) : {};
        const choicesByName = new Map<string, string>([
          ...Object.keys(localRoles).map((name) => [name, name] as [string, string]),
          ...Object.keys(inheritedRoles).filter((name) => !Object.hasOwn(localRoles, name)).map((name) => [`${name} (override global)`, name] as [string, string]),
        ]);
        const picked = choicesByName.size ? await ctx.ui.select(`Model role in ${scope}`, ["Add role…", ...choicesByName.keys()]) : "Add role…";
        if (picked === undefined) continue;
        const name = picked === "Add role…" ? await ctx.ui.input(`New role name in ${scope}`, "") : choicesByName.get(picked);
        if (name === undefined) continue;
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error("Use a role name with letters, digits, underscores, or hyphens (1–64 characters).");
        const existing = record(Object.hasOwn(localRoles, name) ? localRoles[name] : inheritedRoles[name]);
        const available = ctx.modelRegistry?.getAvailable?.().map((model) => `${model.provider}/${model.id}`) ?? [];
        const choices = [...new Set([...(typeof existing.model === "string" ? [existing.model] : []), ...available])];
        const model = choices.length ? await ctx.ui.select("Model for new Workers", choices) : await ctx.ui.input("Qualified model (provider/model)", String(existing.model ?? ""));
        if (model === undefined) continue;
        const supported = captureQualifiedAvailableModelKeys(ctx.modelRegistry)?.thinkingLevelsByKey?.get(model);
        const levels = THINKING_LEVELS.filter((level) => !supported || supported.has(level));
        const thinking = await ctx.ui.select("Thinking level", [...new Set([...(typeof existing.thinking === "string" && levels.some((level) => level === existing.thinking) ? [existing.thinking] : []), ...levels])]);
        if (thinking === undefined) continue;
        const use = await ctx.ui.input("When should the leader use this role?", String(existing.use ?? ""));
        if (use === undefined) continue;
        assign(next, ["model_roles", name], { model, thinking, use });
        if (!await save(next, document)) continue;
      } else {
        const field = FIELDS.find((candidate) => candidate.id === selected.id);
        if (!field) continue;
        const previous = own(next, [...field.path]);
        let value: unknown;
        if (field.kind === "boolean" || field.kind === "tiling" || field.kind === "role") {
          const inherited = scope === "project" ? readPtbSettingsDocument({ cwd: ctx.cwd, projectTrusted: false, scope: "global" }).namespace : {};
          const roleNames = Object.keys({ ...record(record(inherited).model_roles), ...record(next.model_roles) });
          const choices = field.kind === "boolean" ? ["true", "false"] : field.kind === "tiling" ? ["linear", "grid"] : roleNames;
          const selection = await ctx.ui.select(field.label, [...choices, "Remove override"]);
          if (selection === undefined) continue;
          value = selection === "Remove override" ? undefined : field.kind === "boolean" ? selection === "true" : selection;
        } else if (field.kind === "array") {
          const content = await ctx.ui.editor(`${field.label} — JSON array`, JSON.stringify(previous ?? [], null, 2));
          if (content === undefined) continue;
          value = JSON.parse(content);
        } else {
          const content = await ctx.ui.input(`${field.label} (empty removes override)`, previous === undefined ? "" : String(previous));
          if (content === undefined) continue;
          value = content === "" ? undefined : field.kind === "number" ? Number(content) : content;
        }
        // Pane layout is one complete policy in the existing contract.
        if ((field.id === "leader_share" || field.id === "worker_tiling") && value !== undefined) {
          const layout = record(record(next.team).pane_layout);
          const globalNamespace = scope === "project" ? readPtbSettingsDocument({ cwd: ctx.cwd, projectTrusted: false, scope: "global" }).namespace : {};
          const inherited = normalizeTeamPaneLayout(record(next.team).pane_layout ?? record(record(globalNamespace).team).pane_layout);
          if (layout.leader_share === undefined) assign(next, ["team", "pane_layout", "leader_share"], inherited.leader_share);
          if (layout.worker_tiling === undefined) assign(next, ["team", "pane_layout", "worker_tiling"], inherited.worker_tiling);
        }
        if ((field.id === "leader_share" || field.id === "worker_tiling") && value === undefined) assign(next, ["team", "pane_layout"], undefined);
        else assign(next, [...field.path], value);
        if (!await save(next, document)) continue;
      }
      notify(`Saved ${scope} PTB settings. Team policies apply to new Teams; Worker settings apply on future launches. Existing model bindings stay unchanged.`);
    } catch (error) { notify(`Settings were not saved: ${error instanceof Error ? error.message : String(error)}`, "error"); }
  }
  async function save(next: RecordValue, document: PtbSettingsDocument): Promise<boolean> {
    if (!current()) return false;
    if (!await ctx.ui.confirm(`Save ${scope} PTB settings?`, `File: ${document.file}\nExisting Teams and Worker bindings stay unchanged.`)) return false;
    if (!current()) return false;
    await savePtbSettingsDocument(document, next, { isCurrent: options.isCurrent });
    return true;
  }
}
