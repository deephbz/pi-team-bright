# Worker startup final assessment

Date: 2026-08-14
Stage: release-candidate hardening
Status: accepted production reductions complete; generic warm capacity rejected
Architecture impact: none for accepted changes

The operator target was about 100 ms from `ensure_worker` to a usable Worker.
The result depends on which state the target names.

A stable, exact, already-bound Worker meets the target. Five real reuse calls
measured 31 ms p50 and 33 ms p95 at the model-tool boundary. Fresh Worker
startup does not meet it. A normal fresh Pi RPC process reached its exact
response in 447.806 ms p50 and 460.567 ms p95 before Membership binding,
terminal presentation, or Task delivery.

The initial suspicion was partly correct. Fresh Pi now owns most of the safe
cold path, but two avoidable serial operations caused earlier seconds-scale
results. Herdr waited about three seconds for an interactive presentation
state. Configured-default model validation started a Pi catalog subprocess that
measured 3270.928 ms p50 and 4464.195 ms p95 on that resolver boundary. The
accepted changes remove the catalog subprocess and let a capable Herdr return
after positive actuation acceptance. Exact Session binding remains the Worker
admission point.

The compact machine result is
[`2026-08-14-worker-startup-final-assessment.json`](artifacts/2026-08-14-worker-startup-final-assessment.json).
The dated artifacts linked below retain sample boundaries and limits.

## State and authority boundary

Keep these states distinct:

1. **prepared**: Team authority created one exact Membership generation and a
   one-use launch capability;
2. **actuation accepted**: Herdr accepted the exact command for the exact
   terminal target;
3. **carrier present**: a process or pane exists without Worker authority;
4. **Session bound**: the child claimed the exact runtime generation and bound
   its durable Pi Session;
5. **Worker ready**: a successful turn later set runtime readiness;
6. **interactive ready**: Herdr observed a human-facing terminal state;
7. **model responsive**: the provider produced output.

`Session bound` is the admission linearization point. Neither Herdr acceptance,
pane presence, process birth, a raw event, nor RPC readiness can replace the
exact Membership, Session, and runtime-generation check.

## Accepted production changes

- The Herdr adapter requests explicit `--wait accepted`. It validates the exact
  name, pane, terminal, canonical Pi command, and pending or interactive state.
  It uses legacy ready waiting only after an exact old-client parser rejection.
- Configured Worker defaults use the invocation-local Pi `ModelRegistry`.
  The model-key set is ephemeral and never enters Team state, traces, prompts,
  tool results, or durable receipts. A bounded CLI fallback remains only when
  the registry snapshot is unavailable.
- `ensure_worker` returns after exact Worker admission. It no longer performs a
  leader Task-authority scan. Worker Session start, Task transitions, and the
  periodic recovery loop own ready delivery.
- A Herdr accepted start receives one 6,000 ms exact-binding observation budget.
  Ordinary and legacy-ready starts keep 3,000 ms. The explicit environment
  override wins. This timeout is a failure-detector policy, not readiness.
- The mixed-version transition bridge remains. A graph-native Worker can claim
  and finish a legacy Task without weakening graph-native outcome semantics.

These changes preserve current authorities and process boundaries. They need no
HyperCarrier architecture-diagram change.

## Empirical result

### Safe fast path

The real graph, legacy, recovery, and reuse canary passed. Graph and legacy
Tasks that existed before carrier recovery reached Worker-authored success
without a leader Task transition. Stable bound-Worker reuse measured 31/33 ms
p50/p95 for `ensure_worker` and 13/16 ms for its launch bridge. No Task-authority
operation occurred between the five reuse calls
([canary](2026-08-14-ensure-reconciliation-real-team-canary.md),
[machine receipt](artifacts/2026-08-14-ensure-reconciliation-real-team-canary.json)).

This is the only supported sub-100 ms Worker path. Keep stable Workers bound and
reuse their logical identity.

### Cold path

A corrected 80-sample resource-discovery benchmark measured a normal fresh,
offline, exact-extension Pi RPC process at 447.806 ms p50 and 460.567 ms p95.
Disabling extensions or Skills changed semantics. Other resource exclusions did
not supply a safe speed result. A Bun bundle measured 420.081 ms p50 but
1367.364 ms p95 and had no exact-binding proof. Keep normal resource discovery
([result](2026-08-14-worker-bootstrap-discovery-result.md),
[data](artifacts/2026-08-14-worker-bootstrap-discovery.json)).

The measured pre-actuation Pi Team Bright path is small. An isolated
`ensure_worker` entry to durable Membership preparation measured 10.552 ms p50
and 22.221 ms p95. Four-way same-Team contention measured 44.713 ms p95. This
supports the conclusion that fresh Pi bootstrap, not Team bookkeeping, now owns
most of the safe cold floor
([data](artifacts/2026-08-14-pre-actuation-ensure-latency-results.json)).

### Removed serial costs

A capable Herdr accepted the exact Worker command in 39.85 ms p50 and 64.8 ms
p95 in the protocol-17 backport canary. The installed legacy interactive-ready
path measured 3047.4/3059.3 ms for the same exact-extension case. Installed
Herdr 0.7.5 does not expose the accepted flag, so production safely falls back
until Herdr ships the public contract
([result](2026-08-14-worker-startup-accepted-launch.md),
[data](artifacts/2026-08-14-herdr-accepted-start.json)).

