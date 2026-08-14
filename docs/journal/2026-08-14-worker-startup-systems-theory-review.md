# Worker startup systems-theory review

Date: 2026-08-14
Status: in progress; independent analysis only, no production change
Task: `ptb-worker-startup-opt-yy9`
Source inspected: local `eea33ed`

## Scope and current coordination state

The Task asks for a grounded startup review: process supervision, two-phase
admission, leases/fences, state refinement, queueing and pools, warm-pool
isolation, idempotent actuation, linearizability, and failure detectors. It
also asks whether p95 near 100 ms is possible.

The Worker tool surface could not claim or close this legacy-created Task. Both
claim attempts refused because the Worker has graph-native mutation only. The
lead set the Task to `in_progress` and explicitly directed this review to
continue. The final result must be sent in one Alert for lead reconciliation.
Do not claim a Task transition until the authority issue is fixed.

The lead added one required comparison: evaluate a **single-use prewarmed
launcher**. It starts a reserved process/PTY, imports only a profile-invariant
Pi module graph, creates no Session or tools, then one activation lease sets
exact environment, cwd, and profile and invokes Pi main. The launcher is
consumed once and never reset or reused. The lead initially supplied an approximately 335 ms import-floor hypothesis.
A later empirical update supersedes that estimate for the tested setup: a
single-use preloaded Pi main plus a pre-imported bundled inline Pi Team Bright
extension measured a separate preload p50 of 382.25 ms, then RPC activation p50
59.09 ms and p95 83.05 ms across 10 samples. A raw TypeScript extension after
main preload measured 121.22/168.77 ms, while the minimal path measured
36.18/37.67 ms. The bundled result is activation only, not exact Worker
readiness, terminal/TTY proof, or Task delivery.

## Strong current assessment

A 100 ms target is meaningless until it names a state. The current contract
already separates `starting`, `connected`, and runtime `ready`; it must keep
that separation.

A cold `connected` result has a serial lower-bound path:

`prepare Membership -> terminal spawn -> Pi boot -> runtime claim -> Session
bind -> session-bound event -> authoritative tuple verification`.

The model-tool `ensureWorker` path then awaits ready-front reconciliation before
returning. On the legacy Beads path, that reconciliation can enter a serialized
Dolt-backed read. Existing Beads measurements make a 100 ms full response
implausible, but do not measure this exact reconciliation call. A fresh Pi
process plus first Task execution has no current 100 ms evidence.

The smallest safe way to make a dispatch-like operation fast is not a generic
reusable Session pool. It is pre-created, fixed-profile stable Worker capacity:
a current session-bound Worker with its existing logical name and scope. This
amortizes cold launch before demand. It can only meet the target after measuring
reuse plus ready delivery, and it must not be called cold startup.

A single-use prewarmed launcher is the next-smallest design when pre-creating
full Worker identities is too restrictive. The empirical bundled-inline result
makes its activation path plausible for a 100 ms SLO: if full startup includes
activation, its p95 cannot be below the measured 83.05 ms activation p95. This
leaves only a nominal 16.95 ms SLO budget for all later required phases; do not
sum independent p95 values or call that a full-startup result.

It can remove import time while preserving Session isolation, but only if the
imported graph is demonstrably independent of cwd, environment, trust,
settings, extension selection, model, and worker profile. Pi's documented SDK
constructs cwd-bound services and resource loaders at session creation. It
supplies no documented "import now, late-bind CLI main" contract. Therefore
this launcher is a promising experiment, not a safe optimization assumption.

## Current executable protocol

The source has useful identity distinctions.

- A `LogicalWorker` is the durable name and scope.
- A `Membership` is one generation and has `membershipId`.
- A prepared Membership has a one-use `pendingLaunchId` capability.
- A terminal target, Pi Session file, and runtime generation are separate.
- A runtime generation is `(membershipId, pid, startedAt)`.
- `ready: false` is written at process admission. Later successful-turn
  handling records runtime readiness. A session-bound Worker is not necessarily
  ready to work.

