# Task goal 1000 observer review

Date: 2026-08-03

Scope: independent observer review only. The owner proposes raising the public
`task_create` Task `goal` maximum from 160 to 1,000 TypeBox string-length
units in the prepared `0.17.0-rc.3` release. No implementation occurred.

## Evidence

The leader created Team `task-goal-1000-observer-review`, took its required
initial snapshot, ensured the stable `product-observer` and `systems-observer`
Workers, and assigned one review Task to each. Both assigned Tasks are closed:
`task-goal-1000-observer-review-dlg` and
`task-goal-1000-observer-review-e9d`.

The normal updates projection returned
`structured_task_event_evidence_absent`, then later `Invalid semantic result`.
The closed Task records in the authoritative Team Beads workspace preserve the
complete observer outputs. This journal records their conclusions; it is not a
replacement for that raw evidence.

## Meaningful agreement

Both observers agree that 1,000 must be one coherent public Task-card
contract, not an input-only validation change. The product observer says the
larger field is valid only when `goal` is the durable, self-contained work
contract. The systems observer identifies the present split: the catalog
accepts and carries Task goals, while `result-projection.ts` independently
limits returned Task cards to 160 and will fail closed for longer values.

Both identify the same product risk. A 1,000-unit goal increases model-visible
Task-card size and can blur `goal` with the separate 2,000-unit
`current_context`. Both require boundary tests at 160, 161, 1,000, and 1,001.
Both require checks through creation and returned Task-card projections. Neither
finds a topology change. The systems observer explicitly classifies architecture
impact as `none`: no authority, component, dependency, trust boundary, flow,
or deployment change occurs. Keep the Structurizr DSL unchanged.

## Meaningful dissent or distinct emphasis

There is no material dissent. The product observer asks the owner to decide the
semantic role first: concise decision statement or complete durable contract
for a replacement Worker. The systems observer asks whether the 1,000-unit cap
covers every candidate Task-card read and projection, including Worker reads,
rather than `task_create` input alone. These are complementary scope questions,
not opposing conclusions.

## Focused next test

After an authorized implementation, test 1,000 acceptance and 1,001 refusal
at the input schema. Assemble 1,000-unit Task cards for create/read, snapshot,
update conflict, and link conflict. Then measure representative multi-Task
model and TUI payload size and scan quality. Regenerate only derived review
output from its source. Leave historical canary receipts unchanged.
