import { describe, expect, it, vi } from "vitest";

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawnSync,
}));

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
  resolveQualifiedWorkerDefaultModel,
  resolveWorkerLaunchResources,
} from "./worker-resource-projection";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-bright-worker-resource-"));

function policy(overrides: Partial<ReturnType<typeof loadWorkerResourcePolicy>> = {}) {
  return { enable: [], disable: [], diagnostics: [], ...overrides };
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

  it("uses a trusted project's Worker model setting over global and ignores untrusted project settings", () => {
    const root = temp();
    const agent = path.join(root, "agent");
    const cwd = path.join(root, "project");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agent, { recursive: true });
    fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({
      pi_team_bright: { worker: { default_model: "global/model" } },
    }));
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({
      pi_team_bright: { worker: { default_model: "project/model" } },
    }));

    expect(loadWorkerResourcePolicy({ cwd, projectTrusted: true, agentDir: agent }).defaultModel)
      .toEqual({ scope: "project", value: "project/model" });
    expect(loadWorkerResourcePolicy({ cwd, projectTrusted: false, agentDir: agent }).defaultModel)
      .toEqual({ scope: "global", value: "global/model" });
  });

  it("uses PI_CODING_AGENT_DIR for the active global Worker setting", () => {
    const root = temp();
    const agent = path.join(root, "active-agent");
    fs.mkdirSync(agent, { recursive: true });
    fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({
      pi_team_bright: { worker: { default_model: "openrouter/openai/gpt-5.1" } },
    }));
    const prior = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agent;
    try {
      expect(loadWorkerResourcePolicy({ cwd: root, projectTrusted: false }).defaultModel)
        .toEqual({ scope: "global", value: "openrouter/openai/gpt-5.1" });
    } finally {
      if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prior;
    }
  });

  it("retains malformed Worker model setting scope for launch refusal", () => {
    const root = temp();
    const agent = path.join(root, "agent");
    fs.mkdirSync(agent, { recursive: true });
    fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({
      pi_team_bright: { worker: { default_model: 7 } },
    }));

    expect(loadWorkerResourcePolicy({ cwd: root, projectTrusted: false, agentDir: agent }).defaultModel)
      .toEqual({ scope: "global", error: "must be a nonempty qualified provider/model string" });
  });

  it("uses an exact available-model snapshot without a catalog subprocess", () => {
    spawnSync.mockImplementation(() => {
      throw new Error("snapshot validation must not start pi");
    });
    try {
      const snapshot = captureQualifiedAvailableModelKeys({
        getAvailable: () => [
          { provider: "openrouter", id: "openai/gpt-5.1" },
          { provider: "openai", id: "gpt-5.1" },
        ],
      } as never);

      expect(snapshot).toEqual(new Set(["openrouter/openai/gpt-5.1", "openai/gpt-5.1"]));
      expect(resolveQualifiedWorkerDefaultModel("openrouter/openai/gpt-5.1", snapshot)).toBe("openrouter/openai/gpt-5.1");
      expect(resolveQualifiedWorkerDefaultModel("missing/model", snapshot)).toBeNull();
      const emptySnapshot = captureQualifiedAvailableModelKeys({ getAvailable: () => [] } as never);
      expect(resolveQualifiedWorkerDefaultModel("missing/model", emptySnapshot)).toBeNull();
      expect(spawnSync).not.toHaveBeenCalled();
    } finally {
      spawnSync.mockReset();
    }
  });

  it("falls back to Pi's catalog only when the exact model snapshot is unavailable", () => {
    spawnSync.mockReturnValue({
      status: 0,
      stdout: "provider model\nlisted model\n",
    } as never);
    try {
      expect(captureQualifiedAvailableModelKeys(undefined)).toBeUndefined();
      expect(resolveQualifiedWorkerDefaultModel("listed/model")).toBe("listed/model");
      expect(spawnSync).toHaveBeenCalledWith("pi", ["--list-models"], { encoding: "utf8", timeout: 10_000 });
    } finally {
      spawnSync.mockReset();
    }
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

  it("uses saved decisions for a different Worker cwd and trusts when context is unavailable", () => {
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
    fs.writeFileSync(path.join(unknown, ".pi", "settings.json"), JSON.stringify({
      pi_team_bright: { worker: { default_model: "project/model" } },
    }));
    const trustStore = new ProjectTrustStore(agent);
    trustStore.set(savedFalse, false);
    trustStore.set(savedTrue, true);

    expect(resolveWorkerLaunchResources({ cwd: savedFalse, leaderCwd: leader, leaderProjectTrusted: true, agentDir: agent }).projectTrusted).toBe(false);
    expect(resolveWorkerLaunchResources({ cwd: savedTrue, leaderCwd: leader, leaderProjectTrusted: false, agentDir: agent }).projectTrusted).toBe(true);

    const inherited = resolveWorkerLaunchResources({ cwd: unknown, leaderCwd: leader, leaderProjectTrusted: true, agentDir: agent });
    expect(inherited.projectTrusted).toBe(true);
    expect(inherited.policy.defaultModel).toEqual({ scope: "project", value: "project/model" });

    const fallback = resolveWorkerLaunchResources({ cwd: unknown, leaderCwd: leader, agentDir: agent });
    expect(fallback.projectTrusted).toBe(true);
    expect(fallback.policy.defaultModel).toEqual({ scope: "project", value: "project/model" });
    expect(fallback.policy.diagnostics).toContain(
      "Worker Pi trust context unavailable; launched with --approve and trusted project settings enabled.",
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
