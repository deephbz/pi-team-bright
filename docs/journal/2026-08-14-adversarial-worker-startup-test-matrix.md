# Adversarial Worker startup test matrix

Date: 2026-08-14
Baseline source: `eea33edd6245b6088b7ab4111e52cb3ec8c2d001`
Scope: launch, admission, recovery, terminal carrier, resource projection,
delivery, and a proposed single-use preloaded launcher. No production code changed.

## Test classes

- **D**: deterministic Vitest test with injected clocks, process probes, and
  terminal adapters.
- **H**: disposable real Herdr canary. It proves pane, shell, and recognized
  agent behavior that an adapter double cannot prove.
- **P**: disposable real Pi Team canary. It proves Pi lifecycle-hook order,
  exact Session binding, Worker tool use, and delivery behavior.
- **X**: synthetic single-use preloaded-launcher probe. It can prove only its
  declared activation boundary. It cannot prove an interactive carrier or
  Worker readiness.

A D or X pass does not prove an H or P case. All H and P cases remain
untested in this audit. The Worker role cannot create or stop a disposable
Team.

## Matrix

| ID | Fault and required pass condition | Required test class | Current deterministic anchor | Baseline status |
| --- | --- | --- | --- | --- |
| S1 | A Session-bound event and startup observation can occur while `runtime.ready` remains false. Neither a launch receipt nor delivery proves readiness. | D + P | `runtime-startup-admission.test.ts`, `worker-startup-observation.test.ts`, `worker-identity-process-admission.characterization.test.ts` | **PASS-D; UNTESTED-P** |
| S2 | The child exits after pane creation but before first binding. Keep one prepared Membership, do not publish readiness, and retry only its unconsumed launch capability. | D + H + P | `worker-ensure-lifecycle.test.ts`, `launch-compensation.contract.test.ts` | **PARTIAL-D; UNTESTED-H/P**. It covers spawn and persistence faults, not a real child early exit. |
| S3 | A bound child exits after binding. Recovery keeps the Membership and Session, replaces only an absent PID generation, and refuses a live or unknown incumbent. | D + H + P | `runtime-startup-admission.test.ts`, `launch-compensation.contract.test.ts` | **PASS-D; UNTESTED-H/P** |
| S4 | Invalid model, unsupported terminal policy, malformed argv, and unavailable resource settings reject before carrier creation. | D + H + P | `launch-compensation.contract.test.ts`, `herdr-adapter.test.ts`, `worker-resource-projection.test.ts` | **PASS-D; UNTESTED-H/P** |
| S5 | A mixed-version coordinator and Worker must execute a compatible Task transition or return a typed reconciliation result. It must not strand an accepted legacy Task behind a legacy exception. | D + P | `task-surface-cleancut.e2e.test.ts` | **FAIL-P**. The homogeneous local graph E2E passes, but this Worker’s live claim twice threw `Legacy Task mutation is disabled on the graph-native Worker surface; apply a graph revision first.` |
| S6 | A stale Membership generation cannot write runtime state, bind a Session, publish an event, deliver work, or mutate a Task. | D + P | `team-session-lifecycle-service.boundary.test.ts`, `worker-identity-process-admission.characterization.test.ts`, `task-change-delivery.characterization.test.ts` | **PASS-D; UNTESTED-P** |
| S7 | A wrong, forked, or replaced Session cannot act as the current Worker. Exact Session recovery may act only for its current Membership. | D + P | `worker-team-binding.contract.test.ts`, `task-change-delivery.characterization.test.ts`, `message-delivery.test.ts` | **PARTIAL-D; UNTESTED-P**. Delivery checks pass, but the current Worker-tool binding test is stale and fails before its legacy mutation assertions. |
| S8 | A second active Membership with the same Worker name is rejected. Herdr carrier names remain unique across Teams with reused Worker names. | D + H | `release-p1-contract.test.ts`, `herdr-adapter.test.ts` | **PASS-D; UNTESTED-H** |
| S9 | Delayed `session_bound` publication never creates false startup observation. The event tuple and durable authority tuple must match before success. | D + P | `worker-startup-observation.test.ts`, `team-session-lifecycle-service.boundary.test.ts` | **PARTIAL-D; UNTESTED-P**. The suite covers authority delay after an event, not an event delayed after durable binding. |
| S10 | At zero and exact deadline, check authority once as specified. Return timeout without inferring readiness or progress. | D + P | `worker-startup-observation.test.ts`, `sync-liveness.test.ts` | **PASS-D; UNTESTED-P** |
| S11 | Cancellation propagates as cancellation, not timeout. After cancellation after carrier spawn, the carrier and Membership remain reconcilable. | D + P | `worker-startup-observation.test.ts` | **PARTIAL-D; UNTESTED-P**. The observer abort path passes; launch-bridge cancellation after spawn lacks a test. |
| S12 | A leader restart restores only its exact Session and branch baseline. It does not duplicate delivery or use another branch’s observation. | D + P | `pi-session-adapter.characterization.test.ts`, `sync-liveness.test.ts` | **PASS-D; UNTESTED-P** |
| S13 | Missing prepared and bound carriers recover through the correct mode. Bound recovery uses `--session`, the persisted model, and no launch capability. | D + H + P | `launch-compensation.contract.test.ts`, `worker-identity-process-admission.characterization.test.ts` | **PASS-D; UNTESTED-H/P** |
| S14 | Closing a Worker pane never falls back to the leader pane, moves another pane, or closes a whole workspace. Stop requires exact closure evidence. | D + H + P | `herdr-adapter.test.ts`, `terminal-backend.contract.test.ts`, `topology-lifecycle.contract.test.ts` | **PASS-D; UNTESTED-H/P** |
| S15 | Herdr forwards only allowed environment keys. It retries only `agent_pane_busy`; a real shell can start the required Pi binary and exact extension. | D + H + P | `herdr-adapter.test.ts`, `worker-resource-projection.test.ts` | **PARTIAL-D; UNTESTED-H/P** |
| S16 | A new Worker uses the resolved cwd, trust, and model precedence. Recovery uses the captured Membership cwd and model, not a changed leader setting. | D + H + P | `worker-resource-projection.test.ts`, `launch-compensation.contract.test.ts` | **PARTIAL-D; UNTESTED-H/P**. Model persistence passes, but no test changes the leader cwd or settings between launch and recovery. |
| S17 | Before durable Session binding, Worker model/tool actions cannot read, mutate, alert, start delivery, or mark runtime ready. | D + P | No exact pre-bind action test | **GAP-D; UNTESTED-P** |
| S18 | A new process cannot inherit old readiness, delivery acknowledgement, aggregate prompt, or leader-only tool state. Reload restores the Worker baseline. | D + P | `worker-resource-extension.contract.test.ts`, `task-delivery.test.ts`, `message-delivery.test.ts` | **PARTIAL-D; UNTESTED-P**. Reload and exact delivery fences pass; a real new-process recovery leak test is absent. |
| S19 | Concurrent `ensure_worker` calls make one carrier. The loser reuses the exact live carrier and removes only its unused aggregate. | D + H + P | `launch-compensation.contract.test.ts`, `topology-lifecycle.contract.test.ts` | **PASS-D; UNTESTED-H/P** |
| S20 | Stop and shutdown preserve nonterminal Task guards, require exact terminal-stop evidence, retain the lead on partial shutdown, and fence stale restart. | D + H + P | `team-lifecycle-service.boundary.test.ts`, `topology-lifecycle.contract.test.ts` | **PASS-D; UNTESTED-H/P** |

