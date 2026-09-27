import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { captureQualifiedAvailableModelKeys } from "../src/utils/worker-resource-projection";
import { piTeamBrightSettingsExamplePath } from "../src/utils/package-example-path";
import {
  loadModelRoleSettings,
  validateModelRoleCatalog,
  type ModelRoleDiagnostic,
} from "../src/utils/model-role-settings";

/** Owns human-only settings warnings. Settings parsing and Worker selection stay in the shared contract. */
const MAX_REFRESH_ISSUES = 2;
const MAX_COMMAND_ISSUES = 16;
const MAX_LINE = 240;
const MAX_STDERR = 1600;
const signatureStoreKey = Symbol.for("pi-team-bright.settings.stderr-signatures");
const processSignatures: Map<string, string> = (globalThis as any)[signatureStoreKey]
  ?? ((globalThis as any)[signatureStoreKey] = new Map<string, string>());

type WarningContext = {
  cwd?: string;
  hasUI?: boolean;
  ui?: { notify?: (message: string, severity: "warning" | "info") => void };
  modelRegistry?: Pick<ModelRegistry, "getAvailable">;
};

const clean = (value: string, limit = MAX_LINE) => {
  const text = value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
};

function diagnosticsFor(ctx: WarningContext, trusted: boolean): ModelRoleDiagnostic[] {
  const settings = loadModelRoleSettings({ cwd: ctx.cwd ?? process.cwd(), projectTrusted: trusted });
  const available = captureQualifiedAvailableModelKeys(ctx.modelRegistry);
  return [...settings.diagnostics, ...validateModelRoleCatalog(settings, available)];
}

function issueLines(issue: ModelRoleDiagnostic): string[] {
  return [
    clean(`${issue.source} source: ${issue.file}`),
    clean(`${issue.path}: ${issue.message} ${issue.consequence}`),
  ];
}

function warningLines(issues: readonly ModelRoleDiagnostic[], limit: number): string[] {
  return [
    `Pi Team Bright settings: ${issues.length} issue${issues.length === 1 ? "" : "s"}.`,
    ...issues.slice(0, limit).flatMap(issueLines),
    ...(issues.length > limit ? [`${issues.length - limit} more issue${issues.length - limit === 1 ? "" : "s"}; run /ptb settings check for details.`] : []),
    `Example: ${piTeamBrightSettingsExamplePath}`,
  ];
}

/** A refresh emits one warning per issue state and scope. Headless diagnostics use bounded stderr. */
export function createSettingsWarningPresenter(options: {
  read?: typeof diagnosticsFor;
  writeStderr?: (text: string) => void;
} = {}) {
  const read = options.read ?? diagnosticsFor;
  const writeStderr = options.writeStderr ?? ((message: string) => process.stderr.write(message));
  let lastIssues: ModelRoleDiagnostic[] = [];
  const uiSignatures = new Map<string, string>();

  const inspect = (ctx: WarningContext, trusted: boolean): ModelRoleDiagnostic[] => {
    try { return read(ctx, trusted); }
    catch {
      return [{
        source: "global", file: "Pi Team Bright settings", path: "pi_team_bright",
        code: "unreadable", message: "Settings diagnostics could not complete.",
        consequence: "Check the installed example and reload Pi.",
      }];
    }
  };

  const safeStderr = (lines: string[]) => {
    try {
      const output = lines.map((line) => clean(line)).join("\n");
      writeStderr(`${output.length <= MAX_STDERR ? output : `${output.slice(0, MAX_STDERR - 1)}…`}\n`);
    } catch { /* A warning cannot stop Pi. */ }
  };

  return {
    refresh(ctx: WarningContext, trusted: boolean, showForSession: boolean): void {
      const issues = showForSession ? inspect(ctx, trusted) : [];
      lastIssues = issues;
      const scope = `${ctx.cwd ?? process.cwd()}\0${trusted}`;
      const signature = JSON.stringify(issues.map(({ source, file, path, code, message, consequence }) =>
        [source, file, path, code, message, consequence]));
      if (!issues.length) {
        uiSignatures.delete(scope);
        if (showForSession) processSignatures.delete(scope);
        return;
      }
      if (ctx.hasUI !== false && ctx.ui?.notify) {
        if (signature === uiSignatures.get(scope)) return;
        try {
          ctx.ui.notify(warningLines(issues, MAX_REFRESH_ISSUES).join("\n"), "warning");
          if (uiSignatures.size >= 32) uiSignatures.delete(uiSignatures.keys().next().value!);
          uiSignatures.set(scope, signature);
          return;
        } catch { /* Fall back to bounded stderr. */ }
      }
      if (signature !== processSignatures.get(scope)) {
        safeStderr(warningLines(issues, MAX_REFRESH_ISSUES));
        if (processSignatures.size >= 32) processSignatures.delete(processSignatures.keys().next().value!);
        processSignatures.set(scope, signature);
      }
    },
    showAll(ctx: WarningContext, trusted: boolean): void {
      const issues = inspect(ctx, trusted);
      lastIssues = issues;
      const lines = issues.length ? warningLines(issues, MAX_COMMAND_ISSUES) : ["Pi Team Bright settings: no issues."];
      if (ctx.hasUI !== false && ctx.ui?.notify) {
        try { ctx.ui.notify(lines.join("\n"), issues.length ? "warning" : "info"); return; }
        catch { /* Fall back to bounded stderr. */ }
      }
      safeStderr(lines);
    },
    clear(_ctx: WarningContext): void {
      lastIssues = [];
      uiSignatures.clear();
    },
    get issues(): readonly ModelRoleDiagnostic[] { return lastIssues; },
  };
}
