# Pi Team Bright semantic hardening

Updated: 2026-08-09
Stage: consolidation and hardening
Status: test hardening and audit documentation verified; production refactor has not started
Architecture impact: none until accepted code dependencies or depicted responsibilities change

## Outcome

Make current functional and non-functional behavior executable, classify each
behavior, and refactor toward five semantic subsystems without changing the
public surface. Preserve observable behavior by default. Handle each accepted
behavior change as a separate evidence-backed exception.

The durable handoff is
[`../../journal/2026-08-09-semantic-hardening-and-subsystem-audit-handoff.md`](../../journal/2026-08-09-semantic-hardening-and-subsystem-audit-handoff.md).
It owns the target decomposition, scope limits, completion criteria, and
behavior-change procedure.

Baseline source: `e55b4f2a9190d700a03d95cb9dee75e5c892ca0a`
Baseline package: `@hypercarrier/pi-team-bright@0.17.0-rc.8`
Baseline declaration receipt:
[`../../journal/artifacts/2026-08-09-semantic-hardening-baseline.json`](../../journal/artifacts/2026-08-09-semantic-hardening-baseline.json)

## Current status

- Worktree and branch exist from the exact baseline.
- The handoff, baseline receipt, test strategy, and 26-entry seed behavior
  inventory exist.
- Outside-in characterization tests, test support, and one exhaustive-lane entry
  now exist. No dependency, production code, public contract, or behavior has
  changed.
- The owner ended the redundant coordinator topology. The exact calling API
  Session now leads Team `semantic-hardening-direct`; only the watchdog remains
  a separate Pi agent.
- The registered-extension causal path covers public Task assignment, exact
  Session presentation, successful-turn acknowledgement, leader observation,
  cancellation, replay, restart, stale Membership, and delivery recovery.
- Independent review passed the corrected 18-test slice, typecheck, lane
  validation, JSON parsing, public-source hashes, and diff checks. COORD-002 and
  broad TRIO-004 coverage remain explicitly missing rather than overclaimed.
- Commit `ed7ae57` contains outside-in characterization only. Phase two adds
  COORD-002 and Alert publication-failure evidence plus the accepted-five-part
  [`subsystem audit`](subsystem-boundary-audit.md) and machine-operable
  [`dependency map`](subsystem-dependency-map.json).
- ALERT-004 records lost public recipient outcomes and duplicate delivery after
  event-publication failure and exact retry. It remains `unclassified`; no
  behavior change is authorized.
- Independent phase-two verification passes. Restart and later-presentation
  evidence for ALERT-004 and its owner classification remain open.
- Production refactoring has not started. Current blocker: none.

## Constraints still in force

- Keep public tools, schemas, package exports, and the observation protocol
  unchanged during structural refactoring.
- Preserve observable behavior by default. Isolate every accepted behavior
  change in its own evidence-backed Task and commit.
- Tests first characterize behavior. Owner classification decides which tests
  become normative, remain compatibility evidence, or change deliberately.
- Keep Team, Task, Alert, coordination observation, and trio-projection
  ownership distinct. Keep Membership observation additive and core-independent.
- Workers do not commit. The leader integrates one stable tree and creates the
  phase commits.
- Run focused tests during iteration. Run the aggregate release lane once after
  the exact final tree is stable.
- Do not add a dependency until one named behavior class proves the need.

## Herdr control and watchdog

Herdr is the terminal recovery surface, not Team or Task authority. Installed
CLI help is the command source of truth. Require `HERDR_ENV=1` before control.

- Query before control: start with `herdr agent list`, then use `agent get` and
  `agent read --source recent-unwrapped` for the exact unique agent name.
- The exact calling API Session is the direct Team leader and Herdr names it
  `ptb-semantic-direct-leader`. The independent watchdog is named
  `ptb-leader-watchdog` in a separate workspace. It resolves the leader's exact
  Session and pane at runtime; re-query IDs after a restart or move because IDs
  can change.
- The watchdog checks every 600 seconds. It treats one quiet interval and an
  `unknown` state as uncertainty. It declares a stuck turn only after two full
  quiet intervals with no agent, terminal, Task, Git, context, or journal
  progress.
- For a proven stuck turn, the watchdog reads the pane, sends one canonical
  Escape, waits, and prompts the coordinator to resume from this context and the
  journal. It restarts only after process absence is proven, in the same pane,
  through `_codex_with_proxy` with `openai-codex/gpt-5.6-terra:medium` and the
  exact coordinator Session.
- Use `agent prompt` for recognized agents and `pane run` only for a shell. Do
  not focus, move, or close unrelated panes. Never stop the Herdr server during
  this Project.