## Single-use preloaded-launcher extension

This is a proposed experiment, not a current baseline carrier. The inspected
`WorkerLaunchBridge` builds a normal Pi argv and spawns a terminal carrier; it
has no launcher slot, reservation, or activation record. Therefore, existing
startup tests prove only the generic admission contract.

Use these distinct terms in every launcher receipt:

- **RPC-ready**: the activation RPC returned its stated receipt.
- **connected**: authority verifies the exact Membership, `session_bound`
  Session, and runtime PID generation.
- **Worker-ready**: the child writes `runtime.ready=true` after a successful
  turn. RPC-ready and connected never imply this state.
- **reservation-TUI-ready**: a reservation interface can accept only
  reservation control. It is neither a Worker Session nor a model-ready UI.

The leader reported an X probe of ten preloaded activations. It reported exact
Membership, `session_bound`, runtime PID binding, and RPC-ready with p50
49.87 ms and p95 99.57 ms. Each sample had no Session before activation. This
is **PASS-X only for that declared connected/RPC boundary**. It does not prove
interactive TTY or Herdr behavior, profile parity, failure handling, cleanup,
delivery, or Worker-ready behavior.

The leader also reported a separate n=5 TUI probe: exact bind p50 164.42 ms
and p95 174.14 ms, with Herdr idle p50 273.12 ms. The reported admission and
name checks passed. These metrics have different boundaries and do not prove a
preinitialized reservation-TUI path, a common latency distribution, or an H/P
canary.

