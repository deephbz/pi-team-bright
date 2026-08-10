# Pi Team Bright semantic hardening journal

Append-only historical evidence for the semantic-hardening Project. Current
goals, decisions, status, blockers, and next steps live in
[`context.md`](context.md). Do not rewrite prior entries when understanding
changes; append a correction.

## 2026-08-09T14:34:04Z — baseline and test architecture prepared

- Created branch `audit/semantic-hardening-behavior-inventory` from
  `e55b4f2a9190d700a03d95cb9dee75e5c892ca0a` in a separate worktree.
- Copied the ratified semantic-hardening handoff into the worktree.
- Recorded the `0.17.0-rc.8` declaration baseline, package exports, public tool
  names, observation schema, compatibility ranges, test-lane count, and source
  digests in
  [`../../journal/artifacts/2026-08-09-semantic-hardening-baseline.json`](../../journal/artifacts/2026-08-09-semantic-hardening-baseline.json).
- Created a 26-entry machine-operable behavior-inventory seed covering the five
  core subsystems plus the additive Membership observation component. Every
  entry remains unclassified and has no claimed test state.
- Counted 72 test files and approximately 539 `it`/`test` calls by static source
  search. This is wayfinding evidence, not a coverage claim.
- Reviewed current test infrastructure: Vitest fast/exhaustive/full lanes,
  isolated temporary homes, fake timers, Promise barriers, subprocess lock
  races, real Beads tests, projection QA, and package verification.
- Proposed a six-level test ladder and bounded candidate tools. No dependency
  was added.
- Validation: both new JSON artifacts parsed; behavior IDs were unique; Git
  whitespace checks passed.
- No production code, public contract, dependency, or test changed. No test
  suite ran because this step only prepared planning and evidence artifacts.

## 2026-08-09 — owner commit and continuity decisions

- The owner authorized an end-to-end Team effort led for the next work period.
- Required commit order:
  1. outside-in characterization;
  2. test hardening and documentation from lessons learned;
  3. refactor to the accepted subsystem target;
  4. one commit for each later quality improvement, issue fix, non-functional
     optimization, accidental-complexity removal, or small local refactor.
- The owner required one curated `context.md` and one append-only `journal.md` so
  the Project survives context compaction and Session replacement.
- Team creation remains pending. The required coordinator must run through
  `_codex_with_proxy` with `openai-codex/gpt-5.6-terra:medium`, inherit the proxy
  environment, and prove Worker execution through a Worker-authored Task event.

## 2026-08-09 — Pi 0.84 footer crash and recovery observation

- The prior coordinator reported that `team_create` committed before a Pi 0.84
  footer crash.
- The replacement coordinator ran in the isolated compatible rc.9 Pi config and
  verified `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` in its own tool child.
- Its first required `team_sync({ view: "snapshot" })` returned
  `no_active_team`: the exact replacement leader Session is not bound to an
  active Team.
- This is recovery evidence, not proof that the committed Team is absent. No
  duplicate Team, Worker, Task, or manual Session fallback was created.
- Next action: obtain explicit owner authorization for the documented stale-Team
  rescue procedure, or resume the exact bound leader Session. Only then create
  assigned Tasks and wait for a Worker-authored Task event.

## 2026-08-09 — exact rc.8 coordinator recovery

- The exact leader Session resumed through the untracked temporary rc.8 runtime
  with only a Pi 0.84 footer compatibility method.
- `team_sync({ view: "snapshot" })` found active Team `semantic-hardening` with
  no Workers and no Tasks. This confirms the committed Team authority.
- The temporary runtime is operational recovery infrastructure. It is not a
  product change and will not enter a Project commit.
- Stable Workers `causal-path`, `independent-verifier`, and `boundary-refactor`
  were created and received assigned Tasks.
- `causal-path` authored a Task progress event after atomic claim. It recorded
  the delivery, exact Membership/Session, acknowledgement, and `team_sync`
  boundaries. This is the required end-to-end Worker launch proof.

## 2026-08-09 — Team closed for direct-leader transfer

- The owner corrected topology: the API Session will lead directly; only the
  watchdog stays separate.
- All three Workers received a stop-and-handoff request. Two carriers had
  already failed; the causal-path Task retained its Worker-authored mapping.
- The leader recorded transfer blockers, closed all Tasks for shutdown, stopped
  all Workers, and reconciled zero nonterminal assignments. No Project commit
  or accepted implementation resulted from this Team.

## 2026-08-09 — Herdr watchdog and coordinator kickoff

- Verified `HERDR_ENV=1` and queried Herdr agents and workspaces before control.
- Created a separate unfocused Herdr workspace for one watchdog Pi agent.
- Started the watchdog through `_codex_with_proxy` with
  `openai-codex/gpt-5.6-terra:medium` and named it `ptb-leader-watchdog`.
- Created a second unfocused Herdr workspace for the Project coordinator, started
  it through the same required proxy/model boundary, and named it
  `ptb-semantic-leader`.