The new-carrier flow in
[`worker-launch-bridge.ts`](../../src/team-authority/worker-launch-bridge.ts)
is:

1. Persist a prepared, active Membership with `membershipId`, `pendingLaunchId`,
   immutable selected model/cwd/profile, and scope.
2. Publish a `prepared` Worker event.
3. Spawn the terminal carrier with team, worker, Membership, and launch
   capability environment values.
4. Persist its terminal target.
5. Wait for bounded startup observation.

The child flow in
[`team-session-lifecycle-service.ts`](../../src/team-authority/team-session-lifecycle-service.ts)
is:

1. Check terminal admission and expected Membership identity.
2. Hold the exact Membership lease.
3. Claim a runtime generation; only an exact launch capability can claim an
   unbound Membership.
4. Write `ready: false` runtime evidence.
5. Bind the durable Pi Session, consuming the launch capability.
6. Append the `session_bound` event.
7. Only then start direct-Message and Task delivery in
   [`pi-team-session-adapter.ts`](../../extensions/pi-team-session-adapter.ts).

Startup observation in
[`worker-startup-observation.ts`](../../src/utils/worker-startup-observation.ts)
accepts a `session_bound` event only after it verifies the exact Membership,
PID, and `startedAt` tuple from authority. Its default wait is 3,000 ms. A
timeout returns `starting`-compatible evidence, not false readiness.

Recovery holds the exact Membership lease through revalidation, PID preflight,
spawn, and terminal-target persistence. The replacement child alone claims the
runtime generation. This avoids the former parent/child self-rejection race.

## Systems mapping

### Supervision and state refinement

The existing system is leader-triggered reconciliation, not a continuous
supervisor. `ensure_worker` reuses a live carrier or recovers a missing one.
A warm design needs a separate Team-owned desired-capacity controller. It need
not be a service or a new Task authority.

The current state machine is roughly:

`absent -> prepared -> session_bound/runtime_claimed -> observed -> turn_ready`

with `prepared` retry and exact-Session recovery as distinct transitions.
`worker-ensure-lifecycle.ts` encodes `absent`, `prepared`, `bound`, and invalid
carrier forms. Preserve these distinctions.

For a single-use prewarmed launcher, add a separate carrier state machine:

`cold -> priming -> primed -> reserved -> activating -> consumed -> reaped`

A primed launcher has no Membership, Session, Task, Worker tool surface, or
profile-specific project state. `reserved` atomically assigns a `launcherId`,
`activationId`, requested profile hash, and intended Membership. `activating`
may run Pi main exactly once. Any success or failure moves to `consumed`; exact
terminal/process reaping is required before capacity replenishment. It must
never transition back to `primed`.

### Leases and fencing

`withCurrentMembershipLease` serializes exact generation mutation. The
`membershipId` is an identity fence. The single-use `pendingLaunchId` fences
first Session binding. The runtime tuple fences event observation and runtime
file deletion. The lock implementation uses a random owner token, heartbeat,
and refuses ambiguous stale recovery.

These mechanisms give local serialization, not a distributed lease. PID
presence is conservative: only `ESRCH` proves absence; `EPERM` and unknown
errors mean occupied. PID reuse can cause a safe false refusal, because a PID
probe has no OS birth-time comparison. Do not turn a stale heartbeat, terminal
absence, or unknown PID error into proof that a process is dead.

### Linearizability and actuation

The logical Worker, prepared Membership, runtime claim, and Session binding
have different durable linearization points. A `session_bound` event is
notification evidence, not authority. The event-plus-authority verification
keeps this correct.

Terminal spawn is an external side effect. It is not atomically coupled to
Membership persistence, so the full launch is a compensating saga, not one
linearizable transaction. Current compensation stops only the returned exact
target and retains the Membership if stop evidence is uncertain.

