import { buildPtbPaletteItems, FIELDS, record, clean, own, type Scope } from "./ptb-palette-items";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { openPtbPalette, type PtbPaletteTab } from "./ptb-palette";
import { PTB_GRAPH_LIMITS, type PtbAction } from "../src/utils/ptb-command";
import { readPtbSettingsDocument, savePtbSettingsDocument, type PtbSettingsDocument } from "../src/utils/ptb-settings-editor";
import { normalizeTeamPaneLayout } from "../src/utils/team-pane-layout";
import { captureQualifiedAvailableModelKeys } from "../src/utils/worker-resource-projection";
import { THINKING_LEVELS } from "../src/team-authority/contracts";

type RecordValue = Record<string, unknown>;

/** Human command/configuration flow. It edits Pi's PTB namespace, never live Team records. */
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
          const choices = field.kind === "boolean" ? ["true", "false"] : field.kind === "tiling" ? ["linear", "adaptive", "grid"] : roleNames;
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
        if (["leader_share", "worker_tiling", "columns_per_row", "worker_limit"].includes(field.id) && value !== undefined) {
          const layout = record(record(next.team).pane_layout);
          const globalNamespace = scope === "project" ? readPtbSettingsDocument({ cwd: ctx.cwd, projectTrusted: false, scope: "global" }).namespace : {};
          const inherited = normalizeTeamPaneLayout(record(next.team).pane_layout ?? record(record(globalNamespace).team).pane_layout);
          for (const key of ["leader_share", "worker_tiling", "columns_per_row", "worker_limit"] as const) {
            if (layout[key] === undefined && inherited[key] !== undefined) assign(next, ["team", "pane_layout", key], inherited[key]);
          }
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