- Prompted the coordinator with the ratified scope, commit gates, continuity
  rules, Team protocol, first causal test path, verification requirements, and
  no-publish boundary. Herdr observed the coordinator enter `working` state.
- Gave the watchdog one bounded job: check coordinator progress every 600
  seconds, require two quiet intervals before declaring a stuck turn, interrupt
  once with Escape, and resume the exact coordinator Session only after process
  absence is proven. The watchdog must not mutate Team, Tasks, Git, or Project
  files.
- Added the Herdr query, control, and recovery procedure to `context.md`.
- Team creation and Worker-authored Task evidence remain pending at this entry.

## 2026-08-09 — coordinator footer crash and continuation state

- The proxy-launched Terra coordinator called `team_create`; the Team
  `semantic-hardening` committed before Pi exited from the rc.8 Team footer on
  Pi 0.84. The missing runtime method was
  `modelRuntime.isUsingSubscription`.
- The watchdog proved the Pi process had exited and resumed the exact coordinator
  Session. Reusing the global rc.8 package reproduced the footer crash.
- An isolated Pi configuration under `/tmp` was prepared with private auth
  linked without reading it. It successfully ran the required model through
  `_codex_with_proxy` and loaded the compatible rc.9 coordination package.
- The resumed exact Session no longer crashed, but rc.9 fenced the Team epoch
  created by rc.8. Its first `team_sync` snapshot returned `no_active_team`.
  No Worker or assigned Task has produced launch evidence.
- Do not perform stale-Team rescue without explicit owner authorization. The
  preferred next attempt is an untracked temporary copy of the exact rc.8
  baseline with only rc.9's known Pi 0.84 footer compatibility method added.
  Resume the same Session through the isolated Pi configuration, reconcile the
  rc.8 Team with a snapshot, then create Workers and Tasks.
- Before any restart, prove the prior coordinator process is absent. Never start
  a duplicate. After recovery, rename the Herdr agent
  `ptb-semantic-leader`, correct the watchdog recovery command to the compatible
  rc.8 temporary runtime, and require a Worker-authored Task event.
- Known footer compatibility change: add
  `modelRuntime.isUsingSubscription(provider)` beside `isUsingOAuth`; return
  true only when the current model provider matches, OAuth is active, and the
  provider OAuth record has `isSubscription === true`.

## 2026-08-09 — direct leader kickoff

- The owner removed the redundant coordinator topology. Its Team closed cleanly,
  all three temporary Tasks became terminal, all Workers stopped, and its Pi
  process exited without a commit.
- The exact calling API Session verified its inherited proxy environment and
  created Team `semantic-hardening-direct` as leader.
- Stable Workers received executable Tasks for causal-path characterization,
  deterministic outside-in harness support, independent verification, and the
  full subsystem-boundary audit.
- `team_sync` observed Worker Task claims and assignment events. The first phase
  remains tests and durable evidence only; production code and public surfaces
  remain outside its scope.
- The watchdog now monitors the direct leader's exact Session. It must not create
  a separate coordinator or mutate Team, Tasks, Git, or Project files.

## 2026-08-09 — first outside-in causal Task-delivery characterization

- Replaced the initial anchor-only causal inventory check with a registered-
  extension characterization. The test invokes public `task_create`,
  `task_read`, and `team_sync` tools, drives Pi lifecycle hooks, uses a real
  fsync-backed Beads authority, inspects durable delivery records, and asserts
  the `display=true` steer presentation intended for the TUI.
- The primary journey now spans one public assigned Task, one exact current
  Membership/Session delivery record, one terminal-visible custom message,
  context observation, one successful-turn acknowledgement, unchanged Task
  status, and one leader `team_sync` snapshot. Exact Task ID and opaque version
  agree across every stage.
- Public create replay returned the same Task and caused no second delivery or
  presentation. A same-Session extension restart with presentation and
  acknowledgement entries caused no replay.
- A deterministic clock seam shortened only the built-in 120-second
  `team_sync` wait. Current rc.8 behavior returns a successful empty `updates`
  result with no timeout discriminant. Signal cancellation instead returns
  `cancelled` with `observation_advanced=false`; a later Task remained visible.
- A stale Membership/Session received no presentation and its startup was
  refused. The replacement exact Session reconstructed a generation-specific
  delivery from Task authority. The stale record remained historical machine
  evidence.
- An injected atomic delivery-spool rename failure left the Task committed,
  returned a public delivery warning, exposed no partial spool, wrote one
  canonical recovery record, and presented the Task after the exact Worker
  Session started. The warning on stderr was expected fault evidence.
- Updated `src/utils/causal-path.inventory.json` so every covered scenario names
  the outside-in test as its primary anchor. Internal delivery and port tests
  remain supporting anchors with explicit proof limits. Updated behavior
  inventory entries `TEAM-003`, `TASK-006`, `COORD-002`, and `COORD-003` to
  `characterized`; their owner classification remains deliberately
  `unclassified`.