`pendingLaunchId` is not yet a terminal-spawn idempotency receipt. If a terminal
executes a spawn but the caller loses its response before target persistence,
a blind retry can create an orphan candidate. The first child should still be
fenced from double binding, but resource leakage remains possible. A future
warm launcher needs a durable `ActivationAttempt` before actuation, a stable
attempt ID visible to the terminal/bootstrap, reconciliation by that ID, and
idempotent stop/reap evidence.

### Queueing and capacity

For a warm pool, let `S` be activation service time and `c` the number of
primed slots for one immutable profile. A necessary capacity condition is
`rho = lambda / (c * mu) < 1`, where `mu = 1 / E[S]`. For a 100 ms global p95,
use a tail budget such as:

`P(stockout) + P(warm activation > 100 ms | hit) <= 0.05`.

This is a design constraint, not a current measurement. The pool must be
sized from burst arrivals and replenish time, not average arrival rate alone.
Reserved PTYs and processes consume capacity even while idle. A single-use
launcher has no cleanup/reset cost on the critical path, but needs enough
primed slots that consumption and replenishment do not cause more than five
percent stockouts.

The current response path also awaits
`taskOrchestration.reconcileReady` after Worker launch in
[`durable-model-tool-team-application.ts`](../../src/model-tool-contract/durable-model-tool-team-application.ts).
The legacy adapter serializes this under `.ready-reconciliation` and opens a
Beads/Dolt dispatch snapshot. Treat this as an independent response-tail
candidate. Do not remove it without proving ready-delivery recovery remains
durable and idempotent.

### Single-use launcher reservation

The one-shot reservation must be a durable state machine, not an in-memory
promise. Each primed slot needs an opaque `slotId`, immutable bootstrap digest,
and profile-key domain. Reservation atomically changes one matching slot from
`primed` to `reserved` under a pool lease and records an opaque one-use
`activationId`, intended Membership ID, and operation ID. The bootstrap accepts
activation only after it reads that exact reservation. It then sets cwd and
environment, enters Pi main once, burns the activation ID, and moves to
`consumed` even when Pi main fails.

A second caller with the same operation ID must discover the same reservation
or exact in-progress carrier. A caller with a different operation ID must not
steal it. After a crash, the controller waits for exact process/PTY reaping,
then records failure and replenishes with a new slot; it never resets the old
process for another profile. This is an actuation saga, so terminal creation,
activation acknowledgement, and reaping need separate receipts.

The profile key must cover all values that could have been captured before
activation: Pi/runtime and bundled-extension digest, Team epoch, terminal
backend, cwd, trust decision, agent directory/settings policy, model and
thinking policy, Worker resource aggregate content, and other imported
configuration. Task text, Task identity, Session identity, Membership
capability, and Worker tools must be absent from a primed slot. This
no-session-before-activation rule narrows isolation risk: no prior conversation,
Task delivery, tool registration, or Session-bound authority can leak into the
next Worker. It does not prove imported code avoided environment or cwd capture.

### Warm isolation

A reusable Pi Session pool is unsafe for arbitrary new Workers. Existing
logical Worker scope is durable, and a scope conflict is refused. Worker
settings and resource aggregates are resolved before process start. Pi docs
also state that cwd selects project resources, context, skills, extensions, and
settings during session construction.

A full Worker pool must therefore be partitioned by at least Team epoch,
extension/version set, terminal backend, cwd and trust decision, resource
aggregate/profile hash, model and thinking policy, and any authority binding.
Never assign a new profile to a live Session that saw another profile's prompt,
context, tools, or credentials.

The one-use launcher improves this: it carries no Session or Task context and
is destroyed after activation. Its key risk is import-time capture. Imported
modules or extension factories can read `process.env`, cwd, settings, trust, or
register side effects before activation. The design is safe only with an
explicit audited bootstrap graph whose modules are profile-invariant. Otherwise
partition it by every captured input, or do not pre-import it.

## Evidence and limits

Source/test evidence:

- `runtime-startup-admission.test.ts`,
  `worker-startup-observation.test.ts`, and
  `team-session-lifecycle-service.boundary.test.ts` passed together: 3 files,
  33 tests in 3.27 seconds.
