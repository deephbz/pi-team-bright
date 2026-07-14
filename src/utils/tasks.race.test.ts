import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTask } from "./tasks";
import * as paths from "./paths";

describe("unmigrated Task authority concurrency", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fails concurrent runtime creates closed without mutating legacy evidence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-legacy-race-"));
    const config = path.join(root, "config.json");
    const legacy = path.join(root, "1.json");
    fs.writeFileSync(config, JSON.stringify({ name: "test-team" }));
    fs.writeFileSync(legacy, JSON.stringify({ id: "1", subject: "evidence" }));
    vi.spyOn(paths, "configPath").mockReturnValue(config);

    try {
      const attempts = Array.from({ length: 20 }, (_, index) =>
        createTask("test-team", `Task ${index}`, `Desc ${index}`),
      );
      const results = await Promise.allSettled(attempts);
      expect(results).toHaveLength(20);
      expect(results.every((result) => result.status === "rejected")).toBe(true);
      for (const result of results) {
        if (result.status === "rejected") {
          expect(String(result.reason)).toContain("npm run migrate:tasks -- test-team");
        }
      }
      expect(JSON.parse(fs.readFileSync(legacy, "utf8"))).toEqual({ id: "1", subject: "evidence" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