- Added `src/utils/causal-path-characterization.test.ts` to the exhaustive-only
  lane because its four runtime cases use real Beads and take about 21 seconds.
- Final focused evidence in the Project worktree:
  `npx vitest run src/utils/causal-path-characterization.test.ts --config
  vitest.full.config.ts --pool=forks --reporter=verbose` passed one file and all
  five tests in 22.03 seconds; `npm run typecheck` passed; `npm run test:lanes`
  reported 74 files, 55 fast, and 19 exhaustive before the final source-only
  type correction, and its manifest input did not change afterward; both JSON
  inventories parsed and `git diff --check` passed.
- Setup evidence: the writable worktree initially had no `node_modules`, so the
  first test and typecheck commands failed before test execution. `npm ci
  --ignore-scripts` installed disposable dependencies. The first focused retry
  skipped real-Beads cases because the owned binary was absent; `npm rebuild
  @beads/bd` materialized Beads 1.1.0. Typecheck then found one optional
  Membership-ID narrowing error, which was fixed before the passing run.
- Coordination correction: before the worktree-boundary Alert arrived, the
  Worker accidentally created its new test, inventory, and one lane entry in
  the original checkout. It reported this to `team-lead`, removed only those
  three changes, verified the original lane manifest matched Git, and recreated
  the work solely in the writable worktree. No production file or pre-existing
  untracked journal in the original checkout changed.
- Explicit gap: this is a genuine registered public-tool and Pi runtime-hook
  characterization, but not a real Pi subprocess or rendered-terminal receipt.
  It proves `display=true` custom-message intent and steer actuation, not pixels
  or model interpretation. It also does not kill a Worker process, measure
  latency, or exercise concurrent replacement during acknowledgement.
- Architecture impact: **none**. No production code, schema, export, dependency,
  or public behavior changed.

### Verification addendum

- Re-ran `npm run test:lanes` after the final source correction: 74 files, 55
  fast, and 19 exhaustive. Re-parsed both inventory JSON files, re-ran
  `git diff --check`, and verified the three accidental original-checkout
  changes remained absent.
- The leader's first combined focused run exposed two new assertions that
  expected an explicit `undefined` acknowledgement field. Persisted JSON omits
  that field. A correction now asserts the stable delivery ID and field absence.
- The corrected combined run passed three files and 18 tests. `npm run
  typecheck` and `git diff --check` also passed.

## 2026-08-09 — independent characterization review blockers resolved

- Independent review rejected the initial timeout shortcut because replacing the
  120-second timer with zero proved only the result shape. The replacement uses
  a controlled scheduler barrier at the registered extension boundary. It
  records the requested `120000` ms delay, proves the `team_sync` Promise is
  still pending before the captured deadline callback, releases that callback,
  and then observes the successful empty `updates` result. Cancellation and the
  later visible Task change remain in the same test.
- The first barrier attempt used 200 `setImmediate` turns as a readiness bound.
  Real Beads setup did not reach timer registration within that CPU-turn count,
  so the assertion failed and cleanup exposed an expected in-flight authority
  error. The final barrier waits on explicit timer-registration evidence with a
  separate 20-second failure guard; it adds no sleep to the semantic path.
- Corrected behavior inventory entry `COORD-002` from `characterized` to
  `missing`. This slice establishes and acknowledges a snapshot before updates,
  but it does not assert updates-before-snapshot refusal or exact branch-lineage
  behavior. The causal inventory now states this proof limit.
- Used `captureTrioProjection` on the real registered `task_read` tool after the
  acknowledged delivery. The raw machine batch, singleton model JSON, collapsed
  TUI, and expanded TUI agree on Task ID, status `open`, assignee `worker`, and
  opaque version. This is one successful `task_read` projection case only.
  `TRIO-004` remains `missing`; no broad parity, privacy, failure-variant, or
  malformed-result claim was added.
- Final exact combined command passed three files and 18 tests in 23.69 seconds:
  `npx vitest run --config vitest.full.config.ts --pool=forks
  src/utils/causal-path-characterization.test.ts
  src/utils/delivery-round3.test.ts test/support/external-harness.test.ts`.
  `npm run typecheck` passed. `npm run test:lanes` reported 74 files, 55 fast,
  and 19 exhaustive. Both inventory JSON files parsed and `git diff --check`
  passed.
- Architecture impact: **none**. No production code, dependency, export, public
  schema, or public behavior changed.

## 2026-08-09 — outside-in characterization accepted for commit

- Independent verification reran the corrected three-file, 18-test slice and
  accepted its regression sensitivity and stated proof limits.
- Typecheck, lane validation, JSON parsing, public-source baseline hashes, and
  `git diff --check` passed independently. The lane manifest reports 74 files:
  55 fast and 19 exhaustive.
- The characterization commit excludes the later subsystem-boundary audit. Its
  selected content is tests, test support, machine-operable inventories,
  baseline and continuity artifacts, and the exhaustive-lane declaration.
