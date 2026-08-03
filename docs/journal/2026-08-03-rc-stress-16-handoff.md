# Pi Team Bright stress-test handoff: 16 Workers

Date: 2026-08-03
Team: `rc-stress-16`
Implementation epoch: `0.17.0-rc.2`
Workspace: `~/.pi/teams/rc-stress-16`

## Result

The stress test found a release-blocking Task-authority contention failure. The 16
Worker lifecycle path mostly held, but Beads/Dolt timeouts prevented reliable
Task reconciliation and cleanup. Do not treat this run as a passing release gate.

No product source files changed during the run.

## Workload and launch evidence

- 16 logical Workers were created.
- All 16 reached `prepared` and `session_bound` events.
- All 16 Membership IDs matched their runtime Membership IDs.
- All 16 had distinct PIDs, Session files, and Herdr panes.
- 15 runtime records reported `ready=true`; `latency-observer` reported
  `ready=false`.
- The initial batch requested 48 Tasks. 40 were created and 8 returned
  `task_authority_unavailable` because Beads timed out.
- Workers then created additional Tasks while running the probes.
- The alert Worker sent 20 Alerts concurrently.
- The cursor Worker appended 30 events concurrently and tested two readers.

## Failures and risks

### 1. Beads authority collapses under concurrent work

This is the main failure.

Observed errors included:

```text
Beads command failed (timeout): bd --directory <home>/.pi/teams/rc-stress-16 ...
```

The timeout affected Task create, list, show, claim, update, and close operations.
Examples:

- The 48-Task create batch returned 8 unavailable outcomes instead of one
  atomic result.
- `task_read` for one Task timed out.
- `team_sync` could not rescan the Task set.
- One Worker claimed a Task, but its block update timed out.
- Another Worker could not tell whether a claim succeeded after repeated timeout.
- Several close mutations timed out.
- `team_shutdown` could not reconcile assigned Tasks and failed on the same
  Beads `show` path.

This creates uncertain Task state. A timeout cannot be treated as success or
failure without a durable operation receipt and a later authoritative read.

### 2. Batch mutation has partial-outcome pressure

The initial batch returned both `created` and `unavailable` outcomes. This is
useful information, but the operation created a large amount of concurrent
authority work before the caller could reconcile the batch.

The failed batch also left cleanup work that later appeared in large `show`
requests. The coordinator then timed out while trying to inspect the full set.

The extension needs bounded batches, explicit partial-result semantics, and a
reconciliation path that does not require one large Beads command.

### 3. Observation is not available to Workers that were assigned observation Tasks

The Worker tool surface exposed `task_read`, `task_update`, and `alert_send`,
but not `team_sync`.

The `sync-cursor-a` Worker therefore blocked its Task. It could inspect delivered
Task snapshots, but it could not produce cursor or incremental-event evidence.
The Worker correctly reported this limitation instead of claiming success.

This is an authority boundary, but the scheduler allowed an impossible Task to
be assigned. Either expose a read-only observation operation to Workers or add
Task capability checks before assignment.

### 4. Worker lifecycle did not provide a uniform readiness result

All 16 Workers bound Sessions, but one runtime record had `ready=false` while
the other 15 reported `ready=true`.

The launch path proved carrier binding, not Worker readiness. The stress run
therefore cannot claim that all 16 Workers were ready to do work.

Keep `session_bound`, `carrier_alive`, `ready`, and `Task_started` as separate
states. Add a bounded readiness receipt or make the absence of readiness an
explicit lifecycle result.

### 5. Cleanup could not complete after authority contention

The lifecycle Worker found open or in-progress assigned Tasks. It correctly
reported that `worker_stop` was lead-only and could not run from the Worker.
The lead then could not reconcile the Tasks because Beads timed out.

The shutdown attempt failed. A later `team_sync` returned:

```text
The exact leader Session is not bound to an active Team.
```

This is an unsafe handoff state: the Team became unavailable to the lead while
Task and Worker cleanup evidence was incomplete. Confirm whether shutdown
partially deactivated the Team. The lifecycle operation needs a durable terminal
receipt and a recoverable cleanup state.

### 6. Full projection QA timed out

Focused projection checks passed, but the full headless QA run timed out after
180 seconds and produced no result artifact.

