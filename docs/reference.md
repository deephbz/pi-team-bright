# Pi Team Bright contract source map

Pi Team Bright is in hardening. Exact contract truth therefore lives in executable
types, schemas, implementations, and tests rather than a second prose copy.
This page is a one-hop map to those sources; it is intentionally not an
exhaustive parameter reference.

## Public agent interface

- The DAG-native leader surface is the nine-tool catalog in
  [`src/model-tool-contract/catalog.ts`](../src/model-tool-contract/catalog.ts),
  registered by [`pi-registration.ts`](../src/model-tool-contract/pi-registration.ts).
  [`ProjectedTool`](../src/model-tool-contract/result-projection.ts)
  and [`tui-projection.ts`](../src/model-tool-contract/tui-projection.ts) own
  the model result and TUI projection boundaries.
- [`extensions/index.ts`](../extensions/index.ts) owns each tool's TypeBox
  parameter schema, agent-facing description, authorization, execution, and
  semantic result content.
- [`skills/pi-team-bright/SKILL.md`](../skills/pi-team-bright/SKILL.md) is operating
  procedure, not another schema. Pi presents the executable tool schemas to the
  agent directly.
- [`src/utils/tool-surface.test.ts`](https://github.com/deephbz/pi-team-bright/blob/main/src/utils/tool-surface.test.ts)
  verifies the nine-tool selection and the irreducible Task, Worker, sync, and
  Alert distinctions.

## Read-only status diagnosis

- [`src/utils/team-status.ts`](../src/utils/team-status.ts) owns the `pi-teams-status/1` read-only TeamConfig/Beads diagnostic model and human projection.
- [`extensions/index.ts`](../extensions/index.ts) registers `/pi-team-bright [status|help]`; it has no `/pi-teams` alias.

## Result and projection contract

- [`result-projection.ts`](../src/model-tool-contract/result-projection.ts)
  validates raw semantic results, derives the schema-checked model projection,
  and assembles raw machine details with serialized model content.
- [`tui-projection.ts`](../src/model-tool-contract/tui-projection.ts) produces
  exhaustive collapsed and expanded allowlisted human projections.
- QA retains raw semantic details, model content, and both TUI modes. Operational
  trace records remain payload-free.

## Domain and authority

- [`src/utils/models.ts`](../src/utils/models.ts) owns Team, Membership, Task,
  Alert, delivery, runtime, and event types.
- [`@hypercarrier/pi-team-bright/observation`](../src/public/observation.ts) exports the one
  read-only `pi-teams-observation/1` projector, canonical types, and JSON
  Schema; its authority and privacy boundary are enforced by that executable
  contract.
- [`src/utils/teams.ts`](../src/utils/teams.ts) owns Team configuration and
  current Membership generations.
- [`src/utils/automatic-summary-policy.ts`](../src/utils/automatic-summary-policy.ts)
  answers only Rarebit's versioned automatic-Summary inhibition query, using
  the exact current teammate Membership-generation and durable-Session resolver
  in `teams.ts`; it exposes no general policy registry.
- [`src/task-authority/task-domain.ts`](../src/task-authority/task-domain.ts)
  owns the legacy/graph card boundary and bounded card schema.
  [`task-version-ref.ts`](../src/task-authority/task-version-ref.ts) owns opaque
  public TaskVersionRef values.
- [`src/task-authority/graph-control.ts`](../src/task-authority/graph-control.ts)
  owns graph revisions, derived state, immutable Attempts, bounded failure
  traversal, replay, recovery, and trace output. Its TypeBox public contract is
  [`graph-control-schemas.ts`](../src/task-authority/graph-control-schemas.ts).
  [`durable-graph-task-authority.ts`](../src/adapters/durable-graph-task-authority.ts)
  owns the Team-scoped snapshot, while
  [`graph-orchestration.ts`](../src/task-authority/graph-orchestration.ts) owns
  publication and ready delivery. The older [`dag.ts`](../src/task-authority/dag.ts),
  [`mechanical-dispatch.ts`](../src/task-authority/mechanical-dispatch.ts), and
  [`beads-graph-adapter.ts`](../src/task-authority/beads-graph-adapter.ts) remain
  the legacy Beads graph path.
- [`src/model-tool-contract/beads-task-adapter.ts`](../src/model-tool-contract/beads-task-adapter.ts)
  and [`beads-authority-adapter.ts`](../src/model-tool-contract/beads-authority-adapter.ts)
  form the Beads adapter boundary for native records, metadata, revisions, and
  mutations. [`legacy-graph-task-transition-adapter.ts`](../src/model-tool-contract/legacy-graph-task-transition-adapter.ts)
  maps graph-shaped Worker commands to that legacy authority before first graph
  apply and refuses meanings that Beads cannot preserve.
  [`src/utils/tasks.ts`](../src/utils/tasks.ts) exposes only semantic Task
  operations; the delivery stopped-epoch migration is
  [`src/utils/task-delivery-migration.ts`](../src/utils/task-delivery-migration.ts).
- [`src/coordination/event-journal.ts`](../src/coordination/event-journal.ts) owns cursor ordering,
  waits, filters, bounded pages, and snapshot continuations.
- [`src/utils/worker-resource-projection.ts`](../src/utils/worker-resource-projection.ts)
  owns Worker-only Pi settings parsing plus context and model-tool projection;
  its focused executable anchors are `worker-resource-projection.test.ts` and
  `worker-resource-extension.contract.test.ts`.
- [`src/utils/worker-startup-observation.ts`](../src/utils/worker-startup-observation.ts)
  owns the bounded exact-Membership startup observation used after a new or
  recovered carrier launch; `session_bound` generation evidence correlates the
  exact runtime process tuple, and it is not a readiness or progress protocol.
- [`src/utils/alerts.ts`](../src/utils/alerts.ts) owns typed exceptional Alert
  acceptance and event publication.
- [`src/adapters/terminal-registry.ts`](../src/adapters/terminal-registry.ts)
  selects the terminal lifecycle adapter; adapter implementations own their
  platform capabilities and stop evidence.

## Verification and reproduction

- `npm run typecheck` checks the executable type contract.
- `npm test` runs only the fast deterministic lane; `test:exhaustive-only` is
  its CI complement, `test:full` runs all tests, `test:external` is the real
  Beads/Dolt diagnostic subset, `qa:agent-surface` is the artifact lane,
  `qa:tool-results` is receipt QA, and `test:lanes` checks closure.
- `npm run verify:package` packs the public artifact and probes the scoped
  observation import from a clean temporary project.

For human setup and a minimal example, start at the [repository README](../README.md).
For current stage, decisions, constraints, and next steps, read the
[evergreen context](current/README.md).


## Test lanes

`npm test` is fast and non-exhaustive; `test:exhaustive-only` is its CI complement, `test:full` runs everything, and `test:lanes` verifies closure. Use `test:external` for real Beads/Dolt diagnostics, `qa:agent-surface` for the agent-surface artifact, and `qa:tool-results` for receipt QA. CI on Node 22/24 runs fast plus the complement and package verification; publishing on Node 24 runs full plus package verification.
