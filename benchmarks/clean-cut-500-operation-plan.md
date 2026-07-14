# Clean-cut Task performance and trace contract

Status: Round 2 evaluator artifact; not yet a release gate.

The production-shaped load is a two-hour team run with at least 1,000 total
tool calls and 500 semantic Task operations. Run it against one initialized,
operator-configured external/server-mode Beads workspace, with four concurrent
team labels and a fixed operation mix: create, claim/start, status+owner update,
progress, pending problem, dependency, read/list, and completion. Preserve the
raw per-operation records and one canonical JSON summary.

Each logical Task operation record must contain:

- operation ID, Team scope, Task ID, semantic verb, start/end/duration, outcome,
  and returned post-state version;
- number and total duration of `bd` invocations, with command verbs but no Task
  content;
- local lock wait and hold duration;
- configured Task authority ID, backend mode, PiTeams commit, `bd` version, and
  workspace identity hash (never the private path);
- delivery reconciliation/enqueue attempts and stable delivery IDs.

The summary reports logical-operation and raw-`bd` p50/p95/p99 latency,
invocation amplification, aggregate wall time, lock contention, errors,
conflicts, duplicate/missed delivery IDs, and peak concurrency. The correctness
anchor is final Beads state plus an independently rebuilt expected state, not
the trace itself.

Fault cuts run separately around Task commit, spool temp-write/fsync/rename,
custom steer persistence, Session-context observation, and same-Session
restart. The accepted contract is at-least-once delivery with stable IDs, no
truncated accepted record, and latest-state reconciliation after restart. A
fork must receive none of the source Agent's pending state.

Round 2 must first add an opt-in trace interface; the current injectable
`BdRunner` can count subprocesses in tests but doesn't expose production
logical timing or lock wait. Don't infer those metrics from model/tool-call
transcripts.
