# team_sync presentation fix

Date: 2026-10-07. Base: `337cb13`.
Commit subjects: `Verify team_sync turns with a model, a traversal, and scripted Pi`
and `Make every leader team_sync result actionable`.
Status: implementation repaired after final review; focused verification complete.

## Incident and contract

Consecutive native `team_sync` calls wasted every second observation turn.
Pi completes the assistant message before it executes that message's tools.
The extension acknowledged the earlier observation at `turn_end`. The next
sync therefore found the earlier pending result and returned `indeterminate`.
The in-memory fake hid this failure by replaying a pending result for any call ID.

Contract revision 2 resolves the pre-request pending candidate at successful
assistant `message_end`. Valid presentation proof advances the hidden baseline.
Absent or rejected proof, failed acknowledgement, and thrown acknowledgement
discard only the captured call ID. The next observation uses the committed
baseline. Error and abort retry behavior stays unchanged.

Duplicate calls in one assistant message return an actionable refusal.
`unsettled` names incomplete Worker evidence. `caught_up` retains its accepted
quiescence meaning. Missing baselines return snapshots. Native observation
skips empty pages and preserves the represented page cursor. Historical
Session decoding reads retired results without admitting them to publication.
The fake now follows these pending-slot, duplicate, and snapshot contracts.

Executable anchors:

- [`extensions/index.ts`](../../extensions/index.ts): exact provider proof and pending-slot resolution.
- [`observation-service.ts`](../../src/coordination/observation-service.ts): liveness, empty-page traversal, cursor fencing, and staging.
- [`result-projection.ts`](../../src/model-tool-contract/result-projection.ts): current schemas and historical decoder.
- [`sync-state-traversal.test.ts`](../../src/coordination/sync-state-traversal.test.ts): independent input oracle.
- [`run.mjs`](../../scripts/team-sync-scenarios/run.mjs): real Pi loop scenarios.

The framework ACK entry can precede the consuming assistant entry. Its only
reader uses an order-independent record-ID set. Context projection ignores ACK
entries. A focused test clones this branch for reload, checks exact replay,
and checks that the next publication does not supersede the acknowledged record.

Supported composition assumes that later extensions preserve the staged result
in the provider payload and preserve the completed assistant message. This fix
acknowledges observation. It does not acknowledge Task work or Worker delivery.

## Evidence

- Typecheck passed. No aggregate suite ran.
- Focused integration run: 13 files, 1,045 tests passed. This includes all 916
  traversal tests with no expected-failure markers.
- Durable branch-switch regression: one selected test passed.
- Agent-surface generator and context-budget check: two tests passed.
  `agent-surface.json` remains an ignored generated artifact.
- Six default-mode real-Pi scenarios passed: consecutive native calls,
  parallel duplicates, framework then native sync, sequential duplicates,
  absent provider proof, and historical render/reload with unchanged bytes.
- `git diff --check` passed.
- No executable `snapshot_required` producer remains. Historical schemas,
  decoding, internal probe declarations, and the unchanged nudge guard retain
  retired references.

The pinned formal runner rejected the available jar with exit 2. The repository
pin remains `ab4694601923fd5ac06452abbf847c366a5054a3d739552085edd6ed986c29ec`.
The owner must decide whether to replace it.

A temporary runner copy outside the repository changed only `expected_sha` to
`7beec0f04818732a62fa193731711a99aa4f11279499b2360a7d156c519ea78d`.
All 22 formal cases passed with that verified jar. The fixed `SyncPresentation`
instance generated 418,304 states, found 140,380 distinct states, and exhausted
its queue at depth 18. Six sync mutants reached their named counterexamples.
These bounded checks do not prove TypeScript refinement. The real-Pi scenarios
anchor hook timing.

Raw output anchors remain outside the repository:

- `/tmp/ptb-integrate-focused.txt`
- `/tmp/ptb-integrate-typecheck.txt`
- `/tmp/ptb-integrate-scenarios.txt`
- `/tmp/ptb-integrate-formal.txt`: unchanged pinned-runner rejection.
- `/tmp/ptb-integrate-formal-verified.txt`: all 22 cases.
- `/tmp/ptb-sync-integrate-formal.aURk32/results/`: full TLC logs and traces.

