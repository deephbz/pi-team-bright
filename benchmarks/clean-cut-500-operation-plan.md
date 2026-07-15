# Clean-cut Task performance and trace contract

Status: clean-cut Task-surface evaluator contract.

The production-shaped load is a two-hour team run with at least 1,000 total
tool calls and 500 semantic Task operations. Run it against one initialized,
server-mode Beads workspace, with four exact Membership/Session lanes and a
fixed 500-intent mix: 20 create, 100 read, 100 list, 100 status update, 80
assignee+status update, 48 design update, and 52 append-note operations.
Preserve the raw per-operation records and one canonical JSON summary. Claim,
relation cycles, review/version conflicts, and Message/Task separation are
correctness contracts in the E2E suite rather than throughput mix inflation.

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

This benchmark deliberately performs no LLM completion. Its semantic-intent
latency measures PiTeams plus Beads backend mechanics, while `bd` invocation
latency isolates the authority subprocess cost. Model turns, tokens, and cost
must be measured from a live Session trace and must never be inferred from
these backend timings.

Fault cuts run separately around Task commit, spool temp-write/fsync/rename,
custom steer persistence, Session-context observation, and same-Session
restart. The accepted contract is at-least-once delivery with stable IDs, no
truncated accepted record, and latest-state reconciliation after restart. A
fork must receive none of the source Agent's pending state.

The opt-in trace interface records production-shaped logical timing and lock
wait without Task payloads. Don't infer these metrics from model/tool-call
transcripts, and don't infer model-turn cost from the benchmark.
