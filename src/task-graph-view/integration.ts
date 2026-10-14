import { hostEnv, type TimerHandle, type HostWatcher } from "../env/host-env";
import fs from "node:fs";
import path from "node:path";
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
  graphControlSource: TaskGraphControlReadSource;
  cliPath?: string;
  host?: HerdrCliTaskGraphPaneHost;
}

/** Bind read-only Task authority and event freshness to one process-owned pane. */
export class TaskGraphPaneService {
  private readonly controller: TaskGraphPaneController;
  private watchers: HostWatcher[] = [];
  private authorityWatcher?: HostWatcher;
  private debounce?: TimerHandle;
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
    const trace = await this.options.graphControlSource.trace(teamName);
    return projectGraphControlTaskGraphViewSource({ teamName, trace, activity });
  }

  private notifyRefresh(): void {
    if (this.debounce) hostEnv().clock.clearTimeout(this.debounce);
    this.debounce = hostEnv().clock.setTimeout(() => void this.refresh(), 25);
    if ("unref" in this.debounce) this.debounce.unref();
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
        // Watch the nearest existing parent after authority storage moves.
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
  ): HostWatcher | undefined {
    const targetDirectory = path.resolve(path.dirname(target));
    if (createDirectory) fs.mkdirSync(targetDirectory, { recursive: true });
    const directory = createDirectory
      ? targetDirectory
      : this.nearestExistingDirectory(targetDirectory);
    if (!directory) return undefined;
    const watchesExactParent = directory === targetDirectory;
    const watcher = hostEnv().watch.watchDirectory(directory, (filename) => {
      if (watchesExactParent && filename && filename.toString() !== path.basename(target)) return;
      this.notifyRefresh();
      // A broad ancestor event can mean that the authority parent appeared.
      // Move the watch closer without ever creating authority storage.
      if (!watchesExactParent) onBroadEvent?.();
    });
    watcher.onError(() => this.notifyRefresh());
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
    if (this.debounce) hostEnv().clock.clearTimeout(this.debounce);
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
