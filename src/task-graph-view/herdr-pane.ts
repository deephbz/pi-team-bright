import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execCommand, shellQuote } from "../utils/terminal-adapter";
import { parseTaskGraphLimit, parseTaskGraphViewSource, type TaskGraphRecentLimit, type TaskGraphViewSource } from "./source";

export interface HerdrPaneCoordinate {
  paneId: string;
  tabId: string;
  workspaceId: string;
}

export interface TaskGraphPaneHost {
  getPane(paneId: string): HerdrPaneCoordinate | undefined;
  splitRight(originPaneId: string, cwd: string): string;
  run(paneId: string, command: string): void;
  rename(paneId: string, label: string): void;
  close(paneId: string): void;
}

export interface TaskGraphPaneOrigin extends HerdrPaneCoordinate {
  cwd: string;
}

export interface TaskGraphPaneToggleResult {
  kind: "opened" | "closed";
  paneId: string;
}

interface OwnedPane {
  paneId: string;
  origin: TaskGraphPaneOrigin;
  directory: string;
  sourcePath: string;
}

function sameLocation(left: HerdrPaneCoordinate, right: HerdrPaneCoordinate): boolean {
  return left.tabId === right.tabId && left.workspaceId === right.workspaceId;
}

function validateOrigin(origin: TaskGraphPaneOrigin, host: TaskGraphPaneHost): void {
  if (!origin.paneId || !origin.tabId || !origin.workspaceId || !path.isAbsolute(origin.cwd)) {
    throw new Error("Task graph pane requires exact Herdr pane, tab, workspace, and absolute working directory coordinates.");
  }
  const current = host.getPane(origin.paneId);
  if (!current || current.paneId !== origin.paneId || !sameLocation(current, origin)) {
    throw new Error("The originating Herdr pane no longer matches this exact tab and workspace.");
  }
}