- No production, dependency, public schema, export, or default behavior changed.

## 2026-08-09 — test hardening and subsystem-audit evidence

- Phase two starts from characterization commit `ed7ae57` and changes tests,
  inventories, and Project documentation only.
- COORD-002 now has a registered-extension case. Updates before an acknowledged
  snapshot require a snapshot without position advance. Exact result persistence
  on the active branch enables updates; absent persistence replays the pending
  result; acknowledged lineage mismatch requires a new snapshot.
- Alert publication failure is now executable through real `alert_send`, Beads,
  Membership, inbox, Task, and event records. One delivery can commit before
  event publication fails. The public result then loses accepted and refused
  recipients, the cursor does not advance, and Task state stays unchanged.
- Exact retry after publication recovers creates a second accepted delivery with
  a new Alert identity. Only the retry Alert reaches the event journal. Inventory
  entry ALERT-004 records this behavior as `characterized` and `unclassified`;
  no owner decision yet calls it intended or defective.
- The subsystem audit and machine dependency map separate current facts,
  assessments, risks, unresolved gates, and proposals. The target source graph
  is acyclic: consumer-owned cross-authority interfaces stay in their consumers,
  while composition adapters call provider query ports.
- The leader's focused phase-two run passed two files and seven tests. Typecheck,
  lane validation, three JSON parses, and `git diff --check` passed.
- Independent review measured the real-Beads Alert test at 18.54 seconds, so it
  moved to exhaustive-only. The corrected lane manifest reports 75 files: 55
  fast and 20 exhaustive. Review also found and fixed one local inventory link.
- Final independent recheck passed both test files, typecheck, lane validation,
  JSON and Markdown-link checks, evidence-path checks, target-graph checks,
  public-source hashes, and `git diff --check`.
- Architecture impact remains **none**. These artifacts propose dependency
  changes but do not yet change accepted production responsibilities or source
  dependencies.

## 2026-08-09 — first Task-authority dependency seam implemented

- Closed implementation Task `semantic-hardening-direct-2el` moved Task update
  and journal types into `src/task-authority/contracts.ts`, added the Task-owned
  `TaskReconciliationQuery`, implemented its Team-scoped Beads adapter in
  `src/task-authority/beads-reconciliation-query.ts`, and injected it from
  `extensions/index.ts` into `TaskChangeDelivery`.
- `src/model-tool-contract/in-memory-team-port.ts` retains temporary type
  re-exports for `ModelToolTaskUpdateInput` and
  `ModelToolTaskJournalEntry`. `TaskCard` and `TaskVersionRef` remain at their
  existing canonical paths. No package export or public tool surface changed.
- `src/utils/task-delivery.ts` no longer imports the Beads Task or authority
  adapters dynamically. The production static import graph remains acyclic, so
  the hidden dynamic reconciliation cycle is removed without creating a static
  file cycle. Concrete Task mutation publication still depends on Team,
  Coordination, and delivery implementations.
- Closed independent Task `semantic-hardening-direct-hkp` added four
  deterministic equivalence tests. They preserve self-authored suppression,
  later external changes, owner-marker recovery, exact replacement binding,
  delivery-ID deduplication, recovery replay, and metadata-gap refusal. Source
  fences reject the former Beads-adapter and in-memory-port edges.
- The accepted Task records report focused tests and typecheck passed. This
  documentation Task did not rerun implementation tests or change production or
  test source.
- `TASK-RECONCILIATION-INJECTION` is closed. Alert publication-failure owner
  classification, restart, and later-presentation evidence remain open. The
  Team, Alert, Coordination, Trio, additive Membership-observation, and
  remaining Task publication migrations are not complete.
- Updated the maintained Project context, audit, machine dependency map, and
  repository evergreen source map. JSON parsing, local Markdown-link checks,
  dependency-map assertions, and `git diff --check` passed.
- Architecture impact is **changed** for the internal Task dependency boundary.
  HyperCarrier's canonical diagram stays unchanged because it keeps Pi Team
  Bright internals opaque. No commit was made.

## 2026-08-09 — Task-authority refactor independently accepted and integrated

- Independent verification accepted the exact 18-path phase-three boundary after
  three provenance corrections. Phase-two Alert and Coordination evidence now
  stays separate from phase-three Task reconciliation evidence, the machine map
  keeps the exact review baseline, and the maintained evergreen date is current.
- Final independent evidence passed 32 focused Task tests, seven causal and Alert
  characterization tests, three targeted real-Beads tests, typecheck, package
  verification, test-lane validation, AST dependency checks, public agent-surface
  comparison, JSON and link checks, and `git diff --check`.
- The AST scan found 62 production files, 18,225 lines, 213 unique local static
  edges, no nontrivial strongly connected component, and no dynamic import.
- The leader staged only the accepted 18 paths. The privacy gate passed, and the
  refactor entered branch history as `refactor: isolate Task authority
  dependencies`.