The [scenario guide](../maintainers/scenario-verification.md) gives reproduction
steps. The formal default already selected the fixed configuration. The scenario
default now names `contract` explicitly.

Architecture impact: **none** at the HyperCarrier boundary. Pi Team Bright
remains opaque in the canonical diagram. Task authority, journal format,
hidden-observation persistence, and nudge scheduling remain unchanged.

## Final-review repair

The reviewer reproduced an authority-loss case. An empty canonical journal page
caused native traversal to promote a fresh Task revision to its comparison
baseline. The next eventless rescan could therefore return `caught_up` while it
had not presented changed Task content. Active Workers could keep the call waiting.

Nine added rows failed before repair. They cross retired-Worker or stale-Task
pages with changed authority under no-Worker, settled, and active conditions.
Pure-removal rows cover the same three activity conditions. They assert returned
Task content and the authority revision committed after acknowledgement.
Commit 1 marks these rows as expected failures. Commit 2 enables them.

The repair preserves the committed comparison revision through empty pages.
The existing eventless rescan presents changed Task cards before quiescence.
A pure removal to zero Tasks returns a snapshot. This reports the complete empty
set and avoids an empty-projection loop. The result head uses the represented
page cursor. Framework persisted records accept only snapshot and updates.
Native historical decoding still reads retired results.

Repair verification:

- Nine negative rows failed before the repair.
- Commit 1 traversal: 710 passing tests and 215 expected failures, including
  all nine new rows.
- Commit 2 focused run: 13 files and 1,054 passing tests. All 925 traversal
  tests pass. One selected durable test and two artifact checks also pass.
- All six scenarios pass in `EXPECT=bug` mode on commit 1. All six pass in
  default contract mode on commit 2.
- Typecheck passes. The temporary runner passes all 22 formal cases with the
  same verified jar SHA. The repository pin remains unchanged.
- Base-relative whitespace checks now include the historical text evidence.

Raw repair anchors: `/tmp/ptb-repair-red.txt`,
`/tmp/ptb-repair-traversal-base.txt`, `/tmp/ptb-repair-focused.txt`,
`/tmp/ptb-repair-typecheck.txt`, `/tmp/ptb-repair-scenarios-bug.txt`,
`/tmp/ptb-repair-scenarios-fixed.txt`, and `/tmp/ptb-repair-formal.txt`.
Full TLC results: `/tmp/ptb-sync-repair-formal.H5a0Tt/results/`.
The bounded presentation model does not encode the Task-revision promotion
case. The new independent traversal rows detect that failure.

## Aggregate fixture repair

The final verifier isolated seven stale fixture or gallery classes. Presentation
fixtures now emit assistant `message_end` before `turn_end`. Error/retry fixtures
also include both hooks. Worker lifecycle tests retain their own `turn_end`
checks. They do not simulate observation presentation.

The hidden-port fixture asserts that the captured pending candidate is released
before the commit. Its journal now honors `afterCursor` and names a current
logical Worker. The cache-reuse check still requires one Task authority read.
The durable fault injection now targets the page reader used by traversal.
The mixed-record fixture retains exact raw/model JSON assertions with the
current property order. Retired native `indeterminate` uses the historical
decoder and remains rejected by the live schema.

Gallery samples now honor array `minItems`. Explicit `unsettled` and duplicate
refusal examples show all Worker reasons and the recovery action. Existing
schema coverage checks remain in force.

All seven affected classes passed when run separately. The tool-result QA class
used `vitest.exhaustive.config.ts`. The updated error/retry fixture and gallery
component also passed separately. Total: 117 focused tests across nine classes.
Typecheck and base-relative whitespace checks passed. No aggregate lane ran
during this repair. The final verifier owns the aggregate result.

Raw outputs use `/tmp/ptb-fixture-repair-*.txt`. The QA output is
`/tmp/ptb-fixture-repair-qa.txt`; typecheck is
`/tmp/ptb-fixture-repair-typecheck.txt`.

