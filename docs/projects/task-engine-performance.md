---
document_id: pi-team-bright-task-engine-performance
document_kind: evergreen-performance-contract
lifecycle_stage: hardening-measurement
scope: Nonfunctional latency, contention, capacity, and resource cost of the accepted Pi Team Bright Task and synchronization workload.
responsibility: Own benchmark questions, trace requirements, current performance assessment, optimization order, and backend-comparison gates.
authority: Performance intent and current assessment only; current shipped semantics remain in registered schemas, implementations, and tests, while accepted future semantics migrate there from shaping.
excludes: Model-facing semantic design, generic Team ontology, unmeasured backend selection, and raw dated benchmark evidence.
maintenance: Replace superseded assessments and link reproducible journal artifacts; never accumulate individual benchmark runs here.
---

# Task-engine performance Project

Updated: 2026-08-02

Stage: **hardening measurement** for the existing Beads path; any replacement
adapter begins in **exploration**.

Status: active. Repair the benchmark trace contract before the representative
traced Team epoch. No optimization or backend replacement is accepted.

Architecture impact: none until an accepted change alters the Task-authority
adapter or backend.

## Outcome

Reduce Task-engine latency and contention without changing model-visible
semantics, Task authority, identity, mutation safety, or recovery behavior.

This Project closes when a representative workload has a reproducible baseline,
a selected change has a measured improvement at the affected percentile, and
contract tests show no semantic regression. A backend replacement needs its own
correctness and recovery comparison; a lower median alone is insufficient.

## Source allocation

This file is the single maintained Project context. It owns the question,
measurement contract, current assessment, candidate sequence, decisions still
in force, and next experiment.

Dated traces, benchmark inputs, scripts, and results belong under
`docs/journal/artifacts/`. The current historical baseline is the
[2026-08-02 latency audit](../journal/artifacts/2026-08-02-pi-team-toolcall-audit/bd-latency.md).
Executable Task semantics remain in [`src/utils/tasks.ts`](../../src/utils/tasks.ts),
[`src/utils/beads.ts`](../../src/utils/beads.ts), and their tests.

Do not copy each result into this file. Update only the current conclusion and
link its reproducible artifact.

## Dependency on the contract Project

This Project benchmarks an accepted semantic workload. It does not define that
workload.

The `snapshot` and incremental `updates` views, internal baseline, Task
current-context/journal shape, and complete-or-no-observation policy change
model-visible behavior. The
[model-invoked tool contract Project](model-invoked-tool-contract.md) owns those
choices. Its initial delivery uses minified named JSON and defers alternative
result encodings. Its candidate has no Worker, nonterminal-Task, or journal-entry
count caps and no paging. This Project measures scale and cost; it does not
convert benchmark points into domain limits.

Trace instrumentation and a benchmark harness can proceed now because they do
not select a model-facing contract.

## Performance question

Which measured part of a semantic Pi Team Bright operation consumes latency
under normal and concurrent use, and what is the smallest change that removes
that cost without weakening the Task contract?

The important distinctions are:

- semantic operation time;
- Pi Team Bright lock wait;
- `bd` subprocess time;
- non-`bd` adapter work;
- backend contention time;
- accumulated concurrent time versus operator wall time; and
- routine latency versus tail latency.

## Current evidence

Exact historical `bd` time is unavailable because the audited processes did not
set `PI_TEAMS_TRACE_JSONL`.

The outer-call audit supplies only an upper bound:

- 646 Pi Team Bright calls;
- at least 1,238 `bd` subprocesses;
- 1,039 read commands, or 83.9% of that lower-bound command count;
- 1,060.863 seconds of accumulated Task-engine-path upper-bound time across
  concurrent Sessions;
- routine Task reads near 0.5 seconds, updates near 1.4–1.7 seconds, and creates
  near 2.5 seconds; and
- four reads at 10.8–64.8 seconds plus two hydration timeouts near 10.4 seconds.

These data prove that subprocess and backend work are material. They do not
separate process startup, Dolt execution, lock wait, projection work, or
scheduling, so they do not justify a backend choice.

The existing trace is also too small for the full benchmark contract. It records
one semantic operation, duration, nested `bd` calls, and lock wait. It does not
record a tool-call or parent-operation correlation ID, Task or hydration counts,
concurrency, or cold/warm state. `team_sync` currently emits separate nested
Task-list and Task-read traces rather than one correlated outer sync record.
Repair this payload-free correlation before collecting the representative run.

## The proposed concurrent or atomic shortcut

Do not implement it before tracing.

“Concurrent,” “single call,” and “atomic” are different properties. Running
current commands concurrently would not make them atomic. Most observed command
chains have data or safety dependencies:

- ordinary create uses `create`, then a fresh `show`; idempotent create first
  uses `list`;
- update and claim use a precondition `show`, then mutation, then a fresh `show`
  for the advertised version;
- Task-link mutation reads both ends before mutation and reads the result; and
- filtered synchronization uses `list` to choose IDs, then one already-batched
  multi-ID `show`.