- This commit implements one narrow internal Task reconciliation boundary. It
  does not claim that Task publication, Team, Alert, Coordination, Trio, or the
  additive Membership-observation boundary is complete.

## 2026-08-09 — Million Eyes quality review and first optimization

- A seven-lens Million Eyes snapshot review ran from committed Task-boundary
  revision `e55a9a5c75021be929fe327f1ce5eed6d691a463`. The accepted plan froze
  193 selected source entries and 158 call-evidence files with no omitted UTF-8
  source. All seven reviewer Tasks succeeded and used 1,392,053 tokens.
- The raw reviewer records are
  [`../../journal/artifacts/2026-08-09-million-eyes-code-quality-round-1-results.json`](../../journal/artifacts/2026-08-09-million-eyes-code-quality-round-1-results.json).
  The adjacent
  [`machine receipt`](../../journal/artifacts/2026-08-09-million-eyes-code-quality-round-1-receipt.json)
  records the plan, run, source revision, artifact digest, scope, selection, and
  rejected proposals.
- Automatic citation checking resolved no citation because reviewers used free-
  form source descriptions. The architecture-auditor therefore checked the five
  ranked claims against frozen source. This manual check is review evidence, not
  executable proof.
- The first selected change removes two duplicate prevalidation calls from
  `assembleToolResult`. `projectToolResult` remains the one path for canonical
  version, semantic schema, model projection, and model-schema validation.
- Three focused tests preserve valid content, raw details object identity,
  invalid semantic-result error text, noncanonical-version `upgrade_required`
  identity, and validation order. The focused file passed 11 tests and typecheck.
- Independent verification also compared all 14 valid catalog example assemblies
  against the committed baseline. Content and details stayed deeply equal, and
  both implementations retained the original details object.
- Architecture impact: **none**. This is a local accidental-complexity removal.
  It changes no public schema, export, dependency, persisted record, or behavior.

## 2026-08-09 — Team authority owns durable lead-Session discovery

- The existing `findLeadTeamForSession` body moved verbatim from
  `extensions/index.ts` to `src/utils/teams.ts`. The two composition-root call
  sites still run at their original initialization and `session_start` points.
- Six focused Team-helper cases cover a missing Team directory, absent or
  different Session input, one active exact match, malformed unrelated records,
  newest active lead selection, and multiple-Team ambiguity with exact order and
  error text.
- Existing binding and Session lifecycle tests preserve explicit `PI_TEAM_NAME`
  precedence, unbound and ambiguous refusal, initial startup, same-Session
  resume, and lead resume timing. The three focused files passed 36 tests and
  typecheck.
- Independent verification compared the old and new helper bodies through a
  TypeScript AST and found them byte-identical. A real extension snapshot kept
  the same ten leader tools, lead and Worker prompts, and Skill.
- Architecture impact: **changed** for internal Team ownership. HyperCarrier's
  canonical diagram stays unchanged because Pi Team Bright internals remain
  opaque. No public export, schema, record, ordering, or behavior changed.

## 2026-08-09 — deterministic local lock-contention oracles

- The local counter-race test now yields at its read/write boundary instead of
  using a random zero-to-ten millisecond delay. A missing lock now loses updates
  through a deterministic interleaving.
- The 20-way local contention test holds the first owner behind a release
  barrier, captures all 19 initial contender retry schedules, proves only one
  critical section is active, requires every retry in the 5–15 ms policy range,
  and rejects the legacy 100 ms cadence. It no longer passes or fails from an
  elapsed wall-clock threshold.
- Seven implementation runs and three independent runs each passed both focused
  lock files with 12 tests. Typecheck and diff checks passed.
- Independent mutation probes bypassed lock acquisition and restored fixed
  100 ms retries in temporary trees. Both mutations failed the new oracles. The
  real 20-process stale-takeover case remains byte-identical.
- Architecture impact: **none**. Only test evidence changed; production and
  public behavior remain byte-identical.

## 2026-08-09 — coordination hydration measurement and Team rotation

- Payload-free measurement found focused one-ID Task reads at 425.2 ms p50 and a
  full 21-Task snapshot at 6,249.1 ms p50. Native batch show scaled to 6,188.1 ms
  p50 for 22 IDs, and one five-ID sample reached the 10,000 ms timeout.
- One-ID dependent hydration had a 417.3 ms p50 and 3,852.2 ms p95; the same read
  without dependents had a 387.0 ms p50 and 408.2 ms p95. Reverse-dependent
  identities are part of opaque Task versions, so removing that data would
  weaken stale-write refusal and is rejected.
- A nonterminal-only snapshot candidate measured 983.0 ms p50, but the current
  public snapshot returns closed Tasks too. Filtering them would change current
  visible behavior, so it is outside this Project's no-behavior-change scope.
- The machine receipt is
  [`../../journal/artifacts/2026-08-09-coordination-history-performance-probe.json`](../../journal/artifacts/2026-08-09-coordination-history-performance-probe.json).
  It separates measurements, source facts, supported assessment, rejected
  changes, and the next safe test.
