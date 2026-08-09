import { describe, expect, it } from "vitest";
import {
  parseBenchmarkArguments,
  runTaskHydrationBenchmark,
  summarizeMeasurement,
} from "./task-hydration-benchmark";

describe("Task hydration benchmark", () => {
  it("parses explicit Team and sample arguments into canonical counts", () => {
    expect(parseBenchmarkArguments([
      "--counts", "5,1,5",
      "--team", "benchmark-canary",
      "--samples", "3",
    ])).toEqual({
      teamName: "benchmark-canary",
      samples: 3,
      hydrationCounts: [1, 5],
    });

    expect(() => parseBenchmarkArguments(["--samples", "1", "--counts", "1"])).toThrow("--team is required");
    expect(() => parseBenchmarkArguments(["--team", "x", "--samples", "0", "--counts", "1"])).toThrow("--samples must be a positive");
    expect(() => parseBenchmarkArguments(["--team", "x", "--samples", "1", "--counts", "1,"])).toThrow("comma-separated");
    expect(() => parseBenchmarkArguments(["--team", "x", "--samples", "1", "--other", "1"])).toThrow("Unknown benchmark option");
  });

  it("uses nearest-rank summary math and rounds milliseconds once", () => {
    expect(summarizeMeasurement({
      durationsMs: [50.04, 10.01, 40.03, 20.02, 30.05],
      attemptedSamples: 7,
      successes: 5,
      timeouts: 1,
      errors: 1,
      skippedSamples: 2,
    }, 9)).toEqual({
      requestedSamples: 9,
      attemptedSamples: 7,
      successes: 5,
      timeouts: 1,
      errors: 1,
      skippedSamples: 2,
      p50Ms: 30.1,
      p95Ms: 50,
      maxMs: 50,
    });
  });

  it("emits only aggregate privacy-safe shape while using exact selected IDs", async () => {
    const selected: string[][] = [];
    let clock = 0;
    const result = await runTaskHydrationBenchmark({
      teamName: "private-team-name",
      samples: 1,
      hydrationCounts: [1, 2],
    }, {
      list: async () => ["private-task-id-one", "private-task-id-two"],
      hydrate: async (_teamName, taskIds) => {
        selected.push([...taskIds]);
        return taskIds.map((id) => ({ id, title: "private task text", path: "/private/authority/path" }));
      },
      now: () => clock += 5,
    });

    expect(selected).toEqual([
      ["private-task-id-one"],
      ["private-task-id-one", "private-task-id-two"],
    ]);
    expect(result.schema).toBe("pi-team-bright/task-hydration-benchmark/1");
    expect(result.status).toBe("complete");
    expect(result.productionTimeoutMs).toBe(10_000);
    expect(result.measurements.exactBatchHydration.map(({ taskCount, successes }) => ({ taskCount, successes }))).toEqual([
      { taskCount: 1, successes: 1 },
      { taskCount: 2, successes: 1 },
    ]);

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "private-team-name",
      "private-task-id-one",
      "private-task-id-two",
      "private task text",
      "/private/authority/path",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("accounts for list failures, hydration timeouts, errors, and skipped samples", async () => {
    let listCall = 0;
    let hydrationCall = 0;
    let clock = 0;
    const result = await runTaskHydrationBenchmark({
      teamName: "error-accounting-team",
      samples: 4,
      hydrationCounts: [1],
    }, {
      list: async () => {
        listCall += 1;
        if (listCall === 3) return [];
        if (listCall === 4) throw Object.assign(new Error("timed out"), { kind: "timeout" });
        return ["candidate"];
      },
      hydrate: async () => {
        hydrationCall += 1;
        if (hydrationCall === 1) throw Object.assign(new Error("timed out"), { kind: "timeout" });
        throw new Error("ordinary failure");
      },
      now: () => clock += 1,
    });

    expect(result.status).toBe("partial");
    expect(result.measurements.teamScopedList).toMatchObject({
      requestedSamples: 4,
      attemptedSamples: 4,
      successes: 3,
      timeouts: 1,
      errors: 0,
      skippedSamples: 0,
    });
    expect(result.measurements.exactBatchHydration[0]).toEqual({
      taskCount: 1,
      requestedSamples: 4,
      attemptedSamples: 2,
      successes: 0,
      timeouts: 1,
      errors: 1,
      skippedSamples: 2,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
    });
  });
});
