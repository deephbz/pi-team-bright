import type { BeadsAuthorityFingerprint } from "../team-authority/contracts";
import type { TaskAuthorityRecordEnvelope } from "../utils/beads";
import { BeadsTaskStore } from "../utils/beads";
import type { TaskAuthorityBinding, TaskAuthorityReadPort, TaskAuthorityReadTeamPort } from "../task-authority/contracts";
import { withSemanticTrace } from "../utils/trace";

/** Durable Team-backed Task read implementation. */
export class DurableTaskAuthorityRead implements TaskAuthorityReadPort<TaskAuthorityRecordEnvelope> {
  constructor(private readonly team: TaskAuthorityReadTeamPort) {}

  private async store(teamName: string): Promise<BeadsTaskStore> {
    const binding: TaskAuthorityBinding = await this.team.readBinding(teamName);
    return new BeadsTaskStore({
      teamName: binding.teamName,
      workspace: binding.workspace,
      authorityFingerprint: binding.authorityFingerprint as BeadsAuthorityFingerprint,
      requireExpectedVersion: false,
    });
  }

  async readTaskAuthorityRecordEnvelope(teamName: string, taskId: string): Promise<TaskAuthorityRecordEnvelope> {
    return withSemanticTrace("task_read", { teamName, taskId }, async () =>
      (await this.store(teamName)).readTaskAuthorityRecordEnvelope(taskId));
  }

  async readTaskAuthorityRecordEnvelopes(teamName: string, taskIds: readonly string[]): Promise<Array<TaskAuthorityRecordEnvelope | undefined>> {
    return withSemanticTrace("task_read_many", { teamName }, async () =>
      (await this.store(teamName)).readTaskAuthorityRecordEnvelopes(taskIds));
  }

  async listTaskIds(teamName: string): Promise<string[]> {
    return withSemanticTrace("task_list", { teamName }, async () =>
      (await this.store(teamName)).list()).then((tasks) => tasks.map((task) => task.id));
  }
}