A focused pass is not evidence that the full projection workload is safe. The
QA lane needs bounded per-case timeouts, progress output, and a partial artifact
that identifies the case where it stopped.

### 7. Receipt observability is too weak for stress diagnosis

The Alert Worker sent all 20 Alerts successfully. The model receipts exposed no
Alert timestamps, event IDs, or acknowledgement IDs.

The updater Worker also reported that mutation receipts exposed no commit-latency
field.

The event journal contains evidence, but the public receipt does not link the
result to that evidence. Add payload-free correlation IDs, operation start/end
or duration, and event/ack references. Do not add message payloads to traces.

### 8. Large read operations are fragile under write pressure

The reader ran ten compact reads and observed counts:

```text
33, 34, 34, 34, 34, 36, 36, 36, 37, 38
```

A second 12-read run observed:

```text
42, 43, 43, 43, 43, 43, 43, timeout, 45, 46, 46
```

The 11 successful reads had no duplicate IDs or ordering violations. However,
large versioned reads and Task reconciliation reads timed out. The result is
good safety evidence for successful reads, but poor availability evidence for
the current read path.

Use bounded pages and avoid a single `bd show` command for the entire Task set.

### 9. Launch protocol was not the required proxy/model epoch

The coordinating Session had proxy variables, but its environment identified
`PI_MODEL=gpt-5.6-luna`. The required launch procedure specifies
`_codex_with_proxy pi --model openai-codex/gpt-5.6-terra:medium`.

Workers did launch and produce Task events, so this does not invalidate the
extension observations. It does mean this run is not a clean reproduction of
the required Terra proxy setup. Repeat the release gate with the required
wrapper and model.

### 10. Runtime implementation version is behind the stated release context

The created Team persisted `implementationVersion: 0.17.0-rc.2`, while the
working context identifies `0.17.0-rc.3` as the release candidate.

A stress result must record the exact loaded implementation version. Add a
startup assertion or a visible version receipt so a test cannot silently run a
stale extension copy.

## Controls that held

These paths passed during the run:

- 37/37 malformed schema calls were rejected before execution.
- The focused failure-injection set passed 45/45 tests.
- Binding correctness passed 10/10 focused checks.
- Two writers racing one expected version produced one winner and one typed
  `version_conflict` refusal with no lost update.
- Replay tests passed 24 tests. Identical operation replay returned the same
  receipt without a second mutation; changed payload reuse returned
  `operation_conflict`.
- Two independent event streams each observed exact sequence `1..30`.
- Event filtering returned only the requested Task event.
- Successful reads preserved ID uniqueness and ordering.
- Alert fanout preserved the lead-only recipient boundary.
- Worker, Membership, Session, PID, and carrier identities remained distinct.

These controls show that the main weakness is authority availability and
reconciliation under load, not basic schema validation or optimistic-version
semantics.

## Recommended repair order

1. Fix or isolate Beads/Dolt contention. Add a bounded concurrency test and
   capture timeout rate, p50, p95, and maximum duration.
2. Make every mutation retry-safe with a durable operation receipt. A timeout
   must return `unknown`, not an implicit failure.
3. Replace whole-set `show` calls with bounded pages and resumable
   reconciliation. Do not advance a cursor or watermark after an incomplete
   authority read.
4. Add capability-aware Task assignment. Reject or reroute Tasks that require
   lead-only tools such as `team_sync` or `worker_stop`.
5. Make lifecycle cleanup recoverable after partial shutdown. Persist a Team
   terminal state and the exact unresolved Task set.
6. Add correlation and duration fields to model-visible QA receipts without
   exposing payloads.
7. Add an exact loaded-version assertion and rerun the test through the Terra
   proxy wrapper.
8. Give full QA bounded case-level timeouts and always write a partial result
   artifact.

## Handoff status

The run produced durable runtime evidence under
`~/.pi/teams/rc-stress-16/`, including `events/team-events.jsonl`, Team config,
Membership records, runtime records, and Task delivery records. The Team lead
could not complete normal reconciliation because the Task authority timed out,
and the final Team observation reported `no_active_team`. Preserve this runtime
workspace for diagnosis; do not delete it until the Beads state is reconciled.