- `launch-compensation.contract.test.ts` is exhaustive-only; it passed through
  `vitest.full.config.ts`: 1 file, 15 tests in 1.89 seconds.
- Tests prove local state ordering, fencing, timeout semantics, and
  compensation. They do not measure a real cold Pi process or p95 startup.

Observed runtime evidence:

- The lead-delivered single-use launcher benchmark measured preload p50
  382.25 ms outside activation. Bundled inline extension activation was p50
  59.09 ms and p95 83.05 ms at n=10; raw TypeScript extension activation was
  121.22/168.77 ms and minimal activation 36.18/37.67 ms. This is direct
  timing evidence for only that RPC activation boundary. It sets a p95 lower
  bound of 83.05 ms for any full path containing that activation, not a
  readiness or TTY claim.
- The rc.14 isolated E2E connected eight Workers and recovered one logical
  Worker safely. It proves the flow can work end to end, not startup latency.
- Its 27 `team_sync` product calls had nearest-rank p50 3,030 ms, p95 4,932 ms,
  and maximum 5,308 ms. These are not Worker startup samples.
- The maintained Task-performance project reports one-ID Beads reads at
  425.2 ms p50 and a reverse-dependent tail at 3,852.2 ms p95. This is strong
  warning evidence for any synchronous Beads work on a 100 ms response path;
  it is not a measurement of graph-ready reconciliation or Pi boot.

Pi SDK evidence:

- Pi 0.83 documents `createAgentSession` and `createAgentSessionRuntime` as
  supported programmatic constructors. They take explicit cwd, agent directory,
  settings/resource loaders, and session managers.
- The documented surface does not promise a separately importable CLI-main
  bootstrap that can safely change process-global env/cwd after imports.
- Pi docs state extension factories run before session startup and may do
  initialization; this increases the bootstrap-graph audit requirement.

## Unsafe shortcuts

Do not:

- label terminal spawn, a `prepared` event, or a raw `session_bound` event as
  `connected`;
- shorten the 3-second observation to 100 ms and reinterpret timeout as
  readiness;
- replace a process from heartbeat expiry, terminal absence, or an uncertain
  PID probe;
- remove Membership/launch fences or let the parent claim a child generation;
- reuse or sanitize a prior Pi Session for a different profile;
- blindly retry terminal actuation after a lost response;
- put Task authority work before child admission, or conflate Task delivery
  with Session binding;
- claim the supplied 335 ms import figure as measured fact without a benchmark.

## Next tests and falsifiable predictions

1. Define four timestamps: reservation accepted, terminal/launcher activated,
   exact `connected`, and first Task delivery/first successful turn. Test each
   separately. Do not use model-thinking or `team_sync` time as startup time.
2. Extend the real process/PTY benchmark for cold, fixed-profile prewarmed
   Worker, and single-use launcher at burst sizes 1, 2, 4, and 8. Record p50,
   p95, p99, stockout rate, and phase spans without Task text or private paths.
   The tested bundled activation is already p95 83.05 ms at n=10, so measure
   residual admission, Session bind, event verification, and TTY phases on the
   same samples before claiming an end-to-end 100 ms p95.
3. For the single-use launcher, differential-test cold vs primed startup under
   distinct cwd, trust, model, extension, and resource settings. A profile
   mismatch, import-time setting read, early extension tool registration, or
   Session creation before activation fails the design.
4. Inject crashes and lost acknowledgements after reservation, PTY creation,
   activation intent, Pi-main entry, runtime claim, Session bind, and event
   append. Assert at most one live generation per Membership, no prepared or
   primed process can mutate Task/Alert authority, and every terminal target is
   reconciled or explicitly retained for recovery.
5. Measure whether `reconcileReady` dominates reuse response time. If yes,
   separate durable dispatch scheduling from the carrier-connected receipt, but
   retain a retryable ready-front record and prove no Task delivery loss.
