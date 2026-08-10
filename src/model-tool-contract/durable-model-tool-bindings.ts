import * as teams from "../utils/teams";
import type { TeamConfig } from "../team-authority/contracts";
import type { ExactLeaderSessionId, ModelToolLeaderLaunchContext } from "./model-tool-contracts";

type BoundTeam = { teamName: string; config: TeamConfig; sessionFile: string };

/** Exact Session and launch-context binding. It owns no authority state. */
export class DurableModelToolBindings {
  private readonly sessionFiles = new Map<ExactLeaderSessionId, string>();
  private readonly launchContexts = new Map<ExactLeaderSessionId, ModelToolLeaderLaunchContext>();
  setLeaderSessionFile(id: ExactLeaderSessionId, file: string): void { this.sessionFiles.set(id, file); }
  setLeaderLaunchContext(id: ExactLeaderSessionId, context: ModelToolLeaderLaunchContext): void { this.launchContexts.set(id, context); }
  sessionFile(id: ExactLeaderSessionId): string | undefined { return this.sessionFiles.get(id); }
  launchContext(id: ExactLeaderSessionId): ModelToolLeaderLaunchContext | undefined { return this.launchContexts.get(id); }
  async boundTeam(id: ExactLeaderSessionId): Promise<BoundTeam | undefined> {
    const sessionFile = this.sessionFile(id);
    if (!sessionFile) return undefined;
    const binding = await teams.resolveCurrentLeadSessionBinding(sessionFile);
    if (binding.status !== "bound") return undefined;
    return { teamName: binding.teamName, config: await teams.readConfig(binding.teamName), sessionFile };
  }
}
