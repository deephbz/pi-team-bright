---
document_id: pi-team-bright-worker-ensure-concurrency
document_kind: deferred-design-context
lifecycle_stage: shaping
decision_status: deferred
scope: Concurrent execution of independent ensure_worker calls from one Pi tool batch.
excludes: The official Herdr ready-start command correction and any public batch tool.
---

# Concurrent Worker ensure

Updated: 2026-08-19

Status: **deferred for later discussion and design**.

Architecture impact: none until an implementation changes an accepted internal contract.

## Operator situation

A leader can emit several `ensure_worker({ name, scope })` calls in one Pi tool
batch. Pi executes sibling tools in parallel by default, but Pi Team Bright
marks `ensure_worker` as sequential. Herdr commands also use a synchronous child
process. Each Worker can therefore add its readiness wait to the batch wall
clock.

The target is independent Worker launch concurrency without weakening exact
Membership, Session, process-generation, or pane-placement checks. A batch of
new Workers should pay short serialized layout work plus the slowest readiness
wait, rather than the sum of all readiness waits.

## Current boundary

Keep the singleton public verb:

```text
ensure_worker({ name, scope })
```

Do not add `ensure_workers` only to work around internal serialization. A new
batch verb would add partial-result and retry semantics to the model surface.
Pi already supplies the required sibling-call execution model.

The current serialization has two independent causes:

1. `ensure_worker` registers with `executionMode: "sequential"`.
2. Terminal commands use `spawnSync`, so a Herdr readiness wait blocks the
   extension process.

Removing only the first cause is unsafe and does not provide useful
concurrency. Concurrent calls can race on absent Worker admission and can derive
pane placement from the same stale Team snapshot.

## Design hypothesis

A later design should test this internal shape:

1. Use a durable per-Worker ensure lease. Calls for one logical Worker coalesce
   or revalidate, while different Workers remain independent.
2. Serialize only the short Team pane-layout mutation.
3. Re-read exact durable pane placement inside that topology lease.
4. Split the pane, start the exact Herdr command asynchronously, and persist the
   exact target before releasing the topology lease.
5. Await each readiness result and exact Session-binding observation outside
   the topology lease.
6. Keep compensation scoped to the exact Membership generation and carrier.
7. Replace blocking shell-readiness retry sleeps with cancellable asynchronous
   delays.

A terminal launch receipt could keep one small adapter verb while separating
its evidence:

```ts
type CarrierLaunch = {
  targetId: string;
  readiness: Promise<ReadyEvidence>;
};
```

This is a hypothesis, not an accepted interface.

## Required evidence before acceptance

- Trace current two-Worker and four-Worker batch wall time by preparation,
  layout, Herdr readiness, and exact Session binding.
- Prove that different Worker readiness waits overlap.
- Prove that duplicate same-name calls create at most one current carrier.
- Prove deterministic linear and grid placement from current durable targets.
- Prove that one failure or cancellation compensates only its exact carrier.
- Run real Herdr canaries with two and four Workers.
- Compare p50 and p95 batch wall time against the sequential baseline.

## Deferred decision

The owner separated this work from the official Herdr CLI correction on
2026-08-19. Do not implement concurrency as part of that patch release. Resume
from this document with explicit product and systems design review.
