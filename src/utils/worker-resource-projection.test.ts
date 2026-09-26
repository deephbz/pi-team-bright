import { describe, expect, it } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import {
  captureQualifiedAvailableModelKeys,
  loadWorkerResourcePolicy,
  materializeWorkerAggregate,
  projectWorkerTools,
  removeWorkerAggregate,
  resolveWorkerLaunchResources,
} from "./worker-resource-projection";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-bright-worker-resource-"));

function policy(overrides: Partial<ReturnType<typeof loadWorkerResourcePolicy>> = {}) {
  return {
    enable: [], disable: [], diagnostics: [],
    modelRoleSettings: {
      roles: {}, diagnostics: [], invalidRoles: new Set<string>(), invalidDefault: false,
      invalidRoleMap: false, invalidGlobalRoleMap: false, invalidProjectRoleMap: false,
      roleSources: {}, sourceFiles: { global: "", project: "" },
    },
    ...overrides,
  };
}

describe("Worker resource projection", () => {
  it("uses trusted project settings and disable wins", () => {
    const root = temp();
    const agent = path.join(root, "agent");
    const cwd = path.join(root, "project");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agent, { recursive: true });
    fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({
      pi_team_bright: { worker: { tools: { enable: ["a"] } } },
    }));
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({
      pi_team_bright: { worker: { tools: { enable: ["b", "a"], disable: ["a"] } } },
    }));

    const loaded = loadWorkerResourcePolicy({ cwd, projectTrusted: true, agentDir: agent });
    expect(projectWorkerTools([], ["a", "b"], loaded)).toEqual(["b"]);
  });

  it("projects the shared model role settings into Worker resources", () => {
    const root = temp();
    const agent = path.join(root, "agent");
    const cwd = path.join(root, "project");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agent, { recursive: true });
    fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ pi_team_bright: {
      model_roles: { worker: { model: "openrouter/openai/gpt-5.6", thinking: "low", use: "Routine work" } },
      default_model_role: "worker",
    } }));
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ pi_team_bright: {
      model_roles: { worker: { model: "openrouter/openai/gpt-5.6/local", thinking: "high", use: "Local work" } },
    } }));

    const trusted = loadWorkerResourcePolicy({ cwd, projectTrusted: true, agentDir: agent });
    expect(trusted.modelRoleSettings.roles.worker.model).toBe("openrouter/openai/gpt-5.6/local");
    expect(trusted.modelRoleSettings.defaultRole).toBe("worker");
    const untrusted = loadWorkerResourcePolicy({ cwd, projectTrusted: false, agentDir: agent });
    expect(untrusted.modelRoleSettings.roles.worker.model).toBe("openrouter/openai/gpt-5.6");
  });

  it("captures exact model keys and supported thinking without a child process", () => {
    const snapshot = captureQualifiedAvailableModelKeys({
      getAvailable: () => [
        { provider: "openrouter", id: "openai/gpt-5.1", reasoning: true },
        { provider: "openai", id: "gpt-5.1", reasoning: false },
      ],
    } as never);
    expect([...snapshot!]).toEqual(["openrouter/openai/gpt-5.1", "openai/gpt-5.1"]);
    expect(snapshot?.thinkingLevelsByKey?.get("openai/gpt-5.1")).toEqual(new Set(["off"]));
    expect(snapshot?.thinkingLevelsByKey?.get("openrouter/openai/gpt-5.1")?.has("low")).toBe(true);
    expect(captureQualifiedAvailableModelKeys(undefined)).toBeUndefined();
  });

  it("aggregates replacement, ancestor context, then append in a private file", () => {
    const root = temp();
    const agent = path.join(root, "agent");
    const cwd = path.join(root, "parent", "project");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(agent, { recursive: true });
    fs.writeFileSync(path.join(agent, "AGENTS.md"), "global");
    fs.writeFileSync(path.join(root, "parent", "AGENTS.md"), "ancestor");
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "project");
    const replace = path.join(root, "replace.md");
    const append = path.join(root, "append.md");
    fs.writeFileSync(replace, "replace");
    fs.writeFileSync(append, "append");

    const aggregate = materializeWorkerAggregate({
      cwd,
      agentDir: agent,
      policy: policy({
        replaceGlobal: { path: replace, content: "replace" },
        appendGlobal: { path: append, content: "append" },
      }),
    })!;
    const text = fs.readFileSync(aggregate, "utf8");
    const replaceAt = text.indexOf("\nreplace\n");
    const ancestorAt = text.indexOf("\nancestor\n");
    const projectAt = text.indexOf("\nproject\n");
    const appendAt = text.lastIndexOf("\nappend\n");
    expect(replaceAt).toBeLessThan(ancestorAt);
    expect(ancestorAt).toBeLessThan(projectAt);
    expect(projectAt).toBeLessThan(appendAt);
    expect(fs.statSync(path.dirname(aggregate)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(aggregate).mode & 0o777).toBe(0o600);
    removeWorkerAggregate(aggregate);
  });

  it("force refreshes a fixed aggregate to native context after both paths disappear", () => {
    const root = temp();
    const agent = path.join(root, "agent");
    const cwd = path.join(root, "project");
    const target = path.join(root, "fixed.md");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(agent, { recursive: true });
    fs.writeFileSync(path.join(agent, "AGENTS.md"), "native-global");
    const append = path.join(root, "append.md");
    fs.writeFileSync(append, "obsolete-append");

    materializeWorkerAggregate({
      cwd,
      agentDir: agent,
      target,
      policy: policy({ appendGlobal: { path: append, content: "obsolete-append" } }),
    });
    materializeWorkerAggregate({ cwd, agentDir: agent, target, policy: policy(), force: true });

    const refreshed = fs.readFileSync(target, "utf8");
    expect(refreshed).toContain("native-global");
    expect(refreshed).not.toContain("obsolete-append");
  });

  it("inherits explicit leader trust for same and different Worker cwds", () => {
    const root = temp();
    const agent = path.join(root, "agent");
    const leader = path.join(root, "leader");
    const worker = path.join(root, "worker");
    fs.mkdirSync(agent, { recursive: true });
    fs.mkdirSync(leader, { recursive: true });
    fs.mkdirSync(worker, { recursive: true });

    expect(resolveWorkerLaunchResources({ cwd: leader, leaderCwd: leader, leaderProjectTrusted: true, agentDir: agent }).projectTrusted).toBe(true);
    expect(resolveWorkerLaunchResources({ cwd: leader, leaderCwd: leader, leaderProjectTrusted: false, agentDir: agent }).projectTrusted).toBe(false);
    expect(resolveWorkerLaunchResources({ cwd: worker, leaderCwd: leader, leaderProjectTrusted: true, agentDir: agent }).projectTrusted).toBe(true);
    expect(resolveWorkerLaunchResources({ cwd: worker, leaderCwd: leader, leaderProjectTrusted: false, agentDir: agent }).projectTrusted).toBe(false);
  });

  it("uses saved trust and excludes project settings when trust is unknown", () => {
    const root = temp();
    const agent = path.join(root, "agent");
    const leader = path.join(root, "leader");
    const savedFalse = path.join(root, "saved-false");
    const savedTrue = path.join(root, "saved-true");
    const unknown = path.join(root, "unknown");
    fs.mkdirSync(agent, { recursive: true });
    fs.mkdirSync(leader, { recursive: true });
    fs.mkdirSync(savedFalse, { recursive: true });
    fs.mkdirSync(savedTrue, { recursive: true });
    fs.mkdirSync(path.join(unknown, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(unknown, ".pi", "settings.json"), JSON.stringify({ pi_team_bright: {
      model_roles: { project: { model: "project/model", thinking: "low", use: "Project role" } },
      worker: { tools: { enable: ["project-tool"] } },
    } }));
    const trustStore = new ProjectTrustStore(agent);
    trustStore.set(savedFalse, false);
    trustStore.set(savedTrue, true);

    expect(resolveWorkerLaunchResources({ cwd: savedFalse, leaderCwd: leader, leaderProjectTrusted: true, agentDir: agent }).projectTrusted).toBe(false);
    expect(resolveWorkerLaunchResources({ cwd: savedTrue, leaderCwd: leader, leaderProjectTrusted: false, agentDir: agent }).projectTrusted).toBe(true);
    const inherited = resolveWorkerLaunchResources({ cwd: unknown, leaderCwd: leader, leaderProjectTrusted: true, agentDir: agent });
    expect(inherited.projectTrusted).toBe(true);
    expect(inherited.policy.modelRoleSettings.roles).toHaveProperty("project");
    const fallback = resolveWorkerLaunchResources({ cwd: unknown, leaderCwd: leader, agentDir: agent });
    expect(fallback.projectTrusted).toBe(false);
    expect(fallback.policy.modelRoleSettings.roles).not.toHaveProperty("project");
    expect(fallback.policy.enable).toEqual([]);
    expect(fallback.policy.diagnostics).toContain(
      "Worker Pi trust context unavailable; project settings ignored and approval was not assumed.",
    );
  });

  it("cleans only an owned private aggregate", () => {
    const root = temp();
    const aggregate = materializeWorkerAggregate({ cwd: root, policy: policy(), force: true })!;
    const outside = path.join(root, "outside.md");
    fs.writeFileSync(outside, "keep");

    removeWorkerAggregate(aggregate);
    removeWorkerAggregate(outside);

    expect(fs.existsSync(aggregate)).toBe(false);
    expect(fs.readFileSync(outside, "utf8")).toBe("keep");
  });

  it("keeps malformed, unavailable, and unknown inputs nonfatal", () => {
    const root = temp();
    const agent = path.join(root, "agent");
    fs.mkdirSync(agent, { recursive: true });
    fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({
      pi_team_bright: { worker: { agents: { replace_global: "/missing", append_global: 4 } } },
    }));

    const loaded = loadWorkerResourcePolicy({ cwd: root, projectTrusted: true, agentDir: agent });
    loaded.enable = ["missing"];
    expect(projectWorkerTools([], ["known"], loaded)).toEqual([]);
    expect(loaded.replaceGlobal).toBeUndefined();
    expect(loaded.appendGlobal).toBeUndefined();
    expect(loaded.diagnostics.length).toBeLessThanOrEqual(8);
  });
});
