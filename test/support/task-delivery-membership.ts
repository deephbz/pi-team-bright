import { DurableTaskChangeDeliveryMembership } from "../../src/adapters/durable-task-change-delivery-membership";

/** Test composition uses the same durable Membership port as production. */
export const taskDeliveryMembership = new DurableTaskChangeDeliveryMembership();