- All Tasks in `semantic-hardening-direct` were terminal. The leader stopped its
  four Workers, shut the Team down cleanly, and created
  `semantic-hardening-opt` with the same direct leader and four stable Worker
  roles. This resets coordination work history without creating a second leader
  or changing Project source.

## 2026-08-09 — reusable payload-free Task hydration benchmark

- Added `scripts/task-hydration-benchmark.ts` and the package command
  `benchmark:task-hydration`. The benchmark accepts explicit Team and sample
  arguments and calls the production Team-scoped list plus exact batch hydration
  path.
- The machine result schema `pi-team-bright/task-hydration-benchmark/1` emits
  aggregate workload, success/error/timeout counts, skipped hydration, latency
  summaries, and the 10,000 ms production timeout. It omits Team names, Task
  identities, Task text, paths, and error details.
- Four deterministic tests cover arguments, summary arithmetic, privacy shape,
  and error accounting. A real one-sample Team canary produced one native list
  and one native show through semantic trace, with both successful.
- Independent verification passed the benchmark tests, 15 production Beads
  adapter tests, typecheck, package verification, lane validation at 77 files
  (57 fast and 20 exhaustive), privacy markers, error injection, and diff checks.
- Required dependent hydration and opaque version meaning remain unchanged.
  Architecture impact: **none**. This adds reproducible non-functional evidence,
  not a production optimization or behavior change.

## 2026-08-09 — rebased onto published 0.17.0-rc.10

- A registry and remote check found that public `0.17.0-rc.9` and
  `0.17.0-rc.10` had advanced after the original rc.8 audit baseline. The leader
  fetched tags and rebased the seven retained Project commits onto exact
  `7453ce1b2a2ca49f8729a6bf399f7c1f25bfca6a`.
- Upstream rc.9 added event-directed sync hydration, complete Task-batch and
  watermark handling, failed-event hints, Worker Team binding, and default sync
  liveness/nudge policy. Rc.10 decoupled Team compatibility from package version.
- Upstream already contained the Pi 0.84 subscription footer method and a real
  shaped render test. The duplicate local footer commit was dropped during
  rebase rather than retaining an unnecessary helper export.
- Team fixtures no longer write the removed model-tool implementation version.
  The causal fixture now records Worker run state as active. After the controlled
  120-second deadline, rc.10 correctly returns `indeterminate` because run-state
  evidence remains incomplete; it publishes no observation and advances no
  hidden position. Cancellation and later Task visibility remain green.
- Typecheck, 46 focused tests across seven files, package verification, lane
  closure at 86 files (65 fast and 21 exhaustive), JSON checks, and diff checks
  passed on the rebased tree. The broad aggregate lane remains reserved for the
  final stable release tree.
- The partially implemented Task publication port was stashed before rebase.
  Its design evidence remains reusable, but its source patch must be reviewed
  and reapplied against rc.10 rather than restored blindly.

## 2026-08-09 — rc.10 subsystem audit refreshed

- The maintained subsystem audit and machine dependency map now review exact
  HEAD `734bbd369e1e` on integration base `7453ce1b2a2` and package rc.10.
- Independent AST evidence found 67 production TypeScript files, 19,418 lines,
  227 unique local static edges, no nontrivial SCC, no self-cycle, and no dynamic
  import. The test corpus has 86 test files plus two support files and 23,534
  combined lines.
- All 176 unique source references and 127 cited line anchors resolved. Seven
  selected Alert, Task reconciliation, hydration, liveness, failed-hint, nudge,
  and registered-extension evidence files passed 43 tests.
- The machine map preserves the five ordered core subsystems, additive
  Membership observation, unclassified ALERT-004 behavior, and design-only Task
  publication inversion. Rc.10 Coordination behavior is implemented, but its
  source boundary remains incomplete.
- The proposed target graph has seven nodes, nine edges, and no nontrivial SCC.
  Architecture impact remains internal; HyperCarrier's canonical diagram stays
  unchanged because Pi Team Bright internals are opaque.

## 2026-08-09 — Task mutation publication dependency inverted

- The implementation starts from committed audit baseline
  `8f2da7c5c13ab11aebbdfa6f297219ddf5e4b571`. It implements the corrected hq6
  design rather than i37's rejected Task-owned concrete aggregator.
- `beads-authority-adapter.ts` now defines and requires the consumer-side
  `TaskMutationPublicationPort`. It has no concrete import of Team events,
  failed-event hints, or Task delivery. Raw create, update, and link mutation
  functions have no concrete fallback or service locator.
- `src/adapters/durable-task-mutation-publication.ts` is the stateless durable
  composition adapter. It calls the existing Coordination event and failed-hint
  writers plus Task delivery, recovery, suppression, and owner-transition
  operations without changing persisted records.
- `extensions/index.ts` constructs one publishing Beads adapter factory and
  injects it into the leader `DurableModelToolTeamPort` and direct Worker tools.
  Default `BeadsTaskAdapter` construction remains read-only for semantic reads,
  reconciliation, and migration.
