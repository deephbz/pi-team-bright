import type { PtbPaletteItem } from "./ptb-palette";

export type Scope = "global" | "project";
type RecordValue = Record<string, unknown>;
export const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
export const clean = (value: unknown) => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const display = (value: unknown, scope: Scope) => value === undefined ? (scope === "project" ? "No project override" : "Not set here") : clean(typeof value === "string" ? value : JSON.stringify(value));
export const own = (root: RecordValue, keys: string[]): unknown => keys.reduce<unknown>((value, key) => record(value)[key], root);

export const FIELDS = [
  { id: "default_model_role", tab: "Models", label: "Default model role", path: ["default_model_role"], kind: "role", description: "Role used for new Workers when no role is specified." },
  { id: "auto_sync_enabled", tab: "Team", label: "Automatic sync", path: ["team", "auto_sync_enabled"], kind: "boolean", global: true, description: "Enable framework synchronization for new Teams." },
  { id: "auto_sync_delay_seconds", tab: "Team", label: "Sync delay (seconds)", path: ["team", "auto_sync_delay_seconds"], kind: "number", global: true, description: "Delay before automatic synchronization. Applies to new Teams." },
  { id: "auto_sync_update_threshold", tab: "Team", label: "Sync update threshold", path: ["team", "auto_sync_update_threshold"], kind: "number", global: true, description: "Number of changes that triggers synchronization. Applies to new Teams." },
  { id: "wait_seconds", tab: "Team", label: "Sync wait (seconds)", path: ["team", "wait_seconds"], kind: "number", global: true, description: "Internal synchronization recheck interval for new Teams." },
  { id: "leader_share", tab: "Team", label: "Leader pane share", path: ["team", "pane_layout", "leader_share"], kind: "number", description: "Fraction of pane space for the leader, above 0.1 and below 1. Applies to new Teams." },
  { id: "worker_tiling", tab: "Team", label: "Worker pane layout", path: ["team", "pane_layout", "worker_tiling"], kind: "tiling", description: "Linear or adaptive layout for new Teams. Adaptive requires Herdr; grid remains a read-compatible alias." },
  { id: "columns_per_row", tab: "Team", label: "Adaptive columns per row", path: ["team", "pane_layout", "columns_per_row"], kind: "number", description: "Bias used to rank live Worker panes for adaptive placement. Applies to new Teams." },
  { id: "worker_limit", tab: "Team", label: "Worker limit", path: ["team", "pane_layout", "worker_limit"], kind: "number", description: "Optional maximum number of registered Workers. Omit to preserve unlimited historical behavior." },
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
