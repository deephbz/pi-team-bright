import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadModelRoleSettings,
  resolveWorkerModelRole,
  validateModelRoleCatalog,
  WorkerModelRoleConfigurationError,
  type AvailableModelRoles,
} from "../src/utils/model-role-settings";

const roots: string[] = [];
const role = (model: string, thinking = "low", use = "Worker work") => ({ model, thinking, use });
function catalog(...keys: string[]): AvailableModelRoles {
  return Object.assign(new Set(keys), {
    thinkingLevelsByKey: new Map(keys.map(key => [key, new Set(["low", "medium", "high", "max"] as const)])),
  });
}

function workspace() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "model-role-independent-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  return {
    root, agentDir, cwd,
    global(value: unknown) { fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(value)); },
    project(value: unknown) { fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify(value)); },
    load(projectTrusted: boolean) { return loadModelRoleSettings({ cwd, agentDir, projectTrusted }); },
  };
}

function refusal(action: () => unknown): WorkerModelRoleConfigurationError {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(WorkerModelRoleConfigurationError);
    return error as WorkerModelRoleConfigurationError;
  }
  throw new Error("Expected Worker model role selection to refuse");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("model role settings at the selection boundary", () => {
  it("loads the shipped copyable configuration and binds its default exactly like an explicit name", () => {
    const fixture = workspace();
    const example = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../docs/examples/pi-team-bright.settings.json");
    fs.copyFileSync(example, path.join(fixture.agentDir, "settings.json"));
    const settings = fixture.load(false);
    expect(settings.diagnostics).toEqual([]);
    expect(settings.defaultRole).toBe("standard-worker");
    const available = catalog(...Object.values(settings.roles).map(({ model }) => model));
    expect(resolveWorkerModelRole(undefined, settings, available))
      .toEqual(resolveWorkerModelRole("standard-worker", settings, available));
  });

  it("uses whole trusted project entries, including a project default that names a global role", () => {
    const fixture = workspace();
    fixture.global({ pi_team_bright: {
      model_roles: { global: role("fixture/global"), shared: role("fixture/global-shared") },
      default_model_role: "shared",
    } });
    fixture.project({ pi_team_bright: {
      model_roles: { shared: role("openrouter/openai/gpt-5.6/local", "high", "Project use") },
      default_model_role: "global",
    } });
    const trusted = fixture.load(true);
    expect(resolveWorkerModelRole("shared", trusted, catalog("openrouter/openai/gpt-5.6/local")))
      .toMatchObject({ alias: "shared", provider: "openrouter", model: "openai/gpt-5.6/local", thinking: "high" });
    expect(resolveWorkerModelRole(undefined, trusted, catalog("fixture/global"))).toMatchObject({ alias: "global" });
    const untrusted = fixture.load(false);
    expect(resolveWorkerModelRole(undefined, untrusted, catalog("fixture/global-shared")))
      .toMatchObject({ alias: "shared", model: "global-shared" });
    const unknownTrust = loadModelRoleSettings({ cwd: fixture.cwd, agentDir: fixture.agentDir, projectTrusted: undefined as unknown as boolean });
    expect(unknownTrust.roles).toEqual(untrusted.roles);
  });

  it("refuses an invalid shadow and dangling inherited default while keeping a valid sibling usable", () => {
    const fixture = workspace();
    fixture.global({ pi_team_bright: {
      model_roles: { shared: role("fixture/global"), good: role("fixture/good") },
      default_model_role: "shared",
    } });
    fixture.project({ pi_team_bright: { model_roles: { shared: { model: "fixture/project", use: "Missing thinking" } } } });
    const settings = fixture.load(true);
    expect(settings.roles).not.toHaveProperty("shared");
    expect(settings.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "project", path: "pi_team_bright.model_roles.shared", code: "invalid_value" }),
      expect.objectContaining({ path: "pi_team_bright.default_model_role", code: "dangling_reference" }),
    ]));
    expect(refusal(() => resolveWorkerModelRole("shared", settings, catalog("fixture/global", "fixture/project"))).code)
      .toBe("invalid_role");
    expect(refusal(() => resolveWorkerModelRole(undefined, settings, catalog("fixture/global"))).code)
      .toBe("invalid_default");
    expect(resolveWorkerModelRole("good", settings, catalog("fixture/good"))).toMatchObject({ model: "good" });
  });

  it("allows explicit selection without a default and refuses omission, obsolete keys, and unavailable models", () => {
    const fixture = workspace();
    fixture.global({ pi_team_bright: {
      model_roles: { available: role("fixture/available"), absent: role("fixture/absent") },
      model_profiles: { old: {} },
      worker: { default_model: "fixture/old" },
    } });
    const settings = fixture.load(false);
    expect(settings.diagnostics.filter(({ code }) => code === "obsolete_key").map(({ path: field }) => field).sort())
      .toEqual(["pi_team_bright.model_profiles", "pi_team_bright.worker.default_model"]);
    expect(resolveWorkerModelRole("available", settings, catalog("fixture/available"))).toMatchObject({ alias: "available" });
    expect(refusal(() => resolveWorkerModelRole(undefined, settings, catalog("fixture/available"))).code)
      .toBe("missing_default");
    expect(refusal(() => resolveWorkerModelRole("absent", settings, catalog("fixture/available"))).code)
      .toBe("unavailable_model");
  });

  it("separates malformed JSON from missing settings and checks thinking support without provider work", () => {
    const fixture = workspace();
    expect(fixture.load(false).diagnostics).toEqual([]);
    fs.writeFileSync(path.join(fixture.agentDir, "settings.json"), '{"pi_team_bright":');
    const malformed = fixture.load(false);
    expect(malformed.diagnostics).toEqual([expect.objectContaining({ code: "malformed_json", source: "global" })]);
    expect(refusal(() => resolveWorkerModelRole("any", malformed, catalog("fixture/any"))).code).toBe("invalid_map");

    fixture.global({ unrelatedPiSetting: "do not echo this", pi_team_bright: {
      model_roles: { unsupported: role("fixture/limited", "max") }, default_model_role: "unsupported",
    } });
    const settings = fixture.load(false);
    const limited = Object.assign(new Set(["fixture/limited"]), {
      thinkingLevelsByKey: new Map([["fixture/limited", new Set(["off", "low"] as const)]]),
    });
    expect(validateModelRoleCatalog(settings, limited)).toEqual([
      expect.objectContaining({ code: "unsupported_thinking", path: "pi_team_bright.model_roles.unsupported.thinking" }),
    ]);
    expect(refusal(() => resolveWorkerModelRole(undefined, settings, limited)).code).toBe("unsupported_thinking");
    expect(JSON.stringify(settings.diagnostics)).not.toContain("do not echo this");
  });
});
