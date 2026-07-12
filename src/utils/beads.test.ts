import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { bdExecFailure, BeadsError, BeadsTaskStore, BdCommandResult, BdRunner } from "./beads";
import { teamDir } from "./paths";

type FakeIssue = {
  id: string;
  title: string;
  description: string;
  status: "open" | "in_progress" | "closed";
  assignee?: string;
  labels: string[];
  metadata: Record<string, string>;
  updated_at: string;
  dependencies: Array<{ id: string; status: string; dependency_type: "blocks" }>;
  comments: Array<{ id: string; author: string; text: string; created_at: string }>;
};

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

class FakeBd implements BdRunner {
  issues = new Map<string, FakeIssue>();
  sequence = 0;
  version = 0;
  failure: "unavailable" | "malformed" | "timeout" | undefined;

  private touch(issue: FakeIssue): void {
    issue.updated_at = `v${++this.version}`;
  }

  mutate(id: string, change: (issue: FakeIssue) => void): void {
    const issue = this.issues.get(id);
    if (!issue) throw new Error(`missing ${id}`);
    change(issue);
    this.touch(issue);
  }

  async run(args: string[]): Promise<BdCommandResult> {
    if (this.failure === "unavailable") return { stdout: "", stderr: "bd: command not found", exitCode: 127 };
    if (this.failure === "malformed") return { stdout: "not-json", stderr: "", exitCode: 0 };
    if (this.failure === "timeout") return { stdout: "", stderr: "command timed out", exitCode: 124 };
    const commandIndex = args.findIndex(arg => ["create", "list", "show", "update", "link", "comment", "close"].includes(arg));
    const command = args[commandIndex];
    const rest = args.slice(commandIndex + 1);
    const actor = flag(rest, "--actor") || "fake";
    const toJson = (value: unknown): BdCommandResult => ({ stdout: JSON.stringify(value), stderr: "", exitCode: 0 });
    if (command === "create") {
      const metadata = JSON.parse(flag(rest, "--metadata") || "{}");
      const id = `bd-${++this.sequence}`;
      const issue: FakeIssue = {
        id,
        title: flag(rest, "--title") || "",
        description: flag(rest, "--description") || "",
        status: "open",
        labels: [flag(rest, "--labels") || ""],
        metadata,
        updated_at: `v${++this.version}`,
        dependencies: [],
        comments: [],
      };
      this.issues.set(id, issue);
      return toJson(issue);
    }
    if (command === "list") {
      const label = flag(rest, "--label");
      return toJson([...this.issues.values()].filter(issue => !label || issue.labels.includes(label)).map(issue => ({
        ...issue,
        dependency_count: issue.dependencies.length,
        dependent_count: 0,
        comment_count: issue.comments.length,
      })));
    }
    const id = rest[0];
    const issue = this.issues.get(id);
    if (!issue) return { stdout: JSON.stringify({ error: "not found" }), stderr: "not found", exitCode: 1 };
    if (command === "show") return toJson([{ ...issue, comments: issue.comments, dependencies: issue.dependencies }]);
    if (command === "comment") {
      const text = rest[1];
      issue.comments.push({ id: `comment-${issue.comments.length + 1}`, issue_id: issue.id, author: actor, text, created_at: `t${++this.version}` } as any);
      this.touch(issue);
      return toJson(issue.comments.at(-1));
    }
    if (command === "link") {
      const blocker = this.issues.get(rest[1]);
      if (!blocker) return { stdout: "", stderr: "blocker not found", exitCode: 1 };
      if (!issue.dependencies.some(dep => dep.id === blocker.id)) issue.dependencies.push({ id: blocker.id, status: blocker.status, dependency_type: "blocks" });
      this.touch(issue);
      return toJson({ status: "added", issue_id: issue.id, depends_on_id: blocker.id, type: "blocks" });
    }
    if (command === "close") {
      issue.status = "closed";
      this.touch(issue);
      return toJson(issue);
    }
    if (command === "update") {
      const claim = rest.includes("--claim");
      if (claim) {
        if (issue.assignee && issue.assignee !== actor) return { stdout: "", stderr: `issue already claimed by ${issue.assignee}`, exitCode: 1 };
        issue.assignee = actor;
        issue.status = "in_progress";
      }
      const title = flag(rest, "--title");
      const description = flag(rest, "--description");
      if (title !== undefined) issue.title = title;
      if (description !== undefined) issue.description = description;
      const assignee = flag(rest, "--assignee");
      if (assignee !== undefined) issue.assignee = assignee || undefined;
      const status = flag(rest, "--status");
      if (status) issue.status = status as FakeIssue["status"];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--set-metadata") {
          const [key, ...value] = rest[i + 1].split("=");
          issue.metadata[key] = value.join("=");
        }
        if (rest[i] === "--unset-metadata") delete issue.metadata[rest[i + 1]];
      }
      this.touch(issue);
      return toJson(issue);
    }
    return toJson(issue);
  }
}

