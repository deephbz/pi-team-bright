import { GraphControlRefusal } from "./graph-control";

export const UNSUPPORTED_BEADS_TEAM = "This Team keeps its Tasks in Beads. PTB 0.24 does not support it. The data stays in .beads/.";

/** Stored authority cannot be decoded or recovered; distinct from invalid graph input. */
export class GraphSnapshotCorruption extends GraphControlRefusal {
  constructor(message: string) {
    super("invalid_graph", message);
    this.name = "GraphSnapshotCorruption";
  }
}

/** Unsupported stores cannot recover through delivery retry. */
export class UnsupportedBeadsTeamError extends GraphSnapshotCorruption {
  constructor() {
    super(UNSUPPORTED_BEADS_TEAM);
    this.name = "UnsupportedBeadsTeamError";
  }
}