6. The bundled-inline activation result predicts that preloading can remove
   most import work, while raw TypeScript extension loading misses the 100 ms
   target. Verify that result across process starts and profiles. It must not
   hide terminal scheduling, Pi Session setup, exact admission, or delivery
   time. If it does, remove the design rather than widening its privilege.

## Owner question and transferable lesson

Ask the owner which promise must be under 100 ms: durable reservation, visible
terminal target, exact connected Worker, Task delivery, first Task claim, or
first model output. A counterexample is a request that receives a fast terminal
pane but cannot safely act; it must not count as startup success.

The transferable lesson is that warming changes *where* latency occurs, not
what authority may be skipped. Keep carrier, Membership, Session, process
generation, task delivery, and readiness separate. Use fences for correctness,
traces for diagnosis, and a measured tail budget for capacity. A fast response
that reports an untrue state is slower operationally than an honest `starting`.

## Addendum: exact-admission benchmark update

On 2026-08-14, the lead supplied a newer empirical result. Ten synthetic,
single-use preloaded activations reached an exact Membership, `session_bound`,
runtime PID, and RPC-ready endpoint. The reported p50 was 49.87 ms and the
reported p95 was 99.57 ms. Each reservation had no prior Session.

This is stronger than the earlier bundled activation-only result. It demonstrates
a sub-100 ms **sample** p95 for that exact preloaded admission slice. It does
not demonstrate the terminal product. It does not yet establish the request
arrival point, reservation wait, slot priming, replenishment, terminal product
response, Task delivery or claim, or first successful model turn. The raw trace
for this update was not supplied to this Worker. Its evidence class is a
lead-delivered empirical report until the raw samples and clock boundaries are
attached.

### Corrected SLO assessment

The result makes a 100 ms warm-hit SLO plausible for exact admission plus RPC
readiness. It does not make the same SLO true for a broader product operation.
The reported p95 leaves 0.43 ms to a 100 ms deadline. Therefore, an unmeasured
serial step cannot join that same interval unless it overlaps the measured work
or the SLO boundary moves.

Define the measured state transition as:

`primed -> reserved -> activating -> admitted -> session_bound -> rpc_ready`

`admitted` means the exact Membership claimed its runtime generation and wrote
runtime evidence. `session_bound` remains a verified durable binding. `rpc_ready`
is the demonstrated endpoint. `delivery_ready` and `turn_ready` remain distinct
later states. A visible terminal product also needs its own explicit endpoint.

The no-prior-Session result supports the single-use isolation argument. It does
not prove profile isolation. Imported Pi code or extension factories can still
capture cwd, environment, trust, settings, or resources before activation.
A primed slot must still have no Membership capability, Session, Task, tools,
or profile-specific state. A bootstrap digest and differential import test
remain required.

### Pool-hit p95 and remaining obligations

Let `H` mean that a matching primed slot is available when the request arrives.
For a 100 ms product SLO:

`P(T <= 100 ms) = P(H) * P(T <= 100 ms | H) + P(not H) * P(T <= 100 ms | not H)`

If a pool miss cannot meet the deadline, the pool-hit probability and warm-hit
success probability together must be at least 0.95. The new result measures
only a synthetic warm-hit slice. It does not measure `P(H)`, reservation
contention, or replenishment delay.

At `n=10`, a reported sample p95 is not proof that the population p95 is below
100 ms. Even if all ten independent samples met the deadline, zero observed
misses give an approximate one-sided 95 percent upper failure bound of 25.9
percent. About 59 independent no-miss samples are the minimum for a five
percent bound at that confidence level. Real validation needs more samples,
burst arrivals, varied profiles, and clock traces. Do not treat this count as a
substitute for a tail-distribution measurement.

The pool controller needs one durable reservation linearization point. It must
bind `slotId`, bootstrap digest, profile key, intended Membership, and one-use
`activationId` under a pool lease. `pendingLaunchId` still fences first Session
binding; it is not the idempotency receipt for launcher actuation. A lost
activation response must reconcile the same `activationId`, never activate a
second slot blindly. Every activation result consumes the slot. The controller
reaps its exact process/PTY before it replenishes capacity.