The leader then reported a separate comparison: an empty preinitialized TUI
Session binding command took about 9 ms, while a new-Session reset took about
123 ms. This is a speed signal, not a pristine-state proof. Direct adoption
stays rejected until every U check passes. One observed leak rejects the path.

| ID | Fault and required pass condition | Required test class | Current anchor | Baseline status |
| --- | --- | --- | --- | --- |
| L1 | A launcher receipt must expose RPC-ready, connected, and Worker-ready as separate timestamps and states. Only the exact authority tuple proves connected. A successful turn alone may set Worker-ready. | D + X + P | `team-session-lifecycle-service.boundary.test.ts`, `worker-identity-process-admission.characterization.test.ts`, `worker-startup-observation.test.ts` | **PASS-D for generic state separation; PASS-X for n=10 RPC-ready plus connected; GAP-D for a launcher receipt; UNTESTED-P** |
| L2 | Change `HOME`, `PI_CODING_AGENT_DIR`, cwd, trust/settings, and allowed environment sentinels between priming and activation. The activated child must use only its requested profile. Any pre-activation read must be proved profile-invariant or partition the slot. | D + X + P | `test/home-isolation.test.ts`, `worker-resource-projection.test.ts`, `extensions/pi-team-session-adapter.ts` | **GAP-D; UNTESTED-X/P**. No launcher bootstrap graph or import-capture differential test exists. |
| L3 | Replay one activation request and race a different request for the same slot. One activation may enter Pi main and bind one Session. The same operation gets its original receipt or typed in-progress result; another operation is refused. | D + X + P | `identity-p0-contract.test.ts`, `runtime-startup-admission.test.ts` | **PARTIAL-D**. `pendingLaunchId` is one-use for generic first binding, but no launcher activation identity or replay contract exists. **UNTESTED-X/P**. |
| L4 | A wrong or stale Membership, launch capability, reservation, or lease cannot activate a slot, bind a Session, write runtime, publish an event, or run a Worker tool. Revalidate the exact current Membership under its lease before activation. | D + X + P | `task-authority-team-port.test.ts`, `team-session-lifecycle-service.boundary.test.ts`, `runtime-startup-admission.test.ts` | **PASS-D for generic Membership and launch fences; GAP-D for launcher reservation; UNTESTED-X/P**. |
| L5 | A primed slot has no Pi Session, Task or Alert authority, delivery loop, model action, or Worker tool action. After activation but before binding, every Worker operation fails closed on exact Session proof. | D + X + P | `worker-identity-process-admission.characterization.test.ts`, `extensions/pi-team-session-adapter.ts` | **PARTIAL-D**. Generic delivery starts after binding and Worker calls resolve exact Session binding, but no test invokes a pre-bind launcher action. **UNTESTED-X/P**. |
| L6 | Inject a crash after runtime claim, after Session bind, after `session_bound` append, and after a lost RPC reply. Preserve one current Membership and at most one live PID generation. Recover a prepared child only after exact exit; recover a bound child only through its exact Session. | D + X + P | `runtime-startup-admission.test.ts`, `worker-identity-process-admission.characterization.test.ts`, `launch-compensation.contract.test.ts` | **PARTIAL-D**. Generic ordering and recovery pass, but no fault injection covers each launcher activation write boundary. **UNTESTED-X/P**. |
| L7 | Activation must use one direct, exact Herdr carrier. Its pane and recognized-agent name must identify the intended Team and Worker. It must not use, rename, move, or close a leader or foreign pane. | D + H + P | `herdr-adapter.test.ts`, `session-terminal.test.ts`, `terminal-backend.contract.test.ts` | **PASS-D for generic carrier ownership; GAP-D for launcher naming; UNTESTED-H/P**. |
| L8 | For two distinct profiles, warm activation must equal cold launch for cwd, trust, model, thinking, Worker aggregate, extension digest, and allowed tools. It must not inherit priming-process values. | D + X + H + P | `worker-resource-projection.test.ts`, `launch-compensation.contract.test.ts`, `worker-launch-bridge.ts` | **PARTIAL-D**. Cold resource and model resolution pass, but no launcher parity differential exists. **UNTESTED-X/H/P**. |
| L9 | Cancellation, activation failure, and shutdown consume the slot once. Cleanup stops and reaps only its exact PID and terminal target, removes only its owned aggregate, and records a retained recovery case when stop proof is absent. Never reset or reuse the process. | D + X + H + P | `launch-compensation.contract.test.ts`, `terminal-backend.contract.test.ts`, `topology-lifecycle.contract.test.ts` | **PARTIAL-D**. Generic launch compensation proves exact-target cleanup, but no launcher consume/reap contract exists. **UNTESTED-X/H/P**. |
| L10 | Report warm-hit and pool-miss latency as separate distributions. For each, record sample count, quantile method, p50/p95/p99, reservation wait, activation RPC, connected, Worker-ready, first delivery, miss or stockout rate, and exact cleanup result. If a reservation TUI exists, split preinitialized-reservation hits from new-Session fallback too. Do not merge populations. | X + H + P | Leader-delivered n=10 X probe | **PARTIAL-X**. The reported preloaded activation distribution supplies only the declared RPC-ready/connected boundary. There is no controlled warm-hit versus pool-miss comparison or H/P sample. |

