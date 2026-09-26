# Runtime and publication hardening evidence

Base: `0d4389d98cf5044bdd67b07fed82e01c304b6e9c`.
Scope: existing process generation, graph publication, retirement, and Task delivery behavior. Architecture impact: none.

## Findings

- A new process generation inherited `settled`, `ready`, and heartbeat state from the previous process under the same Membership. The new generation could appear settled before Pi reported its run state. A focused test failed on the base with `settled` present. The status writer now starts a fresh generation record when Membership, PID, or start time changes. Same-generation updates still merge.
- A bound Worker runtime hook checked its Session, then wrote status without holding the Membership mutation lease. Membership replacement could interleave between those steps. A boundary test failed on the base because the write had no lease. The hook now holds the exact Session lease through the runtime write.
- A graph command could commit before Task event publication. An exact replay skipped publication and left the event absent. The graph adapter now exposes the committed operation boundary. Replay checks the event evidence for the exact Task version current at the replay check and repairs a missing event. A Task version already superseded at that check is not backfilled as a late historical event.
- A stale graph replay combined an old operation ID and graph version with the latest graph sequence and Task coordinates. Retirement rejected that mixed claim. The orchestration now uses the exact operation boundary and does not retire on a replay whose authority sequence is no longer current.
- A graph replacement could commit while retirement failed. The prior delivery fence then admitted an old Task version. Delivery currentness now reads the committed graph authority snapshot. Normal and resumed sends recheck current records inside the exact recipient lease just before presentation. A missing or malformed graph snapshot after graph retirement fails closed.
- A corrupt persisted graph snapshot produced an `invalid_graph` refusal. That blamed a Task command for an authority read failure. Snapshot corruption now has a distinct adapter error and maps to `task_authority_unavailable`. Invalid graph input still returns `invalid_graph`. A focused regression failed before this mapping and passed afterward.
- A structurally loaded snapshot could contain a forged replay receipt. The controller detected it only when the exact operation replayed. The adapter now classifies that replay-time corruption as unavailable. A parseable snapshot with malformed collections also reaches the same recovery classification. The explicit removed-model-field migration refusal remains unchanged.

## Checks and limits

The adversarial publication-window tests reproduced missing publication, stale replay, and failed retirement against the base. The runtime generation and Session-lease regressions also failed on the base. After the repairs, typecheck and 86 focused tests across seven adversarial, graph replacement, Task delivery, runtime, Session lifecycle, and liveness files passed. The graph replacement tests now use committed graph authority for the four version-fencing traces.

The currentness check observes one atomic graph snapshot. A graph commit can still race after the final check and before external Session presentation. Task mutation version checks reject stale work. Concurrent exact replays can append duplicate Team events because event lookup and append are separate; the repair is at least once. An older committed Task event can appear late in the raw journal after a newer event. Current Task-change observation filters events by exact current Task version. A superseded operation with a missing historical event remains an audit gap. Full package and public-tool evidence belong to the final integrated verification gate.

The later corruption diagnostic change passed typecheck and 73 focused tests across the graph replacement, publication-window, Session boundary, runtime, and Task delivery files. A controlled overlap test showed that the raw journal can end with an older event while the actual Coordination observation keeps the newer current Task version.

The lazy forged-receipt and malformed-collection refinements passed typecheck and 28 focused tests across graph replacement, publication-window, and graph-control hardening files.

The final full suite exposed a cross-adapter regression: exact-version event lookup made a legacy Beads graph-create replay append duplicate creation events after those Tasks had advanced. The recovery query now distinguishes Task-level operation evidence from exact Task-version evidence; graph replay asks for the latter. The direct two-scope test failed under the global exact check and now passes. The real Beads DAG delivery E2E passed both tests, including its unchanged cursor assertion after replay. Typecheck and 14 direct/graph focused tests also passed.