The next decisive tests are:

1. Attach raw phase traces for the ten samples. State the start and end clocks,
   slot state, profile digest, and all excluded phases.
2. Run cold, warm-hit, and pool-miss tests at bursts of 1, 2, 4, and 8. Include
   reservation lock wait, stockouts, and replenishment in the product interval.
3. Repeat across enough independent hits to estimate the chosen p95/p99 claim.
   Record all deadline misses, not only quantiles.
4. Fault-inject after reservation, activation intent, Pi-main entry, runtime
   claim, Session bind, and RPC-ready acknowledgement. Prove one live process
   per Membership and one consumed slot per `activationId`.
5. Differential-test the primed bootstrap across cwd, trust, model, extension,
   and resource changes. Reject the design if imports create a Session, tools,
   or profile-specific side effects before activation.

The updated strongest claim is: a single-use preloaded launcher now has direct
synthetic evidence for a roughly 100 ms exact-admission/RPC-ready warm hit. It
is not yet evidence for a 100 ms terminal product. The smallest safe design is
still a fixed-profile pool of one-use, profile-invariant primed launchers with
durable reservation fences, exact reaping, and measured stockout control.

## Addendum: real TUI result and reservation-TUI trade

### Observation and limit

The lead supplied a real-TUI result on 2026-08-14. Five exact-origin,
no-focus Herdr activations preserved exact admission and naming. Their reported
bind time was p50 164.42 ms and p95 174.14 ms. Herdr idle observation was p50
273.12 ms. The earlier RPC-ready p95 of 99.57 ms is therefore not the terminal
product result.

This is lead-delivered empirical evidence. The raw trace, clock boundaries,
and sample values were not supplied to this Worker. At `n=5`, the quantiles
show that this observed TUI path misses a 100 ms target. They do not estimate
its population p95. Herdr idle is an observer signal. It must not replace an
exact admission, input-safety, delivery, or turn-ready state.

Do not subtract the RPC p95 from the TUI p95 to assign a TUI cost. These are
different modes with different sample counts. Quantiles do not add or subtract
that way. A paired phase trace is required.

### Safety and latency alternatives

The single-use no-Session launcher has the better current safety case. A primed
process has no Session, tools, Task delivery, or Membership authority. One
activation burns the carrier and exact reaping precedes replacement. The real
TUI measurement makes an approximately 170 ms observed bind target plausible,
not yet proven at population p95. It is the smallest design that preserves the
current no-reuse isolation rule.

A fully initialized reservation TUI can move more startup work before demand.
It also creates a reservation Session before activation. Blocking visible input
is necessary but insufficient. `--no-focus` prevents a focus change; it does
not prove that keyboard input, paste, a terminal writer, direct delivery, Task
delivery, startup hooks, extension callbacks, or tools cannot act. The input
barrier must be enforced at every ingress before bytes or work reach the
reservation Session.

Discarding the reservation Session is also not a simple file deletion. Before
productive activation, the system needs evidence that the reservation Session
has no live input handler, delivery subscription, tool authority, timer,
stream, Session binding, or extension-owned side effect. A later product
Session must receive a new exact Membership capability. Pi's documented
constructors do not provide a documented reset or sanitization guarantee for a
prior Session in the same process. Process-global imports and extension state
can remain after the reservation Session is discarded.

If the fully initialized TUI reuses its reservation Session, it becomes a full
Worker prewarm. It can only be safe for one immutable profile and one intended
Membership from its birth. It is not a generic pool slot. If it discards that
Session and creates a new product Session, the serialized critical path still
contains session quiescence and product Session construction. The relevant
lower bound is then:

`T(product) >= T(slot acquire) + T(activation commit) + T(reservation Session quiesce) + T(product Session construct/admit/bind) + T(input-gate release) + T(render or return)`