### Preinitialized-reservation-TUI path

This is also a proposed experiment. A reservation TUI may exist before Worker
activation, but it must be a separate, disposable carrier. Its input, Session,
tools, profile, and activation token must never become implicit Worker state.

| ID | Fault and required pass condition | Required test class | Current anchor | Baseline status |
| --- | --- | --- | --- | --- |
| T1 | Before binding, reservation-TUI input must not enter a prompt, Session history, model run, Task/Alert tool, or delivery loop. The interface accepts only reservation control, rejects or discards other input, and does not replay it at activation. | D + H + P | `extensions/pi-team-session-adapter.ts`, `worker-identity-process-admission.characterization.test.ts` | **PARTIAL-D**. Generic Worker calls require exact Session binding, but no reservation-TUI input, tool, or model-block test exists. **UNTESTED-H/P**. |
| T2 | Default behavior discards any reservation Pi Session before activation. It must never bind a Membership, retain prompt or delivery state, or become the activated Worker's new Session. Direct adoption is prohibited unless U1--U8 prove a bounded pristine state. | D + H + P | `identity-p0-contract.test.ts`, `team-session-lifecycle-service.boundary.test.ts` | **GAP-D; UNTESTED-H/P**. Current Session recovery cannot prove discard or direct-adoption safety. |
| T3 | One reservation token starts one new Worker Session once. Concurrent activation, retry after a lost response, and cancellation return the original outcome or a typed refusal. They never reuse the reservation Session. | D + H + P | `identity-p0-contract.test.ts`, `runtime-startup-admission.test.ts` | **PARTIAL-D**. Generic first binding is one-use, but no reservation-TUI token or new-Session activation contract exists. **UNTESTED-H/P**. |
| T4 | A stale, wrong, or replayed reservation token cannot select a TUI, enter Pi main, bind a Session, write runtime, or affect a current Membership. Revalidate the exact reservation and Membership lease before new-Session creation. | D + H + P | `runtime-startup-admission.test.ts`, `task-authority-team-port.test.ts`, `team-session-lifecycle-service.boundary.test.ts` | **PASS-D for generic fences; GAP-D for reservation-TUI tokens; UNTESTED-H/P**. |
| T5 | Crash during new-Session creation, before bind, after bind, after event append, and after reply loss leaves one recoverable outcome. It retains no hidden reservation Session and never creates two live processes or Sessions for one Membership. | D + H + P | `worker-identity-process-admission.characterization.test.ts`, `launch-compensation.contract.test.ts` | **PARTIAL-D**. Generic ordering and recovery pass, but no new-Session TUI fault injection exists. **UNTESTED-H/P**. |
| T6 | Prime and activate with different HOME, agent directory, cwd, environment, trust, model, thinking, aggregate, and extension settings. The new Worker must match cold-launch profile resolution and reveal no reservation-TUI profile or input. | D + H + P | `test/home-isolation.test.ts`, `worker-resource-projection.test.ts`, `worker-launch-bridge.ts` | **PARTIAL-D**. Cold profile resolution passes, but no reservation-TUI isolation differential exists. **UNTESTED-H/P**. |
| T7 | Measure reservation-TUI-ready, exact connected, Worker-ready, and Herdr idle as separate phases. Split preinitialized-reservation hits from new-Session fallback, and report admission/name results with each distribution. | H + P | Leader-delivered n=5 TUI probe | **REPORTED ONLY**. Exact bind p50 164.42 ms/p95 174.14 ms and Herdr idle p50 273.12 ms; admission/name checks passed. No controlled preinitialized-reservation H/P canary ran. |