The native empty-page loop also rejects a journal page with events when its
cursor does not advance. It uses the same error as bounded page traversal.
The regression store deliberately ignores `afterCursor`. A bounded test-side
fallback makes a missing production guard fail instead of hanging the test.
The service rejects the second repeated page and stages no observation.
All 30 synchronization-continuity tests pass separately. Raw output:
`/tmp/ptb-fixture-repair-pagination.txt`. This repair ran 147 focused tests
across ten isolated classes in total.

## Second aggregate fixture repair

The next serial verification found two more stale fixtures. The graph
replacement journal now honors `afterCursor`. Its baseline carries the current
Task projection revision. Retired-only pages produce no Task change and reach
`caught_up` after exhaustion. Both authority reads include only current IDs.
The public recovery child now emits assistant `message_end` before `turn_end`.

The sweep covered all files in `src/`, `test/`, and `scripts/`, including CJS
support files. The historical causal helper now emits both assistant hooks.
Both traversal wait helpers now forward `afterCursor`. The intentionally
nonadvancing regression remains unchanged. Empty zero-head journals have no
pages to filter. The mutation-evidence mock does not traverse pages. Worker
runtime lifecycle hooks and the canary event normalizer have separate duties.

The graph replacement, continuity, and traversal files passed separately:
3, 30, and 925 tests. Typecheck passed. All 25 `exhaustiveOnly` files completed
serially with `--config vitest.exhaustive.config.ts`. They passed 170 tests;
one historical causal scenario remained skipped. No aggregate lane ran.

| Exhaustive file | Passed | Skipped |
| --- | ---: | ---: |
| `scripts/snapshot-agent-surface.test.ts` | 1 | 0 |
| `scripts/tool-result-qa/suite.test.ts` | 1 | 0 |
| `src/task-authority/beads-graph-adapter.external.test.ts` | 3 | 0 |
| `src/task-authority/dag-delivery.e2e.external.test.ts` | 2 | 0 |
| `src/utils/alert-publication-failure.characterization.test.ts` | 1 | 0 |
| `src/utils/binding-correctness.external.test.ts` | 5 | 0 |
| `src/utils/causal-path-characterization.test.ts` | 1 | 1 |
| `src/utils/clean-cut-contract.test.ts` | 16 | 0 |
| `src/utils/clean-cut-round2.test.ts` | 16 | 0 |
| `src/utils/ergonomic-tool-contract.test.ts` | 16 | 0 |
| `src/utils/formal-hardening-public-recovery.test.ts` | 1 | 0 |
| `src/utils/identity-p0-contract.test.ts` | 11 | 0 |
| `src/utils/launch-compensation.contract.test.ts` | 18 | 0 |
| `src/utils/membership-mutation-lease.contract.test.ts` | 4 | 0 |
| `src/utils/owner-transition-outbox.contract.test.ts` | 6 | 0 |
| `src/utils/release-p1-contract.test.ts` | 15 | 0 |
| `src/utils/round2-contract.test.ts` | 9 | 0 |
| `src/utils/task-surface-cleancut.e2e.test.ts` | 3 | 0 |
| `src/utils/team-owned-beads-authority.contract.test.ts` | 7 | 0 |
| `src/utils/team-recreation.contract.test.ts` | 3 | 0 |
| `src/utils/terminal-backend.contract.test.ts` | 10 | 0 |
| `src/utils/topology-lifecycle.contract.test.ts` | 4 | 0 |
| `src/utils/worker-resource-extension.contract.test.ts` | 10 | 0 |
| `src/utils/worker-team-binding.contract.test.ts` | 4 | 0 |
| `test/formal-adversarial/graph-conformance.test.ts` | 3 | 0 |

Per-file output summary: `/tmp/ptb-third-repair-exhaustive-summary.txt`.
Individual logs use `/tmp/ptb-third-repair-exhaustive-*.txt`.
The three focused file logs use `/tmp/ptb-third-repair-src_coordination_*.txt`.
Typecheck output: `/tmp/ptb-third-repair-typecheck.txt`.
