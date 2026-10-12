import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hostEnv } from "../src/env/host-env";
import { TEAM_UPDATE_TYPE, type BranchEntry, type ObservationStamp } from "../src/coordination/branch-observation";
import { projectModelToolTuiMessage } from "../src/model-tool-contract/tui-projection";
import { projectToolResult } from "../src/model-tool-contract/result-projection";
import type { PiTeamBrightTuiMessage } from "../src/model-tool-contract/tui-message-projection";
export { TEAM_UPDATE_TYPE };

export function projectTeamUpdateMessage(message: { content?: unknown }): PiTeamBrightTuiMessage | undefined {
  try {
    const result = JSON.parse(message.content as string);
    return { ...projectModelToolTuiMessage("team_sync", result, result), source: "Automatic", provenance: "tool-result" };
  } catch { return undefined; }
}
export interface TeamUpdateDependencies {
  pi: Pick<ExtensionAPI, "sendMessage">;
  current: () => { sessionId: string; sessionFile: string; branch: BranchEntry[] } | undefined;
  executeNow: (sessionId: string, view: "updates" | "snapshot", signal: AbortSignal, toolCallId: string) => Promise<unknown>;
  readTeamBinding: (team: string, file: string) => Promise<{ epochId: string; membershipId: string } | undefined>;
  pendingObservation: (sessionId: string) => { toolCallId: string; observation?: ObservationStamp } | undefined;
  setBranchEntries: (sessionId: string, entries: BranchEntry[]) => void;
  clearPending: (sessionId: string, toolCallId: string) => void;
  isBusy: (ownToolCallId?: string) => boolean;
  notify: (message: string, level?: "info" | "warning" | "error") => void;
}
/** One idle publisher per Session adapter. Persistence alone commits presentation. */
export class TeamUpdateController {
  private running = false;
  private generation = 0;
  private active?: { session: string; call: string; abort: AbortController };
  constructor(private readonly dependencies: TeamUpdateDependencies) {}
  get isRunning(): boolean { return this.running; }
  invalidate(): void {
    this.generation++;
    if (this.active) {
      this.active.abort.abort();
      this.dependencies.clearPending(this.active.session, this.active.call);
      this.active = undefined;
    }
  }
  async execute(team: string, source: "command" | "automatic", view: "snapshot" | "updates" = "updates"): Promise<"published" | "quiet" | "skipped" | "failed"> {
    const context = this.dependencies.current();
    if (!context || this.running || this.dependencies.isBusy()) return "skipped";
    const start = { ...context, branch: [...context.branch] };
    this.running = true;
    const generation = this.generation;
    const call = `team-update-${hostEnv().random.uuid()}`;
    const abort = new AbortController();
    this.active = { session: start.sessionId, call, abort };
    const current = () => {
      const now = this.dependencies.current();
      return generation === this.generation && now?.sessionId === start.sessionId && now.sessionFile === start.sessionFile
        && JSON.stringify(now.branch.map(entry => entry.id)) === JSON.stringify(start.branch.map(entry => entry.id)) && !this.dependencies.isBusy(call);
    };
    let published = false;
    try {
      const binding = await this.dependencies.readTeamBinding(team, start.sessionFile);
      if (!binding || !current()) return "skipped";
      this.dependencies.setBranchEntries(start.sessionId, start.branch);
      const result: any = await this.dependencies.executeNow(start.sessionId, view, abort.signal, call);
      const latest = await this.dependencies.readTeamBinding(team, start.sessionFile);
      if (!current() || latest?.epochId !== binding.epochId || latest?.membershipId !== binding.membershipId) return "skipped";
      if (result?.kind === "quiet") {
        if (source === "command") this.dependencies.notify("No Team updates.");
        return "quiet";
      }
      if (!["snapshot", "updates"].includes(result?.kind)) return "failed";
      const pending = this.dependencies.pendingObservation(start.sessionId);
      const stamp = pending?.observation;
      if (pending?.toolCallId !== call || !stamp || stamp.team !== team || stamp.epoch !== binding.epochId || stamp.binding !== binding.membershipId) return "skipped";
      this.dependencies.pi.sendMessage({ customType: TEAM_UPDATE_TYPE, content: JSON.stringify(projectToolResult("team_sync", result)), display: true, details: stamp }, { triggerTurn: true, deliverAs: "followUp" });
      published = true;
      // sendMessage may queue. Only a native branch entry releases the page.
      const after = this.dependencies.current();
      if (after?.sessionId === start.sessionId && after.sessionFile === start.sessionFile) this.dependencies.setBranchEntries(start.sessionId, after.branch);
      return "published";
    } catch (error) {
      this.dependencies.notify(`Team synchronization failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      return "failed";
    } finally {
      if (!published) this.dependencies.clearPending(start.sessionId, call);
      this.running = false;
    }
  }
}