- Deterministic barriers prove owner-transition preparation stays inside the
  Beads write and Membership lease. The remaining sequence is Beads commit,
  lease release, acting-Session suppression, serial Team event publication,
  failed-event hint after an event failure, serial recipient delivery with
  inline recovery, then owner-transition completion. No-op updates and exact
  create replays do not call the publication port.
- Failure tests preserve exact warnings and continuation after event, failed-
  hint, enqueue, and recovery failures. Import fences prove the concrete writers
  moved outside Task authority. Composition tests cover leader and Worker
  mutation paths plus read-only default refusal.
- The independently verified pre-documentation Task publication selection
  contains exactly 17 paths. Its SHA-256 diff digest is
  `f332bfc4b032eb995d221b6f656ab35e3f5276f181831f25dd2c8e600eeddce1`.
- Independent verification passed 113 focused tests plus typecheck, result QA,
  test-lane closure, package verification, public-surface comparison,
  persistence checks, and diff checks. The lane manifest contains 88 test files:
  67 fast and 21 exhaustive. No aggregate lane ran.
- The refreshed TypeScript AST graph has 68 production files, 19,559 lines, and
  231 unique static local edges. It has no nontrivial SCC, self-cycle, or dynamic
  import. The test corpus has 88 test files plus two support files and 24,078
  lines.
- `TASK-PUBLICATION-INVERSION` is implemented and independently verified.
  `ALERT-004` remains characterized and unclassified. Team, Alert, Coordination,
  Trio, and additive Membership-observation boundary work remains incomplete.
- Architecture impact is **changed** for the internal Task publication boundary.
  HyperCarrier's canonical diagram remains unchanged because it keeps Pi Team
  Bright internals opaque. No production, test, or commit change was made by the
  documentation Task.

## 2026-08-09 — no-op publication evidence corrected

- This entry supersedes only the no-op wording and selected-diff digest in the
  preceding Task mutation publication entry. It does not rewrite that historical
  evidence.
- An acting-Session no-op still calls publication-port suppression for its Task
  version. It appends no Team event, enqueues no recipient delivery, and
  completes no owner transition. An exact create replay calls no
  publication-port method.
- The corrected order test passes both cases: the forced lease/publication
  interleaving and the separated no-op/create-replay behavior.
- Before updating receipt occurrences, a temporary Git index staged the exact
  17 selected paths from `subsystem-dependency-map.json`; the binary diff from
  baseline `8f2da7c` has SHA-256 digest
  `795b8c3d53ee39d0342bf85ea465179df7fe0cef0f83fd267a98b38d170e076d`.
- JSON, selected-path, citation, Markdown-link, lane-closure, and tracked plus
  untracked diff checks pass. No production source, package, aggregate lane, or
  commit changed.

## 2026-08-09 — source/test receipt scope corrected

- This entry supersedes only the 17-path digest bullet in the immediately prior
  correction. That provisional calculation included `context.md`, which stores
  the digest and made the receipt self-referential.
- The canonical receipt excludes `context.md`. A temporary index read baseline
  `8f2da7c`, staged the exact 16 non-context paths now listed in
  `subsystem-dependency-map.json`, and produced their binary cached diff against
  that baseline. Its SHA-256 digest is
  `d6da537790c95ac42ef741c5aa2f1fdf6999966ac76c525190838b01d8f96219`.

## 2026-08-09 — test corpus line count corrected

- This entry supersedes only the prior 24,078 combined-line claim. The current
  corpus has 88 test files with 23,647 lines and two support files with 441
  lines: 90 files and 24,088 lines combined.

## 2026-08-09 — semantic-hardening implementation series committed

- The reviewed Task publication change and maintained audit entered committed
  history as `15e707b5668af383d6949934bd8e67a35b8bc097` (`refactor: invert Task
  publication dependencies`). The ten Project commits now form one rc.10-based
  implementation series.
- The parked rc.8 Task-publication stash was superseded by the reviewed rc.10
  implementation and removed. `git stash list` is empty in the Project
  worktree.
- Added the durable concise [`result report`](result.md) and curated
  [`context`](context.md) back to evergreen status. Per-phase chronology remains
  in this journal; exact contracts remain in source and tests.
- Current assessment: no public tool, schema, package-export, persisted-record,
  filename, retry, timing, default-behavior, or canonical-diagram change. Internal
  Task and Team dependency ownership changed as recorded by the maintained
  audit.
- Remaining risks are ALERT-004 classification, Coordination cross-authority
  reads, combined Trio façades and fakes, partial Team lifecycle extraction,
  broad private Membership-observation inputs, and measured Beads hydration
  latency.
- No full aggregate lane ran for the final committed tree, and rc.11 preparation
  has not started. The next gate is one exact stable tree, one aggregate run,
  then package, public, persistence, privacy, provenance, graph, and diff
  verification before any release-candidate preparation.

