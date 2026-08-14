# Decision 0012: Reduce Worker startup without weakening admission

Date: 2026-08-14
Status: accepted
Architecture impact: none

## Decision

Keep the model-facing tool contract and visible Worker semantics unchanged.
Reduce only repeated or artificial work inside Worker admission.

Use these rules:

1. Reuse an exact, current, already-bound Worker.
2. Validate configured Worker defaults with Pi's invocation-local
   `ModelRegistry`.
3. Ask Herdr for positive actuation acceptance when its public client supports
   that operation.
4. Use the legacy Herdr ready wait only after its exact unsupported-option
   response.
5. Keep exact current Membership, Pi Session, PID, and process-generation
   binding as the admission point.
6. Do not run leader Task reconciliation inside `ensure_worker`.
7. Let Worker Session start, Task transitions, and periodic recovery own ready
   delivery.
8. Give an accepted start a 6,000 ms binding failure-detector budget. Keep
   3,000 ms for ordinary and legacy-ready starts. An explicit environment
   override still wins.
9. Keep phase traces for preparation, actuation, fresh Pi bootstrap, exact
   binding, and Task delivery.

Do not add a production compile cache, generic warm carrier pool, reusable
productive Pi Session, resource-discovery exclusion, or weaker admission test.

## Startup sequence

```text
ensure_worker
  |
  +-- exact bound Worker ------------------------------> return
  |
  `-- new Worker
        |
        +-- Membership preparation
        +-- configured-model validation
        +-- terminal actuation
        +-- fresh Pi bootstrap
        +-- exact Membership and Session binding
        `-- Task presentation
```

Herdr acceptance and Worker admission are different events:

```text
Pi Team Bright       Herdr                 Worker Pi
      |                 |                       |
      |-- start ------->|                       |
      |<-- accepted ----|-- create process ---->|
      |                                         |
      |-- observe exact Membership and Session->|
      |<------------- binding proved -----------|
```

Acceptance proves that Herdr accepted one exact external action. It does not
prove that the Worker is ready. The binding timeout is a failure detector. A
successful start returns when binding appears and does not wait for the full
budget.

## Evidence

An already-bound Worker measured 31 ms p50 and 33 ms p95 at the model-tool
boundary. Its launch bridge measured 13 ms p50 and 16 ms p95.

Configured-model validation changed from a separate Pi CLI stage to the
invocation-local registry:

```text
CLI p95       4,464.195 ms
registry p95      0.883 ms
saving        4,463.312 ms, or 99.98%
```

The registry snapshot is ephemeral. It uses the running Pi libraries and does
not persist a second model catalog.

A protocol-17 Herdr backport measured accepted actuation against the legacy
interactive-ready wait:

```text
legacy p95      3,059.3 ms
accepted p95       64.8 ms
saving           2,994.5 ms, or 97.88%
```

Installed Herdr 0.7.5 lacks this option. Its exact parser rejection selects the
safe legacy path. Users gain the accepted-start reduction when their Herdr
client supports it.

Normal fresh Pi bootstrap measured 447.806 ms p50 and 460.567 ms p95. This is
the current serial process floor before exact Worker binding.

The measured p95 components give this comparison model. It is not an
end-to-end startup percentile:

```text
legacy model and Herdr stages plus fresh Pi: 7,984.062 ms
accepted and registry stages plus fresh Pi:    526.250 ms
modeled saving:                               7,457.812 ms, or 93.41%
```

Removing leader Task reconciliation has no fixed millisecond claim. It removes
a Task-count and authority-contention tail from Worker startup. Real graph and
legacy recovery canaries delivered pre-existing ready Tasks through Session
start and periodic recovery.

The maintained evidence is in the
[Worker startup performance context](../projects/worker-startup-performance.md)
and its linked machine artifacts.

## Consequences

Pi's internal `ModelRegistry` becomes an implementation dependency. Focused
compatibility tests own this boundary.

A failed accepted start can take up to 6,000 ms before compensation. This is
longer than the legacy 3,000 ms suspicion window. It lets a successful but slow
exact binding complete without duplicate actuation.

Herdr 0.7.5 keeps the old delay but preserves behavior. Newer Herdr clients can
return after positive acceptance. Both paths require the same exact binding.

Ready delivery no longer depends on a leader-side Task scan during
`ensure_worker`. Session start, Task transitions, and periodic recovery must
remain independently tested.

The public tool names, parameters, result kinds, Worker claim, and Task
delivery meaning do not change.

## Rejected alternatives

A production Node compile cache is rejected. Cold pairs became 12.380 ms slower
on average. Warm pairs saved about 15.137 ms, but each cache added about 1,506
files and 3.85 MB.

Generic warm carriers and reusable productive Sessions are rejected. They blur
Membership, Session, process, tool, and delivery identity.

Resource-discovery exclusions and bundling are rejected. They change extension
behavior or lack an exact-binding proof.

## Reversal criteria

Revisit this decision if Pi supplies a public prevalidated model snapshot, or
if Herdr changes its accepted-start contract.

Shape a separate decision for a strict cold-start SLO. That design must use a
single-use sealed launcher with an exact profile, lease, activation identity,
binding fences, and destroy-on-outcome behavior.