function atomicWrite(target: string, source: TaskGraphViewSource): void {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(parseTaskGraphViewSource(source))}\n`, { flag: "wx", mode: 0o600 });
  fs.renameSync(temp, target);
}

function removeDirectory(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
}

/** Process-local ownership for one derived pane. No terminal coordinate persists. */
export class TaskGraphPaneController {
  private owned?: OwnedPane;

  constructor(
    private readonly host: TaskGraphPaneHost,
    private readonly cliPath: string,
    private readonly nodePath = process.execPath,
  ) {}

  get isOpen(): boolean {
    return !!this.owned;
  }

  get ownedPaneId(): string | undefined {
    return this.owned?.paneId;
  }

  toggle(input: {
    origin: TaskGraphPaneOrigin;
    source: TaskGraphViewSource;
    limit?: TaskGraphRecentLimit;
  }): TaskGraphPaneToggleResult {
    if (this.owned) {
      const paneId = this.owned.paneId;
      this.close();
      return { kind: "closed", paneId };
    }
    validateOrigin(input.origin, this.host);
    const source = parseTaskGraphViewSource(input.source);
    const limit = parseTaskGraphLimit(String(input.limit ?? ""));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-bright-graph-"));
    fs.chmodSync(directory, 0o700);
    const sourcePath = path.join(directory, "view.json");
    atomicWrite(sourcePath, source);
    let paneId: string | undefined;
    try {
      paneId = this.host.splitRight(input.origin.paneId, input.origin.cwd);
      const pane = this.host.getPane(paneId);
      if (!pane || pane.paneId !== paneId || !sameLocation(pane, input.origin)) {
        throw new Error("The new Task graph pane did not stay in the originating Herdr tab and workspace.");
      }
      const command = [
        shellQuote(this.nodePath),
        "--require", shellQuote(require.resolve("ts-node/register/transpile-only")),
        shellQuote(this.cliPath),
        "--source", shellQuote(sourcePath),
        "--limit", shellQuote(String(limit)),
      ].join(" ");
      this.host.run(paneId, command);
      this.host.rename(paneId, `Task graph · ${source.team_name}`);
      this.owned = { paneId, origin: input.origin, directory, sourcePath };
      return { kind: "opened", paneId };
    } catch (error) {
      if (paneId) {
        const pane = this.host.getPane(paneId);
        if (pane && sameLocation(pane, input.origin)) {
          try { this.host.close(paneId); } catch { /* Keep the primary failure. */ }
        }
      }
      removeDirectory(directory);
      throw error;
    }
  }

  update(source: TaskGraphViewSource): void {
    if (!this.owned) return;
    atomicWrite(this.owned.sourcePath, parseTaskGraphViewSource(source));
  }

  close(): void {
    const owned = this.owned;
    if (!owned) return;
    const pane = this.host.getPane(owned.paneId);
    if (pane && !sameLocation(pane, owned.origin)) {
      throw new Error(`Refusing to close Task graph pane ${owned.paneId}: it moved outside the originating tab or workspace.`);
    }
    if (pane) this.host.close(owned.paneId);
    removeDirectory(owned.directory);
    this.owned = undefined;
  }

  /** Forget a created pane that disappeared before refresh or toggle. */
  forgetMissing(): boolean {
    const owned = this.owned;
    if (!owned || this.host.getPane(owned.paneId)) return false;
    removeDirectory(owned.directory);
    this.owned = undefined;
    return true;
  }

  /** Cleanup refuses a moved pane but still removes the private source file. */
  shutdown(): void {
    const owned = this.owned;
    if (!owned) return;
    try {
      const pane = this.host.getPane(owned.paneId);
      if (pane && sameLocation(pane, owned.origin)) this.host.close(owned.paneId);
    } finally {
      removeDirectory(owned.directory);
      this.owned = undefined;
    }
  }
}

type HerdrEnvelope = { result?: unknown; error?: { code?: unknown; message?: unknown } };

function parseEnvelope(stdout: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new Error("Herdr returned malformed JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Herdr returned an invalid JSON envelope.");
  const envelope = value as HerdrEnvelope;
  if (envelope.error) {
    const code = typeof envelope.error.code === "string" ? envelope.error.code : "unknown_error";
    const message = typeof envelope.error.message === "string" ? envelope.error.message : "invalid Herdr error";
    throw new Error(`Herdr request failed: ${code}: ${message}`);
  }
  const result = envelope.result ?? envelope;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Herdr response has no object result.");
  return result as Record<string, unknown>;
}

function paneFrom(value: unknown, expectedPaneId: string): HerdrPaneCoordinate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Herdr response has no pane record.");
  const pane = value as Record<string, unknown>;
  if (pane.pane_id !== expectedPaneId || typeof pane.tab_id !== "string" || typeof pane.workspace_id !== "string") {
    throw new Error(`Herdr response did not prove exact pane ${expectedPaneId}.`);
  }
  return { paneId: expectedPaneId, tabId: pane.tab_id, workspaceId: pane.workspace_id };
}

/** Thin installed-CLI port. Every target is explicit and every split is no-focus. */
export class HerdrCliTaskGraphPaneHost implements TaskGraphPaneHost {
  constructor(
    private readonly binary = process.env.HERDR_BIN_PATH || "herdr",
    private readonly execute = execCommand,
  ) {}

  private invoke(args: string[]): Record<string, unknown> {
    const response = this.execute(this.binary, args);
    try {
      const result = parseEnvelope(response.stdout);
      if (response.status !== 0) throw new Error(`Herdr command failed with status ${response.status}: ${response.stderr || "unknown error"}`);
      return result;
    } catch (error) {
      if (error instanceof Error && /pane_not_found/.test(error.message)) throw error;
      if (response.status !== 0 && !response.stdout.trim()) {
        throw new Error(`Herdr command failed with status ${response.status}: ${response.stderr || (error instanceof Error ? error.message : String(error))}`);
      }
      throw error;
    }
  }

  getPane(paneId: string): HerdrPaneCoordinate | undefined {
    try {
      const result = this.invoke(["pane", "get", paneId]);
      return paneFrom(result.pane, paneId);
    } catch (error) {
      if (error instanceof Error && /pane_not_found/.test(error.message)) return undefined;
      throw error;
    }
  }

  splitRight(originPaneId: string, cwd: string): string {
    const result = this.invoke([
      "pane", "split", "--pane", originPaneId,
      "--direction", "right", "--ratio", "0.65",
      "--cwd", cwd, "--no-focus",
    ]);
    const pane = result.pane;
    if (!pane || typeof pane !== "object" || Array.isArray(pane) || typeof (pane as Record<string, unknown>).pane_id !== "string") {
      throw new Error("Herdr split did not return pane.pane_id.");
    }
    return (pane as Record<string, unknown>).pane_id as string;
  }

  run(paneId: string, command: string): void {
    // Herdr pane run is a fire-and-forget command and returns no JSON envelope.
    const response = this.execute(this.binary, ["pane", "run", paneId, command]);
    if (response.status !== 0) {
      throw new Error(`Herdr command failed with status ${response.status}: ${response.stderr || "unknown error"}`);
    }
  }

  rename(paneId: string, label: string): void {
    this.invoke(["pane", "rename", paneId, label]);
  }

  close(paneId: string): void {
    this.invoke(["pane", "close", paneId]);
  }
}

export function taskGraphPaneOriginFromEnvironment(cwd: string): TaskGraphPaneOrigin {
  if (process.env.HERDR_ENV !== "1") throw new Error("Task graph side panes require HERDR_ENV=1.");
  const paneId = process.env.HERDR_PANE_ID?.trim();
  const tabId = process.env.HERDR_TAB_ID?.trim();
  const workspaceId = process.env.HERDR_WORKSPACE_ID?.trim();
  if (!paneId || !tabId || !workspaceId) throw new Error("Task graph side panes require exact HERDR_PANE_ID, HERDR_TAB_ID, and HERDR_WORKSPACE_ID coordinates.");
  return { paneId, tabId, workspaceId, cwd: path.resolve(cwd) };
}
