# PTB state machines: experiment plan

Status: experiment on branch `sm-experiment` from `0f39e06` (0.24.0-rc.4).
Owner decisions (2026-10-16): the machine is the production code (option b);
pick subsystems by benefit/cost; keep the on-disk format; plain TypeScript
reducers plus a vitest explorer, no new library; merge after the branch is
stable.

## Question

Does an explicit state machine per lifecycle entity improve PTB architecture,
design and behavior enough to justify its cost? The deliverable is evidence:
code, exhaustive exploration results, simulator conformance results and
measurements.

## Shape of one machine

```
durable record --parse--> State (discriminated union)
State x Event --transition()--> { state, effects } | Refusal   (pure, total)
shell: lock -> read -> transition -> write -> run effects
```

- `parse` is total over every record that any PTB version wrote. Unknown or
  contradictory shapes become an explicit `invalid` state.
- `transition` is the only writer of the lifecycle fields. Generic patches of
  those fields are deleted.
- Each machine declares its invariants as predicates over `State`.

## Three checks per machine

1. Exhaustive explorer: breadth-first search over all states reachable from
   the initial states with a bounded event alphabet. Every invariant holds in
   every reachable state. Every non-terminal state has a path to a terminal or
   stable state (no dead ends).
2. Simulator conformance: project every durable snapshot in a simulator
   history onto the machine. Each consecutive pair must be an allowed
   transition. A non-conforming trace is a defect in the code or the model.
3. Time travel: print the machine state at every history step of a simulator
   trace, so a failure can be read as a state timeline.

## Candidate machines (ranked after inventory)

1. Membership carrier: prepared -> bound -> inactive, with the launch fence
   (requested/started/refused/unknown, prior generation). Recent defects:
   E1, launch_stalled, geometry-launch-wedge. Writers today: `addMember`,
   `updateMembership` patches, `bindMemberSession`, `completeLaunch`, the
   decision override in `WorkerLaunchBridge.claim`.
2. Task delivery record and owner-transition intent
   (`src/utils/task-delivery.ts`, 1039 lines).
3. Recipient delivery engine slots (`recipient-delivery-lifecycle.ts`).
4. Task attempt (`graph-control.ts`): already explicit; low expected yield.

## Measures

- production lines added and deleted; number of lifecycle writers before and after
- states, transitions, reachable states and invariants per machine
- defects found by the explorer or conformance, each with a regression
- gates: typecheck, `npm test`, exhaustive simulator files, campaigns
- startup time (must not regress)

## Constraints

- No on-disk format change without a strong reason and owner approval.
- Old durable records must parse. Mixed versions are part of the contract.
- No push. Commits stay on `sm-experiment` until the owner approves a merge.