This expression applies when those phases serialize. Measure overlap rather
than assume it. The full-TUI design has no current latency evidence for this
path.

### Required refinement and decision rule

Model a reservation TUI separately from a no-Session launcher:

`cold -> booting -> sealed_reservation_session -> reserved -> activation_committed -> reservation_session_discarded -> product_admitting -> session_bound -> rpc_ready -> consumed -> reaped`

`sealed_reservation_session` must have no productive Worker authority. A durable
reservation records `slotId`, reservation-Session identity, bootstrap and
profile digests, intended Membership, and one-use `activationId`. The
`activationId` is the actuation fence. `pendingLaunchId` still fences only the
first productive Session binding. On every activation outcome, the reservation
TUI becomes consumed. It never returns to a general pool.

A 100 ms visible-TUI promise should not accept the fully initialized design
until it proves two facts. First, no pre-activation ingress or side effect can
mutate product authority. Second, reservation-Session disposal leaves no state
that can affect the product Session. If either proof needs process replacement,
the claimed latency advantage may disappear.

If the operator can accept an approximately 200 ms TUI bind objective, prefer
the single-use no-Session preloaded launcher. It preserves the established
fences and has observed real-TUI evidence. If a 100 ms terminal product is
non-negotiable, treat the sealed reservation TUI as a new architecture
experiment. Do not promote a hidden reusable Pi Session pool as a shortcut.

### Next tests

1. Collect paired traces from request arrival through TUI bind, idle observation,
   exact admission, RPC-ready, delivery-ready, and first turn. State each clock
   boundary and retain raw phase records.
2. Inject keyboard, paste, terminal-writer, direct-message, Task-delivery, and
   extension-startup inputs in every reservation state. Assert no pre-activation
   Session can bind a Membership, run a tool, or mutate Task authority.
3. Test reservation-Session discard for live listeners, timers, streams,
   persisted Session records, extension state, and process-global cwd or
   environment capture. Repeat across incompatible profiles.
4. Fault-inject lost reservation and activation replies. Assert one activation
   per `activationId`, no orphan TUI, and exact reaping before replenishment.
5. Measure no-Session and sealed-TUI pools under bursts, stockouts, and
   replenishment. Report hit rate and p50/p95/p99 for the declared product
   endpoint, not only an internal observer state.

The updated strongest claim is: the measured real product-facing path is about
170 ms at the observed sample p95, while the near-100 ms result is an internal
RPC-ready slice. The single-use no-Session launcher is presently the safer
choice. A fully initialized reservation TUI may reduce latency, but it changes
the isolation boundary and needs a separate, falsifiable capability and
teardown contract before it is a valid option.

## Addendum: preexisting pristine reservation Session

### New observation

The lead supplied a reservation experiment on 2026-08-14. A TUI command plus
`newSession` had reported p50 123.36 ms. Binding an already initialized empty
reservation Session had reported p50 8.92 ms at `n=5`. With a serialized new
Session on the product path, the 123.36 ms median already exceeds a 100 ms
objective. A preexisting Session is therefore necessary for that strict target,
but the 8.92 ms median is not sufficient evidence for it.

These are lead-delivered measurements. They contain no raw sample trace or p95
for the two new spans. Do not combine their p50 values, or subtract them from
other p95 values. The results only identify Session construction as a likely
critical-path cost and motivate a sealed-Session experiment.

### Refinement test

A preexisting reservation Session can theoretically refine Worker Session
creation, but only as a new internal state. It must not be treated as an
already-created Worker Session. The refinement preserves the current external
protocol only if no observable Worker authority exists before activation and
the current `prepared -> runtime claim -> session_bound -> verified` order
starts at activation.

Use this separate state machine:

`absent -> constructing -> sealed_session -> leased -> admitting -> session_bound -> gate_open -> consumed -> reaped`

