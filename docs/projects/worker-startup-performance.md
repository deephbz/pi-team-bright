---
document_id: pi-team-bright-worker-startup-performance
document_kind: evergreen-performance-project
lifecycle_stage: hardening-result
scope: Worker carrier startup from ensure through exact Pi Session binding.
authority: Performance question, measurement contract, current assessment, and selected optimization.
excludes: LLM first-token latency, Task execution time, and weaker Membership or Session admission.
---

# Worker startup performance

Updated: 2026-08-14

Stage: **hardening result** inside the hardened Worker lifecycle.

Architecture impact: none for accepted changes. A persistent Pi runtime or a
carrier pool would change process and lifecycle boundaries.

The accepted optimization boundary is [decision
0012](../decisions/0012-worker-startup-latency.md). The final human assessment is
[`2026-08-14-worker-startup-final-assessment.md`](../journal/2026-08-14-worker-startup-final-assessment.md).
Its machine projection is
[`2026-08-14-worker-startup-final-assessment.json`](../journal/artifacts/2026-08-14-worker-startup-final-assessment.json).
Dated journals and raw machine artifacts retain the experiment history.

## Outcome

A stable, exact, already-bound Worker is the supported sub-100 ms path. Five
real reuse calls measured 31 ms p50 and 33 ms p95 at the `ensure_worker` tool
boundary.

Fresh Worker startup cannot meet 100 ms in the current stack. Normal fresh Pi
RPC bootstrap measured 447.806 ms p50 and 460.567 ms p95 before exact Worker
binding. Team creation is a separate 6--9 second operation.

The original seconds-scale delay had three important parts:

- Herdr's legacy human-facing ready wait was about three seconds;
- configured-default model validation could start a three-to-four-second Pi
  catalog subprocess;
- fresh Pi then supplied an approximately 450 ms serial process floor.

The accepted implementation removes the model subprocess from normal use and
requests positive Herdr actuation acceptance. Exact Session binding remains the
admission point. Installed Herdr 0.7.5 lacks the public accepted option, so its
safe legacy fallback still waits for interactive readiness.

## Startup ontology

Keep these states distinct:

- **launch prepared**: Team authority created the exact Membership generation
  and one-use launch capability;
- **actuation accepted**: the terminal runtime accepted the exact agent command;
- **carrier present**: a pane and process exist without Worker authority;
- **Session bound**: the child claimed the exact runtime generation and bound
  its durable Pi Session;
- **Worker ready**: a later successful turn set runtime readiness;
- **interactive ready**: Herdr observed the human-facing terminal state;
- **model responsive**: a provider produced output.

`Session bound` is the authority commit point. The observer must verify the
current Membership, durable Session, PID, and start generation. Pane presence,
actuation acceptance, RPC readiness, and a raw event are weaker evidence.

## Measurement contract

Measure these intervals separately:

1. `ensure entry -> Membership prepared` measures leader and Team bookkeeping;
2. `Herdr request -> actuation accepted` measures terminal actuation;
3. `process start -> Pi RPC response` measures fresh Pi bootstrap;
4. `actuation accepted -> exact Session bound` measures usable Worker admission;
5. `Session bound -> first Task delivery` measures dispatch;
6. `agent start -> provider response` measures model service and is outside the
   startup target.

Every result must state its endpoint, sample count, quantile rule, source and
runtime versions, resource profile, and excluded phases. A faster result fails
if it weakens exact admission, recovery fencing, or Worker resource semantics.

## Decisions in force

1. Request Herdr `--wait accepted`. Use the old ready wait only after an exact
   local parser rejection. Validate exact target and canonical Pi command.
2. Use the invocation-local Pi `ModelRegistry` for configured Worker-default
   validation. Keep the snapshot ephemeral. Use the bounded CLI fallback only
   when no usable snapshot exists.
3. Do not run leader Task reconciliation inside `ensure_worker`. Worker Session
   start, Task transitions, and periodic recovery own ready delivery.
4. Give an accepted start one 6,000 ms exact-binding failure-detector budget.
   Keep 3,000 ms for ordinary and legacy-ready starts. Let the explicit
   environment override win.
5. Keep normal Worker resource discovery. Do not use discovery exclusions as a
   duplicate-extension remedy.
6. Do not add a production Node compile cache. Its cold effect was unsupported,
   and its warm gain was about 15 ms on a partial path.
7. Reject generic reusable Session and carrier pools. A live prepared carrier
   is not capacity and must return `unbound_live`.
8. Keep stable Workers bound and reuse them when latency matters.

## Current evidence

The main anchors are:

- normal fresh Pi RPC with exact extension and discovery: 447.806/460.567 ms
  p50/p95 at n=10
  ([data](../journal/artifacts/2026-08-14-worker-bootstrap-discovery.json));
- isolated pre-actuation Membership preparation: 10.552/22.221 ms p50/p95 at
  n=7; four-way contention p95 44.713 ms
  ([data](../journal/artifacts/2026-08-14-pre-actuation-ensure-latency-results.json));
- stable exact bound-Worker reuse: 31/33 ms p50/p95; launch bridge 13/16 ms
  ([canary](../journal/artifacts/2026-08-14-ensure-reconciliation-real-team-canary.json));
- Herdr accepted actuation: 39.85/64.8 ms in the exact protocol-17 backport;
  legacy interactive ready: 3047.4/3059.3 ms
  ([data](../journal/artifacts/2026-08-14-herdr-accepted-start.json));
- CLI model validation: 3270.928/4464.195 ms; in-process registry validation:
  0.126/0.883 ms
  ([verification](../journal/artifacts/2026-08-14-model-registry-independent-verification.json));
- accepted binding delay: a 3.207-second injected delay bound at 4.167 seconds;
  a 6.2-second delay compensated at 6.017 seconds and retried in 485.476 ms
  ([data](../journal/artifacts/2026-08-14-startup-adversary-binding-budget-repair.json));
- Node compile cache: cold paired mean +12.380 ms with 95% interval
  [-15.792, 31.300]; warm paired mean -15.137 ms with interval
  [-26.568, -4.025]
  ([data](../journal/artifacts/2026-08-14-pi-compile-cache-paired-results.json)).

The graph and legacy recovery canary proved that removing leader reconciliation
does not lose ready work. Session-start repair delivered Tasks that existed
before recovery. Workers claimed and completed them without a leader Task
transition.

The accepted-start adversary proved exact compensation and same-Membership
recovery with a new generation. Deterministic tests cover cancellation,
binding-versus-cleanup races, and exact fences. A synchronous module block
prevented the real Escape probe from proving prompt cancellation, so that case
remains unknown.

## Interpretation

Amdahl's law limits cold optimization. Once the multi-second serial waits are
removed, the approximately 450 ms fresh Pi path bounds the result. A millisecond
Team change or a 15 ms cache cannot make that serial path finish in 100 ms.

Herdr acceptance and Worker admission form two phases. External actuation is a
side effect, so the full launch is a compensating saga. A lost reply cannot be
retried blindly. Exact operation identity, target cleanup, Membership fencing,
and runtime-generation fencing are required.

The observation timeout is a failure detector, not proof that a child is dead.
Compensation acts only on the exact carrier. Ambiguous stop evidence stays
ambiguous. A stale or late child cannot bind because it lacks the current
Membership and generation.

Warming shifts cost before demand. It also creates capacity and isolation
obligations. If a miss cannot meet a p95 target, then the probability of a hit
multiplied by the conditional probability of a fast hit must be at least 0.95.
Burst arrivals, failures, and replenishment make a nominal 95% hit rate
insufficient in practice.

## Rejected paths

- Resource-discovery exclusions changed semantics or lacked a safe speed gain.
- The Bun bundle had a 1367.364 ms p95 and no exact-binding proof.
- A generic compile cache added about 1,506 files and 3.85 MB per cache for no
  supported cold gain.
- RPC and SDK Session replacement retained module state.
- Preloading Pi Team Bright exposed leader tools before Worker admission.
- A quick local command in an unbound Herdr carrier did not prove admission.
- Direct adoption of an empty-looking Session lacked an ingress,
  noninterference, and teardown proof.

The corrected warm experiment receipt owns these negative results
([data](../journal/artifacts/2026-08-14-startup-adversary-warm-verification-corrected.json)).

## Next engineering work

For the current product:

1. Upstream and ship Herdr's public accepted-start operation.
2. Add Pi startup phase tracing before another cold optimization.
3. Keep stable Teams and Workers when repeated low-latency work is expected.
4. Measure first Task delivery separately from exact Session binding.

For a future strict 100 ms new-Worker target, first shape a separate one-use
sealed launcher:

`empty -> warming(profile_digest) -> sealed(slot) -> leased(activationId, membershipId, expiry) -> bound -> consumed`

The sealed state must have no productive Session, model action, Worker tool,
input, Task, Alert, or delivery authority. Reservation needs a CAS or lease,
one activation identity, exact fencing, destroy-on-outcome behavior, and lost
actuation reconciliation. The benchmark must separate hits, misses, stockouts,
bursts, replenishment, binding, delivery, and cleanup. This is a new
architecture experiment, not an accepted optimization.