- Normal Team supervision remains Task-first through `team_sync`. The watchdog
  is an exceptional coordinator-process recovery mechanism and never mutates
  Team or Task state.

## Commit sequence and gates

1. **Outside-in characterization.** Add the first causal-path harness and tests.
   Commit only when the tests pass against the unchanged baseline implementation.
2. **Test hardening and learned documentation.** Improve deterministic seams,
   inventory links, failure diagnostics, and lessons learned. Commit with no
   subsystem refactor.
3. **Target subsystem refactor.** Change dependencies and ownership while the
   accepted characterization suite stays green. Keep public behavior stable.
4. **Optimization series.** Use one focused commit per code-quality improvement,
   issue fix, non-functional optimization, accidental-complexity removal, or
   small local refactor. Each commit needs one named risk, focused evidence, and
   no unrelated cleanup.

## High-level TODO

- [x] Launch the direct-leader Team and assign durable Tasks.
- [ ] Expand the seed behavior inventory into rules and meaningful outcomes.
- [ ] Implement the deterministic Pi trigger/turn harness.
- [x] Commit outside-in characterization.
- [x] Record lessons, harden tests, and commit test/docs improvements.
- [ ] Ratify current-to-target dependency changes.
- [ ] Refactor to the five-subsystem target and commit.
- [ ] Run bounded quality and optimization Tasks, one commit each.
- [ ] Run final independent runtime, package, and aggregate verification.
- [ ] Curate this context, append the journal, and write the final assessment.

## Behavior inventory coordinates

The machine-operable seed is
[`behavior-inventory.json`](behavior-inventory.json).
It is deliberately incomplete and keeps every initial behavior unclassified.

Give each behavior a stable identifier. Record these coordinates before adding
or accepting its permanent test:

- owning subsystem;
- motivating situation and actor Role;
- trigger or public operation;
- authoritative pre-state and required inputs;
- successful, refused, partial, cancelled, and unknown outcomes;
- committed state changes and prohibited state changes;
- ordering and timing meaning;
- delivery, observation, acknowledgement, retry, and restart meaning;
- concurrency and idempotency meaning;
- compatibility and historical-record scope;
- machine record, agent projection, and human/TUI projection;
- current classification and owner decision;
- deterministic test, real-runtime anchor, and reversal evidence.

The first inventory is discovery evidence. Exact accepted schemas and state
transitions move into executable types, public registrations, implementations,
and tests as they stabilize.

## Test ladder

Use the cheapest layer that can expose the risk. Keep adjacent layers for claims
that one layer cannot prove.

1. **Pure semantic tests** cover types, state transitions, refusal, projection,
   ordering, and deterministic time. They have no filesystem or process.
2. **Component characterization tests** call one subsystem through its public or
   application-facing boundary with in-memory authority and harness ports.
3. **Deterministic integration tests** use isolated temporary homes, real files,
   Beads where required, controlled clocks, barriers, and injected failure
   points. They restart components against the same records.
4. **Process and terminal contract tests** use child processes and real supported
   backends. They verify generation fencing, kill/stop evidence, environment,
   process death, and resume behavior.
5. **Published-interface tests** load the real extension, package export, command,
   or packed artifact. They prove role-visible tools, triggers, raw results,
   trio projections, and package compatibility.
6. **Differential and performance tests** compare the released baseline with the
   refactored tree, then measure latency distributions, amplification, lock wait,
   trigger-to-presentation delay, restart cost, and projection size.

A test can start as characterization and later become normative. If the owner
accepts better behavior, retain the old observation, replace the old expectation
explicitly, and add the new normative rule. Never weaken a test only to make a
refactor pass.

## Existing useful test infrastructure

The repository already has Vitest 4, worker-isolated temporary homes, fake-timer
coverage, deterministic Promise barriers, real multi-process lock tests, real
Beads integration lanes, public observation fixtures, model/TUI projection QA,
packed-artifact verification, and explicit fast/exhaustive/full lanes.

Reuse these capabilities before adding dependencies. Current wall-clock sleeps,
source-text assertions, exact command-count assertions, and broad contract files
need review: preserve their semantic intent, but do not promote the mechanism
itself into product behavior without evidence.

## Candidate tooling

Adopt a tool only after one behavior class proves the need.

- **Vitest fake timers plus injected `Clock` and `Scheduler` ports** for deadlines,
  polling cadence, cancellation, trigger order, and retry without real sleeps.
- **Small typed barriers and failpoints** for commit-before-publication,
  delivery-before-acknowledgement, process-binding, and lock interleavings.
- **TypeBox validation and curated JSON corpora** for malformed, oversized,
  stale, mixed-version, and privacy-sensitive records.