`sealed_session` has an opaque reservation Session identity and one immutable
profile digest. It has no Membership, Task, Worker, delivery, provider, or tool
capability. `leased` durably binds that Session to one `slotId`, intended
Membership, and one-use `activationId`. The activation transaction creates the
prepared Membership and its `pendingLaunchId`, then lets only that leased
carrier enter normal runtime admission. `pendingLaunchId` fences the first
Session bind. `activationId` fences the external actuation and must survive a
lost reply. A Session can never leave `consumed` for another reservation.

The content invariant must be stronger than an empty transcript. Before
`gate_open`, it must show no user, assistant, Task, direct-message, tool, or
provider content; no model request; no tool execution; no compaction or branch;
and no delivery acknowledgement. It also needs a noninterference invariant:
pre-activation work can affect neither Task authority nor the productive
Session's behavior, except for an explicit immutable bootstrap/profile seed.
A content hash alone cannot prove that. Process-global imports, extension
factories, timers, listeners, provider clients, settings, cwd, and environment
can retain state without adding transcript content.

### Why input blocking is not enough

A hard input gate is required. It must reject keyboard, paste, terminal writes,
agent prompts, direct delivery, Task delivery, tool execution, provider calls,
and extension callbacks before they reach the sealed Session. Hiding the pane
or using no-focus behavior does not supply that gate.

The current Pi Team Bright adapter admits a normal Worker at Session start, then
starts direct and Task delivery after admission. Therefore, a preloaded Session
needs a distinct reservation mode that cannot run the normal admission or
delivery path before `activationId` is committed. A policy that merely promises
not to send input does not refine the current contract; a code-enforced
capability boundary might.

At activation, the gate must stay closed until exact Membership admission,
runtime write, Session bind, and authority verification succeed. It can then
open once. If any step fails, close the gate, burn the reservation, and reap the
exact process/PTY. Do not reset or reassign its Session.

### Safety choice and capacity consequence

The reservation Session can be safe only in a narrow, fixed-profile case if the
noninterference and gate invariants are mechanically tested. It cannot be a
generic warm Session pool. Reusing it for a different cwd, trust decision,
model, extension set, resource aggregate, or authority epoch violates the
profile boundary.

Pi's documented session constructors do not promise secure in-process Session
sanitization or teardown. Current source contracts also do not expose a sealed
reservation-Session lifecycle. Thus this is not an accepted safe optimization.
The honest present choice is the one-use no-Session launcher and its observed
164--174 ms TUI bind range, if the product can accept a roughly 200 ms goal.

If a 100 ms visible-TUI target remains mandatory, run the sealed-Session design
as a separate experiment. It must prove safety before its latency can justify
an architecture change. Pool capacity still obeys the warm-hit condition:
`P(slot hit) * P(product <= 100 ms | hit)` must approach at least 0.95 when a
miss cannot meet the target. A fast 8.92 ms bind does not help a stockout or a
reservation queue.

### Falsifiable tests

1. Trace Session construction, activation lease, `session_start`, runtime claim,
   Session bind, gate open, Task delivery, and first turn with one clock source.
   Record p50, p95, p99, and deadline misses at burst sizes 1, 2, 4, and 8.
2. Attempt every input and authority ingress while sealed. Assert no provider
   request, tool call, message delivery, Session bind, Task mutation, or
   extension side effect occurs before activation.
3. Compare the sealed Session's allowed bootstrap manifest and content state
   before and after activation. Test incompatible cwd, trust, model, extension,
   resource, and authority profiles in the same process.
4. Crash after lease creation, membership preparation, Session bind, gate open,
   and caller-reply loss. Assert one `activationId`, one Membership generation,
   no live orphan, and no slot reuse.
5. Test teardown explicitly. A discarded reservation must leave no listener,
   timer, stream, provider handle, session-store record, or privileged callback
   that can affect its successor.

The updated strongest claim is: a pristine single-use reservation Session is a
possible refinement only if it is a sealed, capability-less internal carrier
with a mechanically proven noninterference and teardown contract. The current
evidence does not establish those conditions. Until it does, the 164--174 ms
no-Session launcher is the honest safe product path.