## 2026-08-09 — 0.17.0-rc.11 source candidate prepared

- This entry supersedes only the prior next-action order. Owner authorization now
  requires the complete rc.11 source candidate to be committed first, then the
  one reserved full aggregate to run once on that exact committed source.
- Prepared package and lock metadata, README install text and image provenance,
  release parity metadata, maintained current and Project context, result status,
  and the dated [rc.11 release plan](../../journal/2026-08-09-v0.17.0-rc.11-release-plan.md).
- The candidate carries internal Task and Team dependency hardening with no
  public tool, schema, package-export, persisted-record, filename, retry, timing,
  or default-behavior change. Release text points to the Task-publication source
  and focused tests instead of duplicating executable contracts.
- Version and lock consistency passed for `0.17.0-rc.11`; 48 tracked JSON files
  parsed; 94 local Markdown links across seven changed release and Project files
  resolved; typecheck, packed-package verification, generated-dist comparison,
  and diff checks passed.
- This is source preparation only. No full aggregate, tag, push, npm publication,
  npm `next` change, registry or provenance claim, GitHub release, final release
  receipt, or commit was produced. Published npm `next` remains rc.10.

## 2026-08-09 — rc.11 local-link count corrected

- This entry supersedes only the prior 94-link occurrence claim. It does not
  rewrite that historical source-preparation record.
- Independent recomputation resolved 95 local Markdown link occurrences across
  the same seven files: `README.md` 4, `docs/current/README.md` 59,
  `docs/release/model-tool-parity-checklist.md` 0,
  `docs/projects/semantic-hardening/context.md` 10,
  `docs/projects/semantic-hardening/result.md` 14,
  `docs/projects/semantic-hardening/journal.md` 8, and
  `docs/journal/2026-08-09-v0.17.0-rc.11-release-plan.md` 0.
- All 95 occurrences resolved. The correction adds no Markdown link occurrence,
  so the recomputed total remains non-self-referential.

## 2026-08-09 — rc.11 exact source verification passed

- Exact clean source commit `638d5934bd52c7f4a3fe18525e5d72569a227211`
  passed its one reserved Node 22.22.1 aggregate: 88 files and 695 tests in
  253.59 seconds. It was not rerun.
- Lane closure reported 67 fast and 21 exhaustive files. Package and generated-
  output checks, agent and tool-result QA, public and persistence comparisons,
  all 48 tracked JSON files, all 95 local links, and diff checks passed.
- The configured-baseline-to-source privacy range passed. Full-history output
  remains the known grandfathered pre-baseline commit-metadata result and is
  byte-identical to the configured-baseline scan; it does not certify that older
  history for publication.
- One clean detached checkout packed once. The exact 93-file tarball installed in
  a temporary project and passed CommonJS and TypeScript observation, owned
  Beads 1.1.0, and bounded no-model Pi 0.84.1 main-extension canaries. Exact
  commands, sizes, digests, integrity, and limits are in the [source verification
  receipt](../../journal/2026-08-09-v0.17.0-rc.11-source-verification-receipt.md).
- The source remains untagged and unpublished. No commit, tag, push, npm
  publication, npm `next` change, registry or provenance claim, GitHub release,
  or full Team runtime/model-interpretation claim was produced by verification.

## 2026-08-10 — full five-subsystem continuation launched

- This entry corrects the earlier interpretation that rc.11 source verification
  completed the Project. The owner requires the complete agreed five-subsystem
  split and every behavior-evidence gate, not another bounded release increment.
- Restored the isolated worktree at documentation commit `a3c51d7`. The partial
  increment is on remote branch `rc/v0.17.0-rc.11`; `origin/main` and npm `next`
  remain on rc.10.
- Verified the direct leader's proxy environment and `HERDR_ENV=1`. Queried
  Herdr before control, then created a separate unfocused watchdog workspace.
  The watchdog Pi runs through `_codex_with_proxy` with
  `openai-codex/gpt-5.6-terra:medium`; its inherited proxy environment was
  proven before startup.
- Named the read-only agent `ptb-full-split-watchdog`. It checks leader liveness
  and the maintained completion checklist every 600 seconds. It requires two
  quiet intervals plus evidence before recovery action, cannot mutate Team,
  Tasks, Git, or Project files, and must reject early completion while any
  boundary, evidence gate, independent review, final aggregate, or maintained
  result remains open.
- The exact calling Session created direct-leader Team
  `semantic-hardening-full-split`. Stable architecture, behavior, test-harness,
  implementation, and independent-verification Workers are connected.
- Worker-authored claim and assignment events put three Tasks in progress:
  `semantic-hardening-full-split-3ro` recomputes the dependency graph and
  completion matrix; `semantic-hardening-full-split-bd0` audits all 26 behavior
  entries against current tests; and `semantic-hardening-full-split-a5g`
  designs deterministic Alert restart and failure characterization.
- Production implementation remains gated on these current-tree audits. The
  reserved full aggregate has not run for this continuation.
