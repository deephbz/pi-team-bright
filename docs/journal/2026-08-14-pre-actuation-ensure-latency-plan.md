# Pre-actuation ensure latency plan

Date: 2026-08-14
Stage: exploration inside the hardened Task-first package
Architecture impact: none

## Question

Which current integrated `ensure_worker` operations occupy the interval from
model-tool ensure entry to prepared Membership publication, before terminal
actuation?

A real exact-source canary reported about 5.012 seconds from
`ensure_started` to `membership_prepared`. This is an external comparison
anchor. This experiment does not reproduce its ambient workload.

## Prediction

A clean source-coupled pre-actuation path will be much shorter than 5.012
seconds. Logical Worker and Membership configuration persistence, plus
prepared-event publication, will own the measured serial work. Task or Beads
reconciliation will not occur before the boundary. Concurrent ensures will
show lock-sensitive persistence tail growth.

## Method

The source bundle is `benchmarks/pre-actuation-ensure-latency/`. Its
machine-readable plan is `plan.json`.

The runner starts one fresh child process per isolated sample. Each child uses
a new temporary home, Pi agent directory, project, Team, and event journal.
It calls the current `DurableModelToolTeamApplication.ensureWorker` path with
real Team persistence, resource projection, and event publication. A small
`WorkerLaunchBridge` subclass stops at `launchPreparedMembership` entry. It
therefore cannot spawn a terminal carrier or create a Pi Session.

The trace records leader binding, logical Worker persistence, bridge Team
configuration and terminal detection, resource aggregate projection, model
resolution, Membership persistence, prepared-event publication, and residual
bridge overhead. It also records the exact phase order.

The loaded condition runs four concurrent ensures for different Worker names
in one fresh isolated Team. It records each request separately. The experiment
reports this as controlled same-Team contention, not a production capacity
claim. A third controlled condition adds 32 unrelated valid Team records to a
fresh home. It measures exact lead-binding scan sensitivity without reading an
ambient Team directory.

The Worker default-model branch uses the current bridge logic and a local
qualified-model validation dependency in the integrated lanes. A separate
current-profile microprobe invokes the current `pi --list-models` helper for a
redacted qualified candidate. It remains separate because the catalog depends
on the active profile and project context.

## Boundary checks

For every successful trace, the runner checks all of these facts:

- one current Membership has a pending launch ID and no Session file;
- one prepared event has the same Membership ID;
- the terminal spawn count is zero;
- Task reconciliation count is zero before the stop boundary.

The runner rejects a trace when the sequence or a boundary check differs.
Task reconciliation is structurally after `WorkerLaunchBridge.ensureWorker`
returns in the current application. It is outside the pre-actuation interval.

## Data graph

```text
current source + isolated settings
  -> source-coupled integrated ensure
  -> phase trace + prepared-state checks
  -> redacted raw sample records
  -> fixed quantiles and phase shares
  -> critical-path recommendation

reported 5.012 s canary
  -> comparison only
  -> scope limit on recommendation
```

## Acceptance

Run seven isolated samples, seven loaded groups of four requests, seven
controlled Team-directory samples, and seven current-profile model-catalog
microprobe samples when a catalog candidate is available. Keep each redacted
raw timing record. Include source revision, environment versions, condition,
phase order, successful boundary checks, and fixed p50/p95 values. Do not
claim a 100 ms full ensure result.
