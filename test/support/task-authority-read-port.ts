import {
  createReadOnlyBeadsTaskAdapterFactory,
  type BeadsTaskAdapterFactory,
} from "../../src/model-tool-contract/beads-task-adapter";
import type { TaskAuthorityRecordEnvelope } from "../../src/utils/beads";
import type { TaskAuthorityReadPort } from "../../src/task-authority/contracts";

/** Build an explicit read-only Task adapter factory for tests and QA. */
export function taskReadAdapterFactory(readPort: TaskAuthorityReadPort<TaskAuthorityRecordEnvelope>): BeadsTaskAdapterFactory {
  return createReadOnlyBeadsTaskAdapterFactory(readPort);
}