### Direct adoption of an empty reservation Session

This is an **unsafe-until-proven** alternative to T2. An empty-looking Session
is not necessarily pristine. The implementation must define every allowed
bootstrap entry and effect, then prove no other effect occurred. A zero entry
count alone is not proof. Any unexpected input, command, extension, message,
entry, model/provider call, shell action, reload state, token action, lease
mutation, or crash ambiguity rejects direct adoption and requires discard plus
a new Worker Session.

| ID | Fault and required pass condition | Required test class | Current anchor | Baseline status |
| --- | --- | --- | --- | --- |
| U1 | Before exact binding, send paste, API input, TUI controls, and terminal keys. Each must be ignored or discarded. None may enter Session history, start a model run, call a provider, or become later Worker input. | D + H + P | `extensions/pi-team-session-adapter.ts`, `worker-identity-process-admission.characterization.test.ts` | **GAP-D; UNTESTED-H/P**. No reservation-Session input boundary exists. |
| U2 | Load foreign commands and extensions before binding. The allowed bootstrap manifest must match exactly. A foreign command or extension must not add an entry, activate a Worker tool, execute a handler, or alter the activated Worker surface. | D + H + P | `extensions/pi-team-session-adapter.ts`, `worker-resource-projection.test.ts` | **GAP-D; UNTESTED-H/P**. No preinitialized-Session extension manifest or differential exists. |
| U3 | Queue direct, follow-up, and delivery messages before binding. Compare the full Session-entry sequence before and after activation. Only declared bootstrap entries may exist; no queued message may reach the adopted Worker. | D + H + P | `message-delivery.test.ts`, `task-delivery.test.ts`, `pi-session-adapter.characterization.test.ts` | **GAP-D; UNTESTED-H/P**. Existing delivery tests start only after exact binding. |
| U4 | Make model/provider selection and Bash execution fail loudly before binding. Direct adoption passes only when neither was called and no tool result, shell state, credential scope, or provider cache becomes Worker state. | D + H + P | `extensions/pi-team-session-adapter.ts`, `worker-resource-projection.test.ts` | **GAP-D; UNTESTED-H/P**. No pre-bind model/provider or Bash negative control exists. |
| U5 | Reload a reservation TUI before activation. It must discard the candidate or recreate an unbound reservation. It must not preserve input, queued messages, active tools, an activation token, or a Session relation that later binds a Worker. | D + H + P | `pi-session-adapter.characterization.test.ts`, `extensions/pi-team-session-adapter.ts` | **GAP-D; UNTESTED-H/P**. Existing reload behavior is for a bound Worker, not a reservation Session. |
| U6 | Replay an activation token, race another token, and use a stale Membership lease. At most one exact current Membership may bind one Session. Every stale or replayed request must leave the candidate Session and current Worker unchanged. | D + H + P | `identity-p0-contract.test.ts`, `runtime-startup-admission.test.ts`, `task-authority-team-port.test.ts` | **PARTIAL-D**. Generic launch and Membership fences pass, but no direct-adoption token contract exists. **UNTESTED-H/P**. |
| U7 | Crash after lease acquisition, during new bind, after binding, after event append, and after reply loss. Reconciliation must show either no adopted Session or one exact bound Session. It must never hide a usable stale reservation Session or duplicate PID generation. | D + H + P | `worker-identity-process-admission.characterization.test.ts`, `launch-compensation.contract.test.ts` | **PARTIAL-D**. Generic admission ordering passes, but no direct-adoption crash injection exists. **UNTESTED-H/P**. |
| U8 | Run the full pristine proof with two different profiles and a cold-launch control. Record the exact allowed-effect manifest and separate bind-command and new-Session-reset latency. The reported about-9 ms bind command cannot count as a pass until U1--U7 pass. | D + H + P | `test/home-isolation.test.ts`, `worker-resource-projection.test.ts`, Leader-delivered timing comparison | **REPORTED TIMING ONLY**. About 9 ms direct bind and about 123 ms new-Session reset; no pristine-state proof or controlled H/P canary exists. |

