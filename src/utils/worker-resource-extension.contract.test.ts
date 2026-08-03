import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeWorkerAggregate } from "./worker-resource-projection";

type RegisteredTool = { name: string; parameters: unknown };
type Handler = (event: any, ctx: any) => Promise<void>;

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-bright-worker-extension-"));
}

async function extensionHarness() {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Handler>();
  let activeTools = ["read"];
  const setActiveTools = vi.fn((tools: string[]) => { activeTools = tools; });
  const extension = (await import("../../extensions/index.js")).default as unknown as (pi: any) => void;
  extension({
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand() {},
    getActiveTools: () => activeTools,
    getAllTools: () => [{ name: "read" }, { name: "bash" }],
    setActiveTools,
  });
  return { handlers, setActiveTools, tools };
}

function context(cwd: string) {
  return {
    cwd,
    isProjectTrusted: () => true,
    ui: { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn(), setFooter: vi.fn() },
    sessionManager: { getSessionFile: () => undefined },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("Worker resource extension projection", () => {
  it("uses one aggregate CLI prompt, exact trust flag, and no tool allowlist", async () => {
    const { buildPiArgv } = await import("../../extensions/index.js");
    expect(buildPiArgv(["pi"], "provider/model", "high", "/private/aggregate.md", true)).toEqual([
      "pi", "--model", "provider/model:high", "--no-context-files", "--append-system-prompt", "/private/aggregate.md", "--approve",
    ]);
    expect(buildPiArgv(["pi"], undefined, undefined, undefined, false)).toEqual(["pi", "--no-approve"]);
  });

  it("keeps leader announcements but omits them from the Worker Alert schema", async () => {
    const home = tempHome();
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    const leader = await extensionHarness();
    vi.stubEnv("PI_AGENT_NAME", "worker");
    vi.resetModules();
    const worker = await extensionHarness();

    expect(JSON.stringify(leader.tools.get("alert_send")!.parameters)).toContain("announcement");
    expect(JSON.stringify(worker.tools.get("alert_send")!.parameters)).not.toContain("announcement");
  });

  it("re-registers the Worker Alert schema after envless Session recovery", async () => {
    const home = tempHome();
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    const teams = await import("./teams.js");
    vi.spyOn(teams, "findTeammateBySessionFile").mockReturnValue({
      teamName: "resume-team",
      member: { name: "resumed-worker", membershipId: "membership-resumed", agentType: "teammate" } as any,
    });
    const harness = await extensionHarness();
    const resumed = { ...context(home), sessionManager: { getSessionFile: () => "/tmp/resumed-worker.jsonl" } };

    await expect(harness.handlers.get("session_start")!({ reason: "resume" }, resumed)).rejects.toThrow();

    expect(JSON.stringify(harness.tools.get("alert_send")!.parameters)).not.toContain("announcement");
    expect(JSON.stringify(harness.tools.get("alert_send")!.parameters)).not.toContain("whole-Team");
  });

  it("restores the Worker active-tool baseline when settings disappear on reload", async () => {
    const home = tempHome();
    const cwd = path.join(home, "project");
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({
      pi_team_bright: { worker: { tools: { enable: ["bash"] } } },
    }));
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_AGENT_NAME", "worker");
    const harness = await extensionHarness();
    const ctx = context(cwd);

    await harness.handlers.get("session_start")!({ reason: "startup" }, ctx);
    fs.writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({
      pi_team_bright: { worker: {} },
    }));
    await harness.handlers.get("session_shutdown")!({ reason: "reload" }, ctx);
    await harness.handlers.get("session_start")!({ reason: "reload" }, ctx);

    // The old extension restores the baseline before Pi replaces it. The new
    // extension then projects the now-empty settings from that baseline.
    expect(harness.setActiveTools.mock.calls).toEqual([[["read", "bash"]], [["read"]], [["read"]]]);
  });

  it("removes an owned aggregate at final Worker shutdown, not reload", async () => {
    const home = tempHome();
    const cwd = path.join(home, "project");
    fs.mkdirSync(cwd, { recursive: true });
    const aggregate = materializeWorkerAggregate({
      cwd,
      policy: { enable: [], disable: [], diagnostics: [] },
      force: true,
    })!;
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_AGENT_NAME", "worker");
    vi.stubEnv("PI_TEAM_BRIGHT_WORKER_AGGREGATE", aggregate);
    const harness = await extensionHarness();

    await harness.handlers.get("session_shutdown")!({ reason: "reload" }, context(cwd));
    expect(fs.existsSync(aggregate)).toBe(true);
    await harness.handlers.get("session_shutdown")!({ reason: "quit" }, context(cwd));
    expect(fs.existsSync(aggregate)).toBe(false);
  });
});