- **Node child-process harnesses** for crash, restart, PID, lock, filesystem, and
  real CLI behavior.
- **`fast-check`** if state-machine and property coverage finds cases that an
  explicit semantic matrix cannot cover economically.
- **Stryker mutation testing** after the normative suite stabilizes, to find
  assertions that execute code without detecting wrong behavior.
- **dependency-cruiser or an equivalent import-graph check** after target ports
  exist, to prevent dependencies from drifting across subsystem boundaries.
- **V8 coverage** as a gap locator only. Never use its percentage as the
  correctness claim.
- **Tinybench or the existing semantic trace/benchmark harness** for repeatable
  non-functional comparisons. Keep correctness oracles separate from timing.

Do not add a general mocking framework, broker, container platform, or chaos
library before a concrete invariant requires it.

## Hard behavior and test solutions

### Pi trigger and successful-turn acknowledgement

A mock callback proves only that code asked Pi to deliver. It does not prove that
the exact Session received the record or that a successful model turn observed
it.

Use a deterministic Pi harness that records queued custom messages, context
projection, persisted Session entries, turn result, and acknowledgement. Then
run a small real headless Pi canary against the same causal scenario.

### Crash and partial commit

An exception mock cannot prove recovery after process death because destructors
and in-memory cleanup can still run.

Add named failpoints around each durable boundary. Run the mutation in a child
process, terminate it at the failpoint, start a new process against the same
home, and compare recovered authority and delivery records with an independent
oracle.

### Concurrency and lock ordering

Random stress can expose a race but cannot reproduce or prove an interleaving.

Use barriers to force selected interleavings, model expected states, and retain a
smaller real multi-process stress lane. Generate pairwise operation schedules
only when each schedule has a clear oracle.

### Timeouts, polling, and latency

Wall-clock tests are slow and flaky, while fake clocks alone cannot prove real
performance.

Use injected monotonic clocks and schedulers for semantic deadlines. Use real
benchmarks for latency distributions and amplification. Never use a benchmark
threshold as the semantic timeout contract.

### OS process evidence and PID reuse

A unit test cannot reproduce every kernel, permission, or PID-reuse condition.

Put PID probing behind a narrow port. Exhaust its result algebra in deterministic
tests, then run subprocess canaries for live, exited, permission-denied, replaced,
and concurrently claimed generations on supported platforms.

### Terminal backends

A mocked command proves argv and response handling, not pane topology or stop
evidence. GUI terminals are also unavailable on ordinary CI workers.

Run one shared adapter contract suite against every backend. Add real Herdr and
tmux canaries in normal CI where available. Use platform-specific or self-hosted
canaries for GUI backends. Report unsupported or unknown evidence explicitly;
never turn missing infrastructure into success.

### Beads and external writers

An in-memory Task port cannot prove Beads metadata, Dolt identity, CLI timeouts,
or races with a writer outside Pi Team Bright.

Keep semantic Task tests independent of Beads. Add focused real-Beads tests with
concurrent external `bd` writers, exact workspace fingerprints, subprocess
failure, and post-state reads from an independent authority instance.

### Historical and mixed records

Handwritten fixtures can miss combinations that released versions produced.

Build an immutable, privacy-reviewed corpus from each supported release epoch.
Run current readers and migrations over every fixture, then add generated
malformed variants around each accepted schema boundary.

### Trio-projection parity and privacy

Snapshots can approve three outputs that are individually plausible but mutually
contradictory or overexposed.

Generate machine, agent, collapsed TUI, and expanded TUI views from one raw
semantic result. Assert shared facts, audience allowlists, required recovery
coordinates, forbidden sensitive markers, and round-trip schema validity.
Snapshots remain a review aid, not the parity oracle.

### Model interpretation

Deterministic tests can prove schemas and information presence, not that every
model will understand a tool description correctly.

Keep deterministic agent-surface checks, then run a small versioned model-eval
corpus against real supported models. Store prompts, tool catalogs, model/provider
versions, raw decisions, and human labels. Treat the result as external evidence,
not a unit test.

## First implementation slice

1. Freeze public tool, package-export, observation-schema, and test-lane baselines.
2. Create the behavior inventory with stable IDs and links to existing tests.
3. Build one reusable deterministic Pi trigger/turn harness.
4. Characterize one end-to-end causal path: accepted Task assignment -> exact
   Session presentation -> successful-turn acknowledgement -> leader
   `team_sync` observation, including timeout, cancellation, restart, duplicate,
   stale Membership, and delivery failure.
5. Classify the observed behaviors with the owner before changing structure.
6. Use that path to expose the first safe subsystem seam. Do not start with a
   directory move.
