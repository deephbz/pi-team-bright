# Semantic hardening continuation

Updated: 2026-08-10 during Trio continuation.

## Owner contract

Continue the full subsystem hardening project without stopping at a release
increment. Lead directly and use assigned Tasks for all Worker work. Keep the
Herdr watchdog active. Do not push, tag, publish, or run the reserved aggregate
until the full target is stable and the owner authorizes publication.

Preserve public tools, schemas, results, package exports, persisted records,
filenames, ordering, errors, timing, terminal behavior, and undocumented
observable behavior by default. A behavior change needs explicit evidence,
classification, replacement tests, and its own commit.

The full target remains Team authority, Task authority, Alert authority,
Coordination observation, Trio-facing projections, and the additive read-only
Membership observation component. Session, process, pane, delivery, locks,
files, timers, and traces are support mechanisms, not authorities.

## Current source state

Use only `the isolated Project worktree` on branch
`audit/semantic-hardening-behavior-inventory`. Do not use the original checkout.

Clean accepted baseline `c54dc25b34770b70afedffc7e87728da6376ee0f` now
precedes accepted Trio commit
`69c30acf5db23be8f656b2a6821b0ea032ae04cb` (`refactor: split Trio application
ports`). The accepted continuation chain is `b4bf6de`, `e50eb68`, `3b265ea`,
`cafdf2d`, `b3b2b22`, `c54dc25`, and `69c30ac`.

The accepted architecture is a `ModelToolJourneyPort` facade over four neutral
application contracts: Team, Task, Alert, and Coordination. Durable owners are
`durable-model-tool-team-application.ts`,
`durable-model-tool-task-application.ts`,
`durable-model-tool-alert-application.ts`, and
`durable-model-tool-coordination-application.ts`; bindings are in
`durable-model-tool-bindings.ts`. Opaque in-memory authority state and ports
replace the one-store fake. Compatibility wrappers remain thin.

Task and Alert authority commits precede Coordination publication. Publication
failure remains a partial outcome and does not roll back authority state. The
rejected nominal implementation attempts remain historical evidence.

No public behavior, schema, package export, persistence contract, or deployment
shape changed. The final aggregate remains reserved for one exact stable final
tree; do not run it during individual Task work.

## Active Team and Task state

The Trio Team work is accepted. Keep the Herdr watchdog active until final
Project completion. Design Tasks `semantic-hardening-trio-o6p` and
`semantic-hardening-trio-c76` are closed; nominal attempts
`semantic-hardening-trio-fbp` and `semantic-hardening-trio-tey` remain rejected
history; durable slice `semantic-hardening-trio-8bs` is accepted. The prior
in-memory rewrite and Trio acceptance gates are no longer active blockers.

## Next actions

1. Start the additive Membership observation decoder boundary.
2. Preserve the accepted neutral four-port Trio contracts, opaque-state fakes,
   thin wrappers, and Task/Alert partial-failure semantics.
3. Stabilize one exact final tree before the one reserved aggregate.
4. Refresh final acceptance artifacts, run the required privacy scan, and get
   watchdog completion review before any release operation.

## Proof limits

Current evidence is deterministic local source and test evidence. It does not
prove real Pi persistence, external Beads/Dolt contention, cross-process forks,
native watcher delivery, OS scheduling, concurrent external writers, or
terminal pixels.
