import { readConfig } from "../utils/teams";
import type { TaskDeliveryStoppedEpochPort } from "../utils/task-delivery-migration";

/** Durable Team authority adapter for the stopped-epoch migration guard. */
export class DurableTaskDeliveryStoppedEpoch implements TaskDeliveryStoppedEpochPort {
  async isStoppedEpoch(teamName: string): Promise<boolean> {
    const config = await readConfig(teamName).catch(() => undefined);
    return !config?.members.some((member) => member.isActive !== false);
  }
}
