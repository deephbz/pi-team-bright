import { describe, expect, it, vi } from "vitest";
import { Check } from "typebox/value";
import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import { modelToolCatalog, TaskLinkResultSchema, WorkerStopResultSchema, TeamShutdownResultSchema, AlertSendResultSchema } from "./catalog";
import { ModelResultSchemas, projectToolResult, assembleToolResult } from "./result-projection";

vi.mock("typebox/compile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("typebox/compile")>();
  return { ...actual, Compile: vi.fn(actual.Compile) };
});

function* mutations(value: any): Generator<unknown> {
  yield undefined;
  yield null;
  yield false;
  yield 0;
  yield "";
  yield [];
  yield {};
  if (Array.isArray(value)) {
    yield [...value, null];
    if (value.length) yield [value[0], value[0]];
    for (let i = 0; i < value.length; i++) {
      for (const changed of mutations(value[i])) {
        const copy = [...value];
        copy[i] = changed;
        yield copy;
      }
    }
  } else if (value && typeof value === "object") {
    yield { ...value, unexpected_property: true };
    for (const key of Object.keys(value)) {
      const absent = { ...value };
      delete absent[key];
      yield absent;
      for (const changed of mutations(value[key])) yield { ...value, [key]: changed };
    }
  } else if (typeof value === "string") {
    yield "invalid-enum-or-pattern";
    yield "x".repeat(2001);
  } else if (typeof value === "number") {
    yield -1;
    yield 0.5;
    yield NaN;
    yield Infinity;
  }
}

describe("compiled result validation", () => {
  it("compiles lazily once per schema and revalidates a mutated result", () => {
    const compile = vi.mocked(Compile);
    compile.mockClear();
    const raw = { kind: "worker_stopped", worker: "synthetic-worker", state_changed: true };
    expect(projectToolResult("worker_stop", raw)).toEqual({ kind: raw.kind, worker: raw.worker });
    expect(compile).toHaveBeenCalledTimes(2);
    expect(assembleToolResult("worker_stop", raw as any).details).toBe(raw);
    expect(compile).toHaveBeenCalledTimes(2);
    raw.worker = "";
    expect(() => projectToolResult("worker_stop", raw)).toThrow("Invalid semantic result for worker_stop.");
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it("matches interpreted validation for catalog results and recursive malformed variants", () => {
    let comparisons = 0;
    const compare = (schema: TSchema, value: unknown) => {
      const validator = Compile(schema);
      expect(validator.IsAccelerated()).toBe(true);
      for (const candidate of [value, ...mutations(value)]) {
        expect(validator.Check(candidate)).toBe(Check(schema, candidate));
        comparisons++;
      }
    };
    for (const tool of modelToolCatalog.tools) {
      for (const example of tool.examples) {
        compare(tool.result, example.result);
        compare(ModelResultSchemas[tool.name], projectToolResult(tool.name, example.result));
      }
    }
    const linked = { kind: "task_linked", task_id: "one", target_id: "two", relation: "related", action: "add", changed: true, version: "v_0123456789abcdef" };
    compare(TaskLinkResultSchema, linked);
    compare(ModelResultSchemas.task_link, linked);
    const additional = [
      ["worker_stop", WorkerStopResultSchema, { kind: "worker_stopped", worker: "worker", state_changed: true }],
      ["team_shutdown", TeamShutdownResultSchema, { kind: "partial", lifecycle: "active", stopped_workers: [], failed_workers: ["worker"], unfinished_task_ids: ["one"], state_changed: true }],
      ["alert_send", AlertSendResultSchema, { kind: "alert_sent", alert_id: "alert", accepted_recipients: ["worker"], failed_recipients: [], task_state_changed: false }],
    ] as const;
    for (const [tool, schema, value] of additional) {
      compare(schema, value);
      compare(ModelResultSchemas[tool], projectToolResult(tool, value));
    }
    // The compatibility spelling shares both graph schemas.
    const graphTool = modelToolCatalog.tools.find(tool => tool.name === "task_graph_apply")!;
    for (const example of graphTool.examples) {
      expect(projectToolResult("task_create", example.result)).toEqual(projectToolResult("task_graph_apply", example.result));
    }
    expect(comparisons).toBeGreaterThan(1000);
  });

  it("keeps model-projection failure distinct from semantic failure", async () => {
    // Force rejection at the second boundary to verify its exact error.
    const compile = vi.mocked(Compile);
    const raw = { kind: "missing", task_id: "one", reason: "task_not_found", state_changed: false };
    const original = Compile(ModelResultSchemas.task_read);
    compile.mockImplementationOnce(() => ({ ...original, Check: () => true }) as any);
    compile.mockImplementationOnce(() => ({ ...original, Check: () => false }) as any);
    // Isolate the module cache so this test does not reuse earlier validators.
    vi.resetModules();
    const { projectToolResult: isolated } = await import("./result-projection.js");
    expect(() => isolated("task_read", raw)).toThrow("Invalid model projection for task_read.");
  });
});