describe("BeadsTaskStore with fake bd fixture", () => {
  const team = "beads-unit";
  const workspace = path.join(os.tmpdir(), "beads-unit-workspace");

  beforeEach(() => {
    fs.rmSync(teamDir(team), { recursive: true, force: true });
    fs.mkdirSync(teamDir(team), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(teamDir(team), { recursive: true, force: true });
  });

  it("classifies an actual spawn ENOENT as unavailable", async () => {
    expect(bdExecFailure({ code: "ENOENT" })).toEqual({
      stdout: "",
      stderr: "bd: command not found",
      exitCode: 127,
    });
    const runner: BdRunner = { run: async () => bdExecFailure({ code: "ENOENT" }) };
    const store = new BeadsTaskStore({ teamName: team, workspace, runner, requireExpectedVersion: false });
    await expect(store.list()).rejects.toMatchObject({ kind: "unavailable" } satisfies Partial<BeadsError>);
  });

  it("persists create/list/read/update/claim/dependency/progress/close mappings", async () => {
    const fake = new FakeBd();
    const store = new BeadsTaskStore({ teamName: team, workspace, actor: "lead", runner: fake, requireExpectedVersion: false });
    const blocker = await store.create({ subject: "Blocker", description: "first", idempotencyKey: "create-1" });
    const task = await store.create({ subject: "Work", description: "second", activeForm: "Working", idempotencyKey: "create-2" });
    expect(task.id).toBe("bd-2");
    expect((await store.create({ subject: "duplicate", description: "ignored", idempotencyKey: "create-2" })).id).toBe(task.id);

    const claimed = await store.claim(task.id, "worker");
    expect(claimed.owner).toBe("worker");
    const planned = await store.submitPlan(task.id, "inspect, then test");
    expect(planned.status).toBe("planning");
    await store.addDependency(task.id, blocker.id);
    const withProgress = await store.addProgress(task.id, { kind: "progress", text: "half done", actor: "worker" });
    expect(withProgress.metadata?.progressEntries).toEqual([{ text: "half done", actor: "worker", at: "t6" }]);
    const reread = await store.read(task.id);
    expect(reread.blockedBy).toEqual([blocker.id]);
    expect((await store.read(blocker.id)).blocks).toEqual([task.id]);
    await store.update(task.id, { status: "in_progress" });
    expect((await store.update(task.id, { status: "completed" })).status).toBe("completed");
    expect((await store.read(task.id)).status).toBe("completed");
    expect((await store.list()).map(item => item.id)).toEqual([blocker.id, task.id]);
  });

  it("allows exactly one claimant and rejects stale optimistic versions", async () => {
    const fake = new FakeBd();
    const store = new BeadsTaskStore({ teamName: team, workspace, runner: fake, requireExpectedVersion: false });
    const task = await store.create({ subject: "Race", description: "race" });
    const results = await Promise.allSettled([store.claim(task.id, "a"), store.claim(task.id, "b")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected").map(result => String((result as PromiseRejectedResult).reason))).toHaveLength(1);
    const fresh = await store.read(task.id);
    fake.mutate(task.id, issue => { issue.title = "human edit"; });
    await expect(store.update(task.id, { description: "lost?" }, { expectedVersion: fresh.version })).rejects.toMatchObject({ kind: "conflict" });
  });

  it("refuses a task ID outside the configured team scope", async () => {
    const fake = new FakeBd();
    const store = new BeadsTaskStore({ teamName: team, workspace, runner: fake, requireExpectedVersion: false });
    const task = await store.create({ subject: "Scoped", description: "scope" });
    fake.mutate(task.id, issue => { issue.labels = ["pi-teams:other-team"]; });
    await expect(store.read(task.id)).rejects.toMatchObject({ kind: "scope" });
  });

  it.each([
    ["unavailable", "unavailable"],
    ["malformed", "malformed"],
    ["timeout", "timeout"],
  ] as const)("surfaces bd %s errors", async (failure, kind) => {
    const fake = new FakeBd();
    fake.failure = failure;
    const store = new BeadsTaskStore({ teamName: team, workspace, runner: fake, requireExpectedVersion: false });
    await expect(store.list()).rejects.toMatchObject({ kind } satisfies Partial<BeadsError>);
  });

  it("requires expected_version for post-cutover non-claim writes and carries it through comments/links", async () => {
    const fake = new FakeBd();
    const store = new BeadsTaskStore({ teamName: team, workspace, runner: fake, requireExpectedVersion: true });
    const blocker = await store.create({ subject: "Blocker", description: "blocker" });
    const task = await store.create({ subject: "Work", description: "work" });
    await expect(store.update(task.id, { description: "unsafe" })).rejects.toMatchObject({ kind: "conflict" });
    await expect(store.addProgress(task.id, { kind: "progress", text: "unsafe" })).rejects.toMatchObject({ kind: "conflict" });
    await expect(store.addDependency(task.id, blocker.id)).rejects.toMatchObject({ kind: "conflict" });
    const fresh = await store.read(task.id);
    const updated = await store.update(task.id, { description: "narrow" }, { expectedVersion: fresh.version });
    expect(updated.description).toBe("narrow");
    await expect(store.addProgress(task.id, { kind: "progress", text: "stale" }, { expectedVersion: fresh.version })).rejects.toMatchObject({ kind: "conflict" });
  });
});
