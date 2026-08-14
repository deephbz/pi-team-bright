# Pre-actuation ensure latency result

Date: 2026-08-14
Stage: exploration inside the hardened Task-first package
Architecture impact: none
Status: measurement complete; no production change accepted

## Question and boundary

The reported exact-source canary took about 5.012 seconds from
`ensure_started` to `membership_prepared`, before Herdr actuation. This work
split the current integrated source path from
`DurableModelToolTeamApplication.ensureWorker` entry through durable
prepared-event publication.

The benchmark uses the actual application, Team persistence, resource
projection, and event publication in a fresh temporary home. A bridge subclass
stops at `launchPreparedMembership` entry, before its spawn callback. It does
not measure terminal actuation, Pi process creation, Session binding, startup
observation, Beads reconciliation, or full ensure latency.

The source bundle is
[`benchmarks/pre-actuation-ensure-latency/`](../../benchmarks/pre-actuation-ensure-latency/).
The canonical raw result is
[`2026-08-14-pre-actuation-ensure-latency-results.json`](artifacts/2026-08-14-pre-actuation-ensure-latency-results.json).
It records source revision `e92de56`, a clean measurement worktree, raw
redacted samples, fixed nearest-rank quantiles, and source-order hashes.

## Findings

All 42 integrated traces passed. Each had one current pending-launch
Membership, one matching prepared event, zero Pi Session files, zero terminal
spawns, zero pre-boundary Task reconciliation calls, zero pre-boundary Beads
calls, and cleaned owned resource aggregates.

The isolated source-coupled path had seven traces. Its
`ensure -> membership_prepared` time was 10.552 ms p50 and 22.221 ms p95.
Leader binding and configuration measured 2.336 ms p50 and 6.546 ms p95.
Resource projection measured 0.836 ms p50 and 1.565 ms p95. Membership
persistence measured 0.540 ms p50 and 4.573 ms p95. Prepared-event
publication measured 1.235 ms p50 and 5.130 ms p95.

The loaded condition ran four concurrent ensures in one Team. Its 28 traces
measured 14.069 ms p50 and 44.713 ms p95. Leader binding was the largest
contention-sensitive phase at 11.698 ms p50 and 33.290 ms p95. Aggregate lock
wait was 12 ms p50 and 34 ms p95, with a 50 ms maximum. This is a real local
lock tail, but it is not a seconds-scale owner.

The controlled directory condition added 32 unrelated valid Team records to a
fresh home. Its seven traces measured 19.842 ms p50 and 24.672 ms p95. Leader
binding measured 5.178 ms p50 and 10.986 ms p95. This controlled scan cost
also does not explain the reported 5.012 seconds.

The configured-default-model branch in the isolated integration uses a local
qualified-model validator, so its measured model phase was only 0.010 ms p50.
A separate current-profile call of the production `pi --list-models` helper
measured 771.512 ms p50 and 863.020 ms p95 across seven samples. The model
identity is redacted. This helper can be a material serial cost only when a
Worker default model needs validation. It does not establish that the canary
used that branch.

Fresh Bun child setup was outside the target interval. Isolated child setup
measured 320.234 ms p50 and 364.401 ms p95. The target starts after module
loading and fixture creation, so this is not a cold full-ensure result. The
fresh homes avoid prior Team state, but they cannot clear operating-system
file caches.

## Interpretation

The clean current application-to-prepared path is not the direct owner of a
5.012-second span. The result weakens the prior prediction that normal Team
and event persistence is a dominant seconds-scale serial cost. Controlled
same-Team contention produces a measurable tail, but remains below 53 ms.
A 32-Team binding scan adds tens of milliseconds, not seconds.

The production model catalog helper is the largest measured pre-actuation
candidate. Its 863.020 ms p95 still leaves more than four seconds unexplained
if the canary took that branch. The remaining time must be in the real
canary's outer timing boundary, active profile or project state, an unavailable
or slow resolver path, a lock not represented by the isolated fixture, or a
mixed-version path. This experiment cannot choose among those causes.

Task reconciliation is not a candidate for this interval. The current
application calls `reconcileReady` only after the launch bridge returns, while
the measured bridge stops before actuation. The source-order fence and all 21
child reconciliation records show zero calls before the boundary.

## Ranked recommendation

1. Add payload-free stage evidence to the real canary before changing Worker
   behavior. Split model catalog validation, exact leader binding, logical
   Worker persistence, resource projection, Membership persistence, and
   prepared-event publication using the same boundary names as this artifact.
   This is the only action that can locate the missing seconds.

2. Treat cached or pre-resolved model catalog validation as the first possible
   pre-actuation optimization. It can leave the critical path only with an
   explicit catalog identity, freshness rule, model/profile scope, and a
   revalidation rule before Membership persistence. A stale or different
   profile must refuse or recompute. The current data does not justify a
   production cache yet.

3. Keep exact leader binding, logical Worker persistence, Membership
   persistence, and prepared-event publication serial. The prepared event
   cannot precede durable Membership creation. The model captured on the
   Membership cannot follow its validation.

4. Resource projection and terminal detection may run in parallel only after a
   coherent Team and launch-context snapshot exists. Revalidate that snapshot
   before persisting the Membership. Their measured local cost is too small to
   justify a behavior change before the real trace identifies a larger owner.

5. Do not optimize Task or Beads reconciliation for this pre-actuation span.
   It is already outside the measured boundary.

No result supports a 100 ms full ensure claim. No persistent warm carrier,
cache, or production timing seam is accepted by this experiment.

## Reversal evidence

The recommendation changes if a real exact-source trace shows that the model
catalog branch is absent, cached, or below its local distribution, or if it
locates the missing time in a different outer operation. A production cache
requires a test that changes model catalog, project trust, cwd, and Worker
settings between preparation and Membership commit.