Configured-default validation through the removed CLI path measured
3270.928/4464.195 ms p50/p95. The invocation-local registry path measured
0.126/0.883 ms. Independent verification proved precedence, pre-actuation
refusal, recovery from the captured model, and no catalog leak
([verification](2026-08-14-model-registry-independent-verification.md),
[data](artifacts/2026-08-14-model-registry-independent-verification.json)).

### Failure detector and recovery

The accepted-start repair passed typecheck and 60 focused tests. A real
3.207-second normal-execution module delay bound after 4.167 seconds. A
6.2-second delay returned `carrier_unavailable` after 6.017 seconds, stopped the
exact carrier, published no late binding, and rebound the same Membership with
a new runtime generation in 485.476 ms. A 30-second override accepted a
6.210-second delay after 7.055 seconds
([decision](2026-08-14-accepted-start-binding-budget.md),
[receipt](artifacts/2026-08-14-startup-adversary-binding-budget-repair.json)).

SIGSTOP/SIGCONT was rejected as latency evidence because it disrupted binding
non-additively. A real Escape during synchronous module blocking did not prove
prompt cancellation. Deterministic tests cover abort propagation, exact
compensation, binding-versus-cleanup races, and generation fencing. This limit
remains explicit.

### Compile cache

The final paired benchmark used 15 cold and 15 warm pairs with shuffled order
and 10,000 bootstrap resamples. A cold cache changed admission by +12.380 ms on
average, with a 95% interval from -15.792 to +31.300 ms; 13 of 15 pairs were
slower. A warm cache changed it by -15.137 ms, with a 95% interval from -26.568
to -4.025 ms; 12 of 15 pairs were faster. Each cache held about 1,506 files and
3.85 MB.

Do not add a production compile cache. The cold effect is unsupported, and the
small warm gain cannot change the approximately 450 ms cold Pi floor. It also
adds cache identity, invalidation, storage, and cleanup work
([data](artifacts/2026-08-14-pi-compile-cache-paired-results.json)).

## Adversarial conclusions

Production warm pooling remains rejected. Corrected source tests showed that
Session replacement keeps module state. Loading Pi Team Bright before Worker
admission exposes the leader surface and common Task tools. A live unbound
prepared carrier is correctly refused as `unbound_live`; it is not reused.
The experiments did not prove real pool capacity, profile noninterference,
Membership replacement, TTY readiness, first model output, or post-bind Task
delivery
([receipt](artifacts/2026-08-14-startup-adversary-warm-verification-corrected.json)).

A preloaded one-shot process produced fast synthetic slices, including one
roughly 100 ms exact-admission/RPC result and one 164--174 ms observed TUI bind
range. These measurements do not prove a product SLO. They exclude reservation
wait, stockout, replenishment, complete profile isolation, and several crash
boundaries. Direct adoption of an empty-looking Pi Session is unsafe without a
mechanical ingress and noninterference proof.

## Computer-science interpretation

Amdahl's law explains the cold limit. Removing a three-second presentation wait
and a multi-second catalog subprocess exposes the remaining serial Pi bootstrap
work. Optimizing millisecond Team bookkeeping or a 15 ms warm cache cannot make
a roughly 450 ms serial process path complete in 100 ms.

Startup is a two-phase external-actuation protocol. Herdr acceptance says that
an external side effect began. Exact Session binding commits Worker authority.
The full operation is a compensating saga, not one transaction. A lost reply,
late child, or stale generation therefore needs an operation identity,
compensation, and fencing.

A timeout is an unreliable failure detector. It does not prove process death.
The implementation remains safe because it stops only the exact carrier,
retains uncertainty when stop proof is absent, and fences every later binding
with the current Membership and runtime generation. This prevents a late or ABA
binding from becoming current.

Warming moves work outside the request path; it does not remove work. A p95 SLO
also needs enough matching capacity. If a pool miss cannot finish inside the
SLO, then the warm-hit probability times the conditional warm success rate must
exceed 0.95. A nominal 95% hit rate is only a mathematical floor because
activation failures consume more of the error budget.

## Recommendation

For current production:

1. Keep stable Workers bound and reuse them. This is the measured sub-100 ms
   path.
2. Upstream Herdr's explicit accepted-start mode. Do not weaken exact binding
   while the installed client uses its legacy fallback.
3. Add public Pi startup phase tracing before another cold optimization. The
   trace must separate process entry, imports, resource discovery, Session
   construction, `session_start`, binding, and first delivery.
4. Keep normal Worker resources. Do not add a generic compile cache, discovery
   exclusion, Bun bundle, reusable Session pool, or unchecked shell launch.
5. Treat Team creation's separate 6--9 second cost as a different product
   operation. Reuse a Team when repeated low-latency Worker operations matter.

If a strict 100 ms **new-Worker** SLO remains necessary, shape a separately
named sealed launcher. Its durable state machine should be:

`empty -> warming(profile_digest) -> sealed(slot) -> leased(activationId, membershipId, expiry) -> bound -> consumed`

Before binding, the slot must have no Worker Session, model action, productive
tool surface, Task or Alert delivery, or input path. Reservation must use a CAS
or lease, one activation identity, exact Membership and process-generation
fences, one-use destruction, and reconciliation for lost actuation replies.
Measure warm hits, misses, stockouts, burst sizes, replenishment, exact binding,
first delivery, and cleanup as separate distributions. Do not implement this
architecture from the current synthetic evidence.

## Final limits

The accepted changes do not prove first provider response or Task execution
latency. Installed Herdr still takes the safe legacy fallback. Real prompt
cancellation during a synchronous module block remains unproven. The reuse and
real recovery samples are small and local. They verify the selected changes;
they are not a population capacity guarantee.
