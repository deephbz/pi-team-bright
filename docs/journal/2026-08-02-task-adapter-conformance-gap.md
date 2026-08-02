# Task-adapter conformance gap observation

Date: 2026-08-02

Status: historical shaping evidence. No backend decision is accepted.

The atomic `record_progress` proposal requires one Task transaction to verify a
version, replace current context, append identified journal evidence, optionally
change status, commit a durable change record, and preserve an idempotent
receipt.

Current source does not provide that contract:

- expected version is checked before the Beads mutation, and the source states
  that external writers can race after this preflight (`src/utils/beads.ts`);
- mutation uses `show -> update -> show`, so a single CLI command is not the
  whole semantic operation;
- Task notes are one mutable text field rather than independently identified
  immutable journal records;
- `record_progress` has no accepted operation-ID and receipt-replay contract;
- the adapter validates an existing parent edge but does not traverse and reject
  a new parent cycle; and
- Task mutation and change publication do not commit through one durable
  transactional outbox.

An independent systems observer also ran a temporary Beads 1.1.0 probe. It
reported that Beads rejected a dependency cycle, accepted a parent cycle, and
accepted cyclic `related` edges. This probe is not yet a committed reproduction
artifact, so treat those backend outcomes as a result to reproduce, not final
proof.

Next verification: run one backend-neutral conformance suite against Beads and a
transactional reference adapter. Inject concurrent same-version writers and a
lost receipt after commit. Require old state or one complete new state, one
version, each journal ID once, one durable change record, and the same receipt
on retry. Reject dependency and parent cycles while allowing cyclic `related`
edges.