The current implementation already runs Team-config and Task-list reads in
parallel and already batches multi-Task hydration. Parallelizing dependent
steps is therefore not a trivial safe optimization.

A true one-call mutation requires backend support for the precondition,
mutation, and final version receipt in one transaction or command. Removing a
fresh read is safe only if external Beads evidence proves that the mutation
response contains the committed fields and revision used by Pi Team Bright.
The current source explicitly says it can expose a pre-commit `updated_at`.

Decision still in force: defer this code change. Start the API-contract Project
now and start this Project with measurement setup only.

## Measurement contract

First add one payload-free correlation coordinate and an outer semantic trace
for `team_sync`. Keep Task text out of the trace. Then enable
`PI_TEAMS_TRACE_JSONL` for a new representative Team epoch. Preserve the exact
package revision, Pi version, Node version, `@beads/bd` version, platform, Team
configuration, Task count, and workload seed with each result.

For each semantic operation, record:

- total duration;
- `bdTotalMs` and every command duration and outcome;
- lock wait;
- Worker count, Task count, hydrated Task count, serialized Task-card bytes,
  full new journal-entry count, and named model-result bytes;
- command count and command kind;
- concurrent reader and writer count;
- result outcome and unavailable areas; and
- cold or warm process/backend state.

Report p50, p95, p99, maximum, timeout rate, and accumulated command count for:

- create with and without idempotency;
- read one and read many;
- update, claim, link, and accepted atomic `record_progress` batches;
- snapshot view by Task count;
- immediate and waiting updates views;
- post-compaction snapshot rehydration;
- same-Session resume and cancellation without baseline advance; and
- the same reads while Workers mutate Tasks.

Separate three workload lanes:

1. single Session, no contention;
2. representative Team concurrency; and
3. controlled stress that reproduces the long tail.

The benchmark must assert Task state, versions, relations, event publication,
per-authority revisions, and accepted/refused/unavailable behavior. A faster
wrong receipt fails.

## Candidate sequence

Use the first measured bottleneck, not preference, to choose the next step.

1. **Measure one outer operation.** Add payload-free parent/tool-call
   correlation, outer `team_sync` timing, hydration counts, and benchmark
   workload metadata.
2. **Reduce unnecessary work after semantic acceptance.** Build snapshot Task
   cards and grouped update deltas without hydrating unrelated closed history.
   On a required-authority failure, preserve the prior baseline and return no
   semantic observation. The model-visible semantics are owned by the contract
   Project; this Project measures their cost.
3. **Remove redundant commands.** Only remove a `list` or `show` when backend
   evidence and contract tests prove equivalent idempotency, scope, relation,
   and version behavior.
4. **Reuse execution context.** Test a persistent `bd` or native backend path if
   traces show process startup dominates and Beads supplies a supported mode.
5. **Deepen the Task-store seam.** Do this only when a real second adapter or a
   benchmark stand-in exists. The current code encapsulates Beads calls, but
   `tasks.ts` and Team configuration still name Beads directly; replacement is
   not a zero-cost swap.
6. **Compare a local adapter.** If Beads remains dominant, prototype an
   in-process graph or SQLite adapter against the same semantic contract.
7. **Consider remote trackers for product reasons.** Linear or Jira add network,
   availability, authentication, and rate-limit costs. Treat them as integration
   candidates, not presumed performance improvements.

## Decision rules

Accept an optimization only when:

- its before/after workload and source revisions are reproducible;
- it improves the targeted percentile or timeout rate by a declared amount;
- it does not worsen another critical percentile without an accepted trade-off;
- all semantic contract checks pass; and
- the result explains whether time moved or disappeared.

Consider a backend trial when exact traces show backend time still dominates
after unnecessary hydration and command multiplication are removed. Consider a
backend replacement only when the trial also satisfies authority identity,
version conflicts, typed graph constraints, atomic single-Task progress batches,
current/journal queries, durable change publication, recovery, and operational
requirements.

## Next experiment

1. Add payload-free outer-operation correlation and verify one `team_sync`
   record accounts for its nested `bd` calls.
2. Start one new Team epoch with `PI_TEAMS_TRACE_JSONL` enabled.
3. Run a seeded evaluator at 1, 20, and 60 Tasks, idle and under concurrent
   writes. Treat these as workload points, not public limits. Cover snapshot,
   immediate updates, waiting updates, compaction rehydration, same-Session
   resume, cancellation, and one injected Task-read timeout.
4. Assert final Beads state, complete named JSON output, and no baseline advance
   after cancellation or required-authority failure.
5. Publish the raw private trace outside Git when it contains sensitive paths.
6. Commit a redacted machine result, analysis script, and interpretation under
   `docs/journal/artifacts/`.
7. Select one optimization only after the trace identifies its owning cost.

Until that artifact exists, do not parallelize the current dependent `bd`
chains and do not choose another Task engine.