## Baseline evidence

Focused runs used a role-free test process. The extension reads `PI_*` role
variables at module load, so a test process that inherits this Worker’s live
role does not represent a clean test fixture.

- 54/54 passed: startup admission, startup observation, ensure planning,
  Session lifecycle boundary, and terminal placement.
- 14/14 passed: registered Pi Session lifecycle and identity/process-admission
  characterization.
- 59/59 passed: Herdr adapter, resource projection, terminal helpers,
  Team lifecycle boundary, and sync liveness.
- 60/60 passed: Pi Session adapter, Task delivery, Task-change delivery,
  direct Message delivery, and Team persistence.
- The graph-native Task E2E passed its complete apply, concurrent claim,
  stale-write, context, and derived-state case.
- The duplicate-current-member case passed.

One selected exhaustive run had 37 passing and 4 failing tests. The failures
are a current source/test contract mismatch:

1. `worker-resource-extension.contract.test.ts` expects legacy Worker
   `task_update` fields (`claim`, `status`, and `journal_entries`). The current
   graph schema exposes `transition` and `evidence`.
2. `worker-team-binding.contract.test.ts` expects `task_create` and legacy
   mutation semantics. The current surface exposes `task_graph_apply`, and a
   Worker rejects legacy mutation when no graph is present.

The live Task claim in this audit is the S5 mixed-version case. The coordinator
created the assigned Task through the legacy path, while this Worker exposes the
graph-native transition surface. A fresh `task_read` returned the card, but both
claim attempts failed before changing Task state. This is an observed runtime
integration failure, not a timeout. The homogeneous graph E2E does not prove
mixed-version compatibility.

The first role-contaminated run of the two Pi Session lifecycle files failed
8 assertions. The same files passed 14/14 after removing inherited Worker and
Herdr role variables. Preserve this as a test-harness condition: role-sensitive
extension tests need an isolated process or explicit environment setup.

