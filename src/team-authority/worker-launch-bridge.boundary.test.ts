import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkerLaunchBridge,
  type WorkerLaunchBridgeDependencies,
} from "./worker-launch-bridge";
import type { TeamLifecyclePublication } from "./team-lifecycle-publication";

function publication(): TeamLifecyclePublication {
  return {
    readEventCursor: vi.fn(() => "0"),
    recordWorkerPrepared: vi.fn(async () => ({ cursor: "1" })),
    recordWorkerStopped: vi.fn(async () => ({ cursor: "1" })),
    recordWorkerSessionBound: vi.fn(async () => ({ cursor: "1" })),
    recordWorkerFailed: vi.fn(async () => ({ cursor: "1" })),
    observeWorkerStartup: vi.fn(async () => ({
      observed: false as const,
      carrier: "prepared" as const,
      runtime: "not_observed" as const,
      cursor: "1",
      reason: "timeout" as const,
    })),
  };
}

describe("Team Worker carrier publication boundary", () => {
  it("delegates bounded startup observation through the injected publication port", async () => {
    const lifecyclePublication = publication();
    const dependencies = {
      buildWorkerArgv: () => [],
      resolveModel: () => null,
      resolveSettingsModel: () => null,
      workerAggregate: () => ({ projectTrusted: false }),
      lifecyclePublication,
    } satisfies WorkerLaunchBridgeDependencies;
    const bridge = createWorkerLaunchBridge(dependencies);

    await expect(bridge.observeLaunchedWorker("team", "worker", "membership", "0")).resolves.toMatchObject({
      observed: false,
      reason: "timeout",
    });
    expect(lifecyclePublication.observeWorkerStartup).toHaveBeenCalledWith({
      teamName: "team",
      workerName: "worker",
      membershipId: "membership",
      afterCursor: "0",
    });
  });

  it("keeps Team carrier realization free of concrete Coordination imports", () => {
    const source = fs.readFileSync(path.join(__dirname, "worker-launch-bridge.ts"), "utf8");
    const compatibility = fs.readFileSync(path.join(__dirname, "../utils/worker-launch-bridge.ts"), "utf8");

    expect(source).toMatch(/lifecyclePublication: TeamLifecyclePublication/);
    expect(source).not.toMatch(/lifecyclePublication\?|requires a TeamLifecyclePublication|DurableTeamLifecyclePublication/);
    expect(source).not.toMatch(/team-events|worker-startup-observation|coordination\//);
    expect(compatibility).toContain('export * from "../team-authority/worker-launch-bridge"');
  });
});
