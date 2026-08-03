# New model surface local-preview continuation

Date: 2026-08-02
Status: active integration handoff before local installation

## Owner direction now in force

Work quickly in small slices. Do not run repeated broad reviews or test suites.
Use one focused verification and one real workflow before local use; keep the
full independent review and broad test gate for public delivery.

Use `openai-codex/gpt-5.6-luna` for real model runs. Model compaction is fully
orthogonal to Team, Task, event, and hidden observation state.

The owner rejected a separate isolated preview extension. Modify the real
`extensions/index.ts` directly on the side branch, use version control as the
preview switch, commit it, then install that branch into Pi for local use.

## Branch and commits

Child repository branch: `preview/new-model-tool-surface`.

Relevant child commits through the durable foundation:

- `76bbc63` real-Pi three-tool canary
- `63c7c4a` assigned Task journey
- `c8aa50b` batch Task read
- `afb53ff` atomic Task update
- `a4f9b6b` branch-safe snapshot and updates
- `18b2b7d` durable preview authority foundations

Parent HyperCarrier pointer/architecture commit for the foundation:
`b9ee187`.

## Proven candidate surface

Real Luna canaries passed named-JSON journeys for:

- `team_create`
- `ensure_worker`
- batch `task_create`
- batch `task_read`
- atomic candidate `task_update`
- `team_sync({view:"snapshot"|"updates"})`

The latest in-memory real-Pi journey created Team/Worker/Task, established a
snapshot baseline, read and updated the Task, and received the grouped Task
delta through updates. Hidden observation state uses Session branch ancestry,
Team epoch, exact result identity, and provider-input acknowledgement.
Cancellation and snapshot-required are distinct semantic results. Compaction
has no hook or state effect.

## Durable foundations completed

PiTeams Team: `pi-team-bright-new-surface-e2e`.

Completed Tasks:

- `58d` durable Team preview coordinates
- `pqh` candidate Task projection over Beads
- `4tw` reusable Worker launch bridge

Implemented foundations:

- fresh Teams persist opaque epoch IDs;
- stable logical Worker `{name,scope}` persists separately from Membership;
- exact lead Session resolution is in Team authority;
- hidden observation projection is locked, atomic, branch/epoch/Session keyed;
- candidate Task create/read uses the existing Beads authority and explicit
  versioned candidate goal/current-context metadata;
- structured Task event evidence has committed cursor/time/actor/kind/text;
- candidate leader Task update fails closed with a typed gap because Beads 1.1
  does not prove external-writer CAS plus durable Task-scoped replay;
- existing Worker launch/recovery/compensation code is extracted into
  `src/utils/worker-launch-bridge.ts` and preserves no-readiness semantics;
- typecheck passed after parallel foundation work completed;
- current context and canonical Structurizr source were updated for Team epoch,
  logical Worker authority, and derived branch-position persistence.

Architecture impact for this foundation is `changed`; no new component or
deployment boundary was added.

## Active integration Task

Task `pi-team-bright-new-surface-e2e-nks`, assigned to `journey-implementer`, is
open. Its latest version after the owner simplification is
`beads_d73a2aea34d3ea3e44a0d62e4b3ad12dfd34e54de70146192f0158247590dd8c`.

Latest contract:

- modify the real main `extensions/index.ts` on
  `preview/new-model-tool-surface`;
- do not create a second preview extension or runner;
- register one role-correct surface per process, with no duplicate tool names;
- unbound/bound leaders receive the new six-tool surface;
- preview-launched Workers can temporarily keep the current Worker Task surface
  over the same Team/Beads authority;
- mark preview Workers so ordinary `task_update` append-note/status writes also
  refresh existing candidate current-context metadata and structured evidence;
- default non-preview behavior must remain unchanged;
- reuse Team, Membership, Beads, events, hidden-observation, and Worker launch
  authorities; create no parallel store;
- run one focused check and one real two-Session workflow only;
- commit the integrated side branch, then install it locally into Pi.

The real workflow must prove two distinct Pi Sessions, one Team epoch and Beads
authority, one real Worker carrier, one assigned Task, one Worker-produced
mutation, and one leader update observation without false readiness.

## Shared working-tree caution

Unrelated Worker-resource work was present before this project and must not be
overwritten or accidentally claimed:

- `extensions/index.ts` had pre-existing edits;
- `src/utils/ergonomic-tool-contract.test.ts`;
- `docs/decisions/0008-worker-resource-projection.md`;
- `src/utils/worker-resource-extension.contract.test.ts`;
- `src/utils/worker-resource-projection.test.ts`;
- `src/utils/worker-resource-projection.ts`.

The launch extraction also edits `extensions/index.ts`, so preserve and separate
those unrelated changes when committing. The durable authority/Task foundation
is already committed at `18b2b7d`; launch bridge wiring and final integration
remain in the working tree.

## Immediate continuation

1. Use `team_sync` on Task `nks`; do not stop the Team.
2. Ensure `journey-implementer` starts the updated direct-main-extension Task.
3. Review only material integration defects; avoid another broad review round.
4. Run one focused typecheck/check and one real two-Session workflow.
5. Commit only the new-surface integration on
   `preview/new-model-tool-surface`, preserving unrelated files.
6. Update the parent submodule pointer if needed.
7. Install the side branch into Pi and run a local smoke session.
8. Notify the owner immediately when the local-use milestone is reached.
