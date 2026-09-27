import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPtbSettingsDocument, savePtbSettingsDocument } from "./ptb-settings-editor";

const created: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.PI_TEAMS_VITEST_HOME!, "ptb-settings-editor-"));
  created.push(root);
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const global = path.join(agentDir, "settings.json");
  const project = path.join(cwd, ".pi", "settings.json");
  return { root, cwd, agentDir, global, project };
}

function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of created.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Pi Team Bright settings editor", () => {
  it("updates only its namespace and keeps Pi and other extension settings with file mode", async () => {
    const box = fixture();
    const original = {
      theme: "dark", editor: { tabSize: 2 }, another_extension: { enabled: true },
      pi_team_bright: {
        model_roles: { review: { model: "fixture/review", thinking: "low", use: "Review" } },
        worker: { tools: { disable: ["bash"] } },
        team: { pane_layout: { leader_share: 0.7, worker_tiling: "grid" } },
      },
    };
    write(box.global, original);
    fs.chmodSync(box.global, 0o640);
    const beforeMode = fs.statSync(box.global).mode & 0o777;
    const document = readPtbSettingsDocument({ cwd: box.cwd, agentDir: box.agentDir, projectTrusted: false, scope: "global" });
    const saved = await savePtbSettingsDocument(document, { ...(document.namespace as Record<string, unknown>), default_model_role: "review" });
    expect(JSON.parse(fs.readFileSync(box.global, "utf8"))).toEqual({
      ...original, pi_team_bright: { ...original.pi_team_bright, default_model_role: "review" },
    });
    expect(fs.statSync(box.global).mode & 0o777).toBe(beforeMode);
    expect(saved.revision).not.toBe(document.revision);
  });

  it("fails closed on concurrent edits and leaves the external edit intact", async () => {
    const box = fixture();
    write(box.global, { theme: "dark", pi_team_bright: {} });
    const document = readPtbSettingsDocument({ cwd: box.cwd, agentDir: box.agentDir, projectTrusted: false, scope: "global" });
    const external = JSON.stringify({ theme: "light", pi_team_bright: {} });
    fs.writeFileSync(box.global, external);
    await expect(savePtbSettingsDocument(document, { team: { auto_sync_enabled: false } }))
      .rejects.toMatchObject({ code: "concurrent_change" });
    expect(fs.readFileSync(box.global, "utf8")).toBe(external);
  });

  it("repairs an invalid PTB namespace through a valid replacement but still checks revision", async () => {
    const box = fixture();
    write(box.global, { theme: "dark", pi_team_bright: null });
    const first = readPtbSettingsDocument({ cwd: box.cwd, agentDir: box.agentDir, projectTrusted: false, scope: "global" });
    expect(first.namespace).toBeNull();
    await savePtbSettingsDocument(first, { team: { auto_sync_enabled: false } });
    expect(JSON.parse(fs.readFileSync(box.global, "utf8"))).toEqual({ theme: "dark", pi_team_bright: { team: { auto_sync_enabled: false } } });

    fs.writeFileSync(box.global, JSON.stringify({ theme: "dark", pi_team_bright: [] }));
    const second = readPtbSettingsDocument({ cwd: box.cwd, agentDir: box.agentDir, projectTrusted: false, scope: "global" });
    expect(second.namespace).toEqual([]);
    const external = JSON.stringify({ theme: "light", pi_team_bright: [] });
    fs.writeFileSync(box.global, external);
    await expect(savePtbSettingsDocument(second, { team: { auto_sync_enabled: true } }))
      .rejects.toMatchObject({ code: "concurrent_change" });
    expect(fs.readFileSync(box.global, "utf8")).toBe(external);
  });

  it("rejects untrusted and invalid project edits before writing", async () => {
    const box = fixture();
    expect(() => readPtbSettingsDocument({ cwd: box.cwd, agentDir: box.agentDir, projectTrusted: false, scope: "project" }))
      .toThrowError(expect.objectContaining({ code: "untrusted_project" }));
    write(box.project, { pi_team_bright: { model_roles: { inherited: { model: "fixture/model", thinking: "low", use: "Global" } } } });
    const original = fs.readFileSync(box.project, "utf8");
    const document = readPtbSettingsDocument({ cwd: box.cwd, agentDir: box.agentDir, projectTrusted: true, scope: "project" });
    await expect(savePtbSettingsDocument(document, { ...(document.namespace as Record<string, unknown>), team: { auto_sync_enabled: true } }))
      .rejects.toMatchObject({ code: "invalid_settings" });
    await expect(savePtbSettingsDocument(document, { ...(document.namespace as Record<string, unknown>), model_roles: { broken: { model: "unqualified" } } }))
      .rejects.toMatchObject({ code: "invalid_settings" });
    expect(fs.readFileSync(box.project, "utf8")).toBe(original);
  });

  it("lets a project select a valid inherited role despite unrelated global diagnostics", async () => {
    const box = fixture();
    write(box.global, { pi_team_bright: {
      model_roles: { review: { model: "fixture/review", thinking: "low", use: "Review" } },
      team: { obsolete_unrelated_key: true },
    } });
    write(box.project, { theme: "light", pi_team_bright: {} });
    const document = readPtbSettingsDocument({ cwd: box.cwd, agentDir: box.agentDir, projectTrusted: true, scope: "project" });
    await savePtbSettingsDocument(document, { default_model_role: "review" });
    expect(JSON.parse(fs.readFileSync(box.project, "utf8"))).toEqual({
      theme: "light", pi_team_bright: { default_model_role: "review" },
    });
  });

  it("rejects malformed and symlink settings without replacing the source", () => {
    const box = fixture();
    fs.writeFileSync(box.global, "PRIVATE_INVALID_JSON");
    expect(() => readPtbSettingsDocument({ cwd: box.cwd, agentDir: box.agentDir, projectTrusted: false, scope: "global" }))
      .toThrowError(expect.objectContaining({ code: "invalid_settings" }));
    fs.unlinkSync(box.global);
    const target = path.join(box.root, "outside.json");
    write(target, { theme: "outside" });
    fs.symlinkSync(target, box.global);
    expect(() => readPtbSettingsDocument({ cwd: box.cwd, agentDir: box.agentDir, projectTrusted: false, scope: "global" }))
      .toThrowError(expect.objectContaining({ code: "invalid_settings" }));
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ theme: "outside" });
  });

  it("reports an atomic write failure without claiming a saved revision", async () => {
    const box = fixture();
    write(box.global, { theme: "dark", pi_team_bright: {} });
    const before = fs.readFileSync(box.global, "utf8");
    const document = readPtbSettingsDocument({ cwd: box.cwd, agentDir: box.agentDir, projectTrusted: false, scope: "global" });
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("fixture rename failure"); });
    await expect(savePtbSettingsDocument(document, { team: { auto_sync_enabled: false } }))
      .rejects.toMatchObject({ code: "write_failed" });
    expect(fs.readFileSync(box.global, "utf8")).toBe(before);
  });

  it("checks the live owner inside the save boundary", async () => {
    const box = fixture();
    write(box.global, { theme: "dark", pi_team_bright: {} });
    const before = fs.readFileSync(box.global, "utf8");
    const document = readPtbSettingsDocument({ cwd: box.cwd, agentDir: box.agentDir, projectTrusted: false, scope: "global" });
    await expect(savePtbSettingsDocument(document, { team: { auto_sync_enabled: false } }, { isCurrent: () => false }))
      .rejects.toMatchObject({ code: "stale_context" });
    expect(fs.readFileSync(box.global, "utf8")).toBe(before);
  });

  it("refuses a candidate that exceeds the bounded settings file", async () => {
    const box = fixture();
    write(box.global, { theme: "dark", pi_team_bright: {} });
    const before = fs.readFileSync(box.global, "utf8");
    const document = readPtbSettingsDocument({ cwd: box.cwd, agentDir: box.agentDir, projectTrusted: false, scope: "global" });
    await expect(savePtbSettingsDocument(document, { model_roles: { enormous: { model: "fixture/model", thinking: "low", use: "x".repeat(2 * 1024 * 1024) } } }))
      .rejects.toMatchObject({ code: "invalid_settings" });
    expect(fs.readFileSync(box.global, "utf8")).toBe(before);
  });
});