`HERDR_ENV=1` was verified. Only `herdr agent list` ran. No pane, agent, Team,
or terminal surface was changed during this audit.

## Required canaries

Run these from a disposable exact-source leader after S5 has a compatible or
typed reconciliation path. Use one unique Team per canary, a supported Pi binary
configured in Herdr, an explicit Worker default model, and cleanup through exact
Worker stop then Team shutdown.

1. **Startup identity canary (P).** Apply one graph Task, ensure one Worker,
   observe `session_bound` while `ready` is false, then have the Worker claim
   and complete it. Assert one Membership, one Session, and one Task event
   sequence.
2. **Exit and recovery canary (H + P).** Test exit before binding, then close
   only a bound Worker pane after one completed turn. Verify first-binding
   retry and exact-Session recovery separately. Assert no duplicate Pi process,
   no changed Worker model or cwd, and no Task-authority read gates recovery.
3. **Resource and warm-state canary (H + P).** Start with trusted and untrusted
   Worker cwd settings. Reload, restart, and recover. Assert the captured
   model, trust flag, aggregate cleanup rule, Worker-only tool surface, and
   `ready=false` before the new process completes a turn.
4. **Race and shutdown canary (H + P).** Race two ensures, delay publication,
   cancel one observation, then test a guarded stop, pane closure, partial
   shutdown, and final shutdown. Assert one spawned carrier, no false readiness,
   no stale delivery acknowledgement, and no stale-process mutation.
5. **Single-use launcher canary (X + H + P).** Run separate warm-hit and
   pool-miss distributions. Use different test HOME, agent directory, cwd,
   trust, model, aggregate, and environment sentinels. Replay activation, use a
   stale lease, inject every L6 crash, and verify exact Herdr naming and owned
   cleanup. Report RPC-ready, connected, Worker-ready, and first delivery as
   separate phases.
6. **Reservation-TUI canary (H + P).** Start one disposable reservation TUI.
   Send pre-bind input, tool, and model actions; all must block or discard. Make
   a new Worker Session only after one exact activation, replay a stale token,
   inject each T5 crash, and verify Session discard, profile isolation, direct
   Herdr naming, and exact cleanup. Report every T7 phase separately. If direct
   adoption is evaluated, run U1--U8 first. One leak rejects it and requires
   discard plus a new Worker Session.

## Next test work

1. Define and test S5 mixed-version reconciliation, then update the two stale
   Worker-surface tests to graph-native terms before adding new cases.
2. Add a deterministic pre-bind action test for S17.
3. Add a deterministic cancellation-after-spawn test for S11.
4. Run the four real canaries and record their raw receipts outside public
   tracked content when they contain runtime identities.
5. Before implementing a launcher, define its durable slot, reservation,
   activation, consume, and reap records. Add the L1--L10 deterministic tests,
   then run the separate warm-hit and pool-miss canaries.
6. Before implementing a reservation TUI, define its separate carrier, token,
   Session-discard, new-Session, and crash-reconciliation records. Add T1--T7
   deterministic tests, then run the TUI canary.
7. Do not implement direct adoption for latency alone. First define the allowed
   bootstrap-effect manifest and add U1--U8 negative controls. One unexpected
   effect rejects direct adoption and restores T2 discard-plus-new-Session.

## Continuation

After this result, Task authority moved `ptb-worker-startup-opt-86i` to
`in_progress` at `v_8bb953942b72d919`. The lead recorded the mixed-version
recovery state. The matrix is complete, including L1--L10 for the proposed
single-use preloaded launcher, T1--T7 for the possible preinitialized
reservation-TUI path, and U1--U8 for unsafe-until-proven direct Session
adoption. It records the leader-delivered n=10 synthetic result, n=5 TUI
observation, and 9 ms versus 123 ms timing comparison. The next Worker action
is to re-read the Task, then close it with `goal_achieved` and this artifact as
evidence if the graph-native mutation path now accepts the current version.
