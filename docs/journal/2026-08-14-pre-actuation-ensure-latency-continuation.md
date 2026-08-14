# Pre-actuation ensure latency continuation

Date: 2026-08-14
Stage: exploration inside the hardened Task-first package
Architecture impact: none so far

## Task and authority state

Task `ptb-worker-startup-opt-43j` is assigned to
`warm-carrier-experimenter`. Its goal is a disposable measurement of the span
from `ensure_started` to `membership_prepared`, before Herdr actuation. The
reported real exact-source canary span was about 5.012 seconds.

The Worker attempted a graph-native `claim` with task version
`v_7cfbdc82b05bb9bc`. The Worker surface refused it because this legacy Task
has no graph revision and no graph-revision tool is available. A clarification
Alert was sent to `team-lead`. Proceed under the assigned Task and send result
evidence for lead reconciliation. Do not make a Task transition unless the
authority surface changes.

## Problem and scope

Work only in the assigned isolated worktree. Do not modify production behavior.
The result must split repeated isolated and loaded samples into at least:

1. Team configuration read and terminal detection.
2. Worker resource aggregate projection.
3. Model resolution.
4. Membership persistence and current-Membership lease work.
5. Prepared-event publication.
6. Any Task or Beads reconciliation on the integrated path.

Persist redacted individual timings, environment and source provenance, and
derived p50/p95 values. Identify cache, lock, and cold effects. State which
serial steps can safely leave the critical path. Do not claim a 100 ms full
ensure result.

## Evidence inspected

The current branch head is `0aefbda`; the preceding warm experiment source is
`8324307` and `fe7dae7`. The new task is separate from that completed work.

`src/team-authority/worker-launch-bridge.ts` owns the direct new-Worker path.
Its observed order is:

`teamExists -> readConfig -> currentTerminalForTeam -> no-existing-member plan
-> resolveWorkerAggregate -> resolveNewWorkerModel -> build Member -> addMember
-> recordWorkerPrepared -> buildWorkerArgv/env -> launchPreparedMembership ->
observeLaunchedWorker`.

`launchPreparedMembership` can await an optional initial message, spawn the
carrier, read configuration again, and persist its terminal target. That work
is after `membership_prepared`; it is outside the requested pre-actuation
measurement but must remain distinct in the trace.

The integrated model-tool path invokes the bridge through
`src/model-tool-contract/durable-model-tool-team-application.ts`. The code
search also found existing related source and evidence:

- `scripts/worker-startup-benchmark.mjs`
- `scripts/worker-startup-accepted-benchmark.mjs`
- `docs/journal/artifacts/2026-08-14-worker-startup-performance.json`
- `docs/projects/worker-startup-performance.md`
- `docs/journal/2026-08-14-worker-startup-analysis.md`
- `docs/journal/2026-08-14-worker-startup-accepted-launch.md`

Those are the next sources to inspect. The source search did not yet identify
the exact canary trace record.

## Next steps

1. Read the existing worker-startup scripts, artifacts, and project document.
2. Write a problem/plan JSON DAG before measurement code.
3. Build a disposable benchmark wrapper around the current integrated path.
4. Run isolated and loaded samples with one canonical redacted trace record per
   sample.
5. Write the result artifact and grounded critical-path recommendation.
6. Commit source and results. Do not push or publish.

## Progress update

A disposable source-coupled runner now exists in
`benchmarks/pre-actuation-ensure-latency/`. It runs the actual model-tool
application, Team persistence, resource projection, and durable event
publication in fresh temporary state. Bun module mocks measure selected seams
before the bridge and application load; each wrapper forwards to the actual
implementation.

A bridge subclass rejects at `launchPreparedMembership` entry. A pilot passed
isolated, four-way loaded, and controlled Team-directory conditions. Each
pilot trace had a prepared Membership, matching prepared event, zero terminal
spawns, zero agent Session files, zero pre-boundary Task reconciliation calls,
and owned aggregate cleanup. The final seven-sample measurement and result
interpretation remain pending. No production file changed.

## Completion update

The final 42-trace result is recorded in
[`2026-08-14-pre-actuation-ensure-latency-result.md`](2026-08-14-pre-actuation-ensure-latency-result.md)
and its raw JSON artifact. The source commit is `e92de56`. The clean
source-coupled path measured 10.552 ms p50 and 22.221 ms p95, so it does not
explain the reported 5.012-second canary. No production file changed.
