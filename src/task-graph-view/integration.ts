import fs from "node:fs";
import path from "node:path";
import type { BeadsTaskAdapterFactory } from "../model-tool-contract/beads-task-adapter";
import { readTaskActivity } from "../coordination/event-journal";
import { teamEventJournalPath } from "../utils/paths";
import {
  HerdrCliTaskGraphPaneHost,
  TaskGraphPaneController,
  taskGraphPaneOriginFromEnvironment,
  type TaskGraphPaneToggleResult,
} from "./herdr-pane";
import {
  parseTaskGraphLimit,
  projectGraphControlTaskGraphViewSource,
  projectTaskGraphViewSource,
  type TaskGraphControlTrace,
  type TaskGraphRecentLimit,
  type TaskGraphViewSource,
} from "./source";

export interface TaskGraphControlReadSource {
  hasGraph(teamName: string): boolean;
  /** Read through Task authority's lock; never decode its snapshot directly. */
  trace(teamName: string): Promise<TaskGraphControlTrace>;
  /** Exact authority file used only as a refresh notification coordinate. */
  watchPath(teamName: string): string;
}

export interface TaskGraphPaneServiceOptions {
  taskReadAdapterFactory: BeadsTaskAdapterFactory;
  graphControlSource?: TaskGraphControlReadSource;
  cliPath?: string;
  host?: HerdrCliTaskGraphPaneHost;
}

/** Bind read-only Task authority and event freshness to one process-owned pane. */
export class TaskGraphPaneService {
  private readonly controller: TaskGraphPaneController;
  private watchers: fs.FSWatcher[] = [];
  private authorityWatcher?: fs.FSWatcher;
  private debounce?: ReturnType<typeof setTimeout>;
  private current?: { teamName: string; actor: string };
  private refreshInFlight = false;
  private refreshAgain = false;

  constructor(private readonly options: TaskGraphPaneServiceOptions) {
    this.controller = new TaskGraphPaneController(
      options.host ?? new HerdrCliTaskGraphPaneHost(),
      options.cliPath ?? path.resolve(__dirname, "../cli/task-graph-pane.ts"),
    );
  }

  private async source(teamName: string, actor: string): Promise<TaskGraphViewSource> {
    const activity = readTaskActivity(teamName);
    const graphControl = this.options.graphControlSource?.hasGraph(teamName)
      ? await this.options.graphControlSource.trace(teamName)
      : undefined;
    if (graphControl) {
      return projectGraphControlTaskGraphViewSource({ teamName, trace: graphControl, activity });
    }
    const tasks = await this.options.taskReadAdapterFactory(teamName, actor).listCurrentTasks();
    // The durable graph-control adapter is not integrated yet. Keep this
    // fallback explicit: legacy closed records are unresolved completion, not
    // graph-control goal achievement.
    return projectTaskGraphViewSource({ teamName, tasks, activity });
  }

  private notifyRefresh(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refresh(), 25);
    this.debounce.unref?.();
  }

  private async refresh(): Promise<void> {
    if (!this.current || !this.controller.isOpen) return;
    if (this.refreshInFlight) { this.refreshAgain = true; return; }
    this.refreshInFlight = true;
    try {
      do {
        this.refreshAgain = false;
        const source = await this.source(this.current.teamName, this.current.actor);
        this.controller.update(source);
      } while (this.refreshAgain);
    } finally {
      this.refreshInFlight = false;
    }
  }

  private nearestExistingDirectory(input: string): string | undefined {
    let candidate = path.resolve(input);
    while (true) {
      try {
        if (fs.statSync(candidate).isDirectory()) return candidate;
      } catch {
        // A missing authority path is normal before the first graph apply.
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) return undefined;
      candidate = parent;
    }
  }

  private watchFile(
    target: string,
    createDirectory: boolean,
    onBroadEvent?: () => void,
  ): fs.FSWatcher | undefined {
    const targetDirectory = path.resolve(path.dirname(target));
    if (createDirectory) fs.mkdirSync(targetDirectory, { recursive: true });
    const directory = createDirectory
      ? targetDirectory
      : this.nearestExistingDirectory(targetDirectory);
    if (!directory) return undefined;
    const watchesExactParent = directory === targetDirectory;
    const watcher = fs.watch(directory, (_event, filename) => {
      if (watchesExactParent && filename && filename.toString() !== path.basename(target)) return;
      this.notifyRefresh();
      // A broad ancestor event can mean that the authority parent appeared.
      // Move the watch closer without ever creating authority storage.
      if (!watchesExactParent) onBroadEvent?.();
    });
    watcher.on("error", () => this.notifyRefresh());
    return watcher;
  }

  private watchAuthority(teamName: string): void {
    const authority = this.options.graphControlSource?.watchPath(teamName);
    if (!authority) return;
    const next = this.watchFile(authority, false, () => {
      if (this.current?.teamName === teamName) this.watchAuthority(teamName);
    });
    const previous = this.authorityWatcher;
    this.authorityWatcher = next;
    previous?.close();
  }

  private watch(teamName: string): void {
    this.stopWatch();
    const eventWatcher = this.watchFile(teamEventJournalPath(teamName), true);
    if (eventWatcher) this.watchers.push(eventWatcher);
    this.watchAuthority(teamName);
  }

  private stopWatch(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = undefined;
    this.authorityWatcher?.close();
    this.authorityWatcher = undefined;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  async toggle(input: {
    teamName: string;
    actor: string;
    cwd: string;
    limitText?: string;
  }): Promise<TaskGraphPaneToggleResult> {
    if (this.controller.isOpen) {
      const paneId = this.controller.ownedPaneId!;
      this.stopWatch();
      this.current = undefined;
      if (!this.controller.forgetMissing()) {
        this.controller.close();
        return { kind: "closed", paneId };
      }
    }
    const limit: TaskGraphRecentLimit = parseTaskGraphLimit(input.limitText ?? "");
    const source = await this.source(input.teamName, input.actor);
    const result = this.controller.toggle({
      origin: taskGraphPaneOriginFromEnvironment(input.cwd),
      source,
      limit,
    });
    this.current = { teamName: input.teamName, actor: input.actor };
    this.watch(input.teamName);
    return result;
  }

  shutdown(): void {
    this.stopWatch();
    this.current = undefined;
    this.controller.shutdown();
  }
}
