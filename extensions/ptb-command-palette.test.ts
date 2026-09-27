import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPtbPaletteItems, openPtbCommandPalette } from "./ptb-command-palette";

const created: string[] = [];

function harness(selections: Array<{ id: string; tab: "Actions" | "Models" | "Team" | "Workers"; value?: string } | undefined>, mode = "tui") {
  const root = fs.mkdtempSync(path.join(process.env.PI_TEAMS_VITEST_HOME!, "ptb-palette-"));
  created.push(root);
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const ui = {
    custom: vi.fn().mockImplementation(async () => selections.shift()),
    select: vi.fn().mockResolvedValue(undefined),
    input: vi.fn().mockResolvedValue(undefined),
    editor: vi.fn().mockResolvedValue(undefined),
    confirm: vi.fn().mockResolvedValue(false),
    notify: vi.fn(),
  };
  const ctx = { mode, cwd, hasUI: true, ui, modelRegistry: { getAvailable: () => [] } } as any;
  const runAction = vi.fn().mockResolvedValue(undefined);
  const options = { isCurrent: () => true, runAction, role: "team-lead", projectTrusted: false, teamName: "fixture-team" };
  return { root, cwd, agentDir, file: path.join(agentDir, "settings.json"), ctx, ui, runAction, options };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of created.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("/ptb palette coordinator", () => {
  it("routes an Actions choice through the same typed command as direct /ptb", async () => {
    const run = harness([{ id: "graph", tab: "Actions" }]);
    run.ui.select.mockResolvedValueOnce("50");
    await openPtbCommandPalette(run.ctx, run.options);
    expect(run.runAction).toHaveBeenCalledExactlyOnceWith({ kind: "graph", limit: "50" });
    expect(run.ui.custom).toHaveBeenCalledOnce();
    expect(run.ui.confirm).not.toHaveBeenCalled();
    expect(fs.existsSync(run.file)).toBe(false);
  });

  it("cancels native dialogs and suppresses a stale selection before effects", async () => {
    const cancelled = harness([{ id: "doctor", tab: "Actions" }]);
    await openPtbCommandPalette(cancelled.ctx, cancelled.options);
    expect(cancelled.ui.input).toHaveBeenCalledOnce();
    expect(cancelled.runAction).not.toHaveBeenCalled();
    expect(fs.existsSync(cancelled.file)).toBe(false);

    const stale = harness([{ id: "status", tab: "Actions" }]);
    let current = true;
    stale.options.isCurrent = () => current;
    stale.ui.custom.mockImplementationOnce(async () => { current = false; return { id: "status", tab: "Actions" }; });
    await openPtbCommandPalette(stale.ctx, stale.options);
    expect(stale.runAction).not.toHaveBeenCalled();
    expect(stale.ui.notify).toHaveBeenCalledWith(expect.stringContaining("cancelled"), "warning");
  });

  it("does not open a terminal palette through RPC", async () => {
    const run = harness([], "rpc");
    await openPtbCommandPalette(run.ctx, run.options);
    expect(run.ui.custom).not.toHaveBeenCalled();
    expect(run.runAction).not.toHaveBeenCalled();
    expect(run.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive Pi"), "info");
  });

  it("saves one common field only after confirmation and preserves unrelated Pi settings", async () => {
    const run = harness([{ id: "auto_sync_enabled", tab: "Team", value: "Edit" }, undefined]);
    const original = { theme: "dark", another_extension: { enabled: true }, pi_team_bright: { worker: { tools: { disable: ["bash"] } } } };
    fs.writeFileSync(run.file, JSON.stringify(original));
    run.ui.select.mockResolvedValueOnce("false");
    run.ui.confirm.mockResolvedValueOnce(true);
    await openPtbCommandPalette(run.ctx, run.options);
    expect(run.ui.confirm).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(run.file, "utf8"))).toEqual({
      ...original, pi_team_bright: { ...original.pi_team_bright, team: { auto_sync_enabled: false } },
    });
    expect(run.runAction).not.toHaveBeenCalled();
  });

  it("does not write when save is declined or the owner changes during confirmation", async () => {
    for (const staleDuringConfirm of [false, true]) {
      const run = harness([{ id: "auto_sync_enabled", tab: "Team", value: "Edit" }, undefined]);
      fs.writeFileSync(run.file, JSON.stringify({ theme: "dark", pi_team_bright: {} }));
      const before = fs.readFileSync(run.file, "utf8");
      run.ui.select.mockResolvedValueOnce("false");
      let current = true;
      run.options.isCurrent = () => current;
      run.ui.confirm.mockImplementationOnce(async () => { if (staleDuringConfirm) current = false; return staleDuringConfirm; });
      await openPtbCommandPalette(run.ctx, run.options);
      expect(fs.readFileSync(run.file, "utf8")).toBe(before);
      expect(run.runAction).not.toHaveBeenCalled();
    }
  });

  it("cancels a nested model chooser and then the palette without creating settings", async () => {
    const run = harness([{ id: "default_model_role", tab: "Models", value: "Edit" }, undefined]);
    await openPtbCommandPalette(run.ctx, { ...run.options, initialSettingsScope: "global" });
    expect(run.ui.select).toHaveBeenCalledOnce();
    expect(run.ui.confirm).not.toHaveBeenCalled();
    expect(run.runAction).not.toHaveBeenCalled();
    expect(fs.existsSync(run.file)).toBe(false);
  });

  it("reports a post-confirmation revision conflict without a Saved notice", async () => {
    const run = harness([{ id: "auto_sync_enabled", tab: "Team", value: "Edit" }, undefined]);
    fs.writeFileSync(run.file, JSON.stringify({ theme: "dark", pi_team_bright: {} }));
    run.ui.select.mockResolvedValueOnce("false");
    const external = JSON.stringify({ theme: "light", pi_team_bright: {} });
    run.ui.confirm.mockImplementationOnce(async () => { fs.writeFileSync(run.file, external); return true; });
    await openPtbCommandPalette(run.ctx, run.options);
    expect(fs.readFileSync(run.file, "utf8")).toBe(external);
    expect(run.ui.notify.mock.calls.some((call: unknown[]) => String(call[0]).startsWith("Saved "))).toBe(false);
    expect(run.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Settings were not saved"), "error");
  });

  it.each([null, [], "broken"])("offers only raw JSON repair for a malformed PTB namespace %j", (namespace) => {
    const items = buildPtbPaletteItems({ namespace, scope: "global", trusted: true, role: "team-lead" });
    for (const tab of ["Models", "Team", "Workers"]) {
      const ids = items.filter((item) => item.tab === tab).map((item) => item.id);
      expect(ids).toEqual(["scope", "json"]);
      expect(items.find((item) => item.tab === tab && item.id === "json")?.description).toContain("malformed");
    }
  });

  it("repairs a malformed PTB namespace through JSON while keeping Pi keys", async () => {
    const run = harness([{ id: "json", tab: "Models", value: "Edit" }, undefined]);
    fs.writeFileSync(run.file, JSON.stringify({ theme: "dark", pi_team_bright: null }));
    run.ui.editor.mockResolvedValueOnce('{"team":{"auto_sync_enabled":false}}');
    run.ui.confirm.mockResolvedValueOnce(true);
    await openPtbCommandPalette(run.ctx, run.options);
    expect(run.ui.editor.mock.calls[0][1]).toBe("null");
    expect(JSON.parse(fs.readFileSync(run.file, "utf8"))).toEqual({ theme: "dark", pi_team_bright: { team: { auto_sync_enabled: false } } });
    expect(run.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Saved global PTB settings."), "info");
  });

  it("keeps an invalid JSON draft in the editor until cancel and does not save", async () => {
    const run = harness([{ id: "json", tab: "Models", value: "Edit" }, undefined]);
    fs.writeFileSync(run.file, JSON.stringify({ theme: "dark", pi_team_bright: {} }));
    const before = fs.readFileSync(run.file, "utf8");
    run.ui.editor.mockResolvedValueOnce("{invalid").mockResolvedValueOnce(undefined);
    await openPtbCommandPalette(run.ctx, run.options);
    expect(run.ui.editor).toHaveBeenCalledTimes(2);
    expect(run.ui.editor.mock.calls[1][1]).toBe("{invalid");
    expect(run.ui.confirm).not.toHaveBeenCalled();
    expect(fs.readFileSync(run.file, "utf8")).toBe(before);
    expect(run.ui.notify.mock.calls.some((call: unknown[]) => String(call[0]).startsWith("Saved "))).toBe(false);
  });

  it.each([false, true])("offers inherited roles for project override with save=%s", async (save) => {
    const run = harness([{ id: "edit_role", tab: "Models", value: "Edit" }, undefined]);
    const global = { pi_team_bright: { model_roles: { review: { model: "fixture/review", thinking: "low", use: "Global review" } } } };
    fs.writeFileSync(run.file, JSON.stringify(global));
    run.options.projectTrusted = true;
    const projectFile = path.join(run.cwd, ".pi", "settings.json");
    run.ui.select.mockResolvedValueOnce("review (override global)");
    run.ui.select.mockResolvedValueOnce(save ? "fixture/review" : undefined);
    if (save) {
      run.ui.select.mockResolvedValueOnce("low");
      run.ui.input.mockResolvedValueOnce("Project review");
      run.ui.confirm.mockResolvedValueOnce(true);
    }
    await openPtbCommandPalette(run.ctx, { ...run.options, initialSettingsScope: "project" });
    expect(run.ui.select.mock.calls[0][1]).toContain("review (override global)");
    expect(JSON.parse(fs.readFileSync(run.file, "utf8"))).toEqual(global);
    if (save) {
      expect(JSON.parse(fs.readFileSync(projectFile, "utf8"))).toEqual({ pi_team_bright: { model_roles: {
        review: { model: "fixture/review", thinking: "low", use: "Project review" },
      } } });
      expect(run.ui.confirm).toHaveBeenCalledOnce();
    } else {
      expect(fs.existsSync(projectFile)).toBe(false);
      expect(run.ui.confirm).not.toHaveBeenCalled();
    }
  });
});
