# Worker recovery and Task hydration incident

Date: 2026-07-25

Status: implementation and validation evidence

## Incident

A live Team had one current Session-bound Worker with an assigned open Task.
Its Herdr pane disappeared while the durable Membership and exact Pi Session
binding remained current. A fresh diagnostic Worker launched normally through
Herdr, so backend selection and direct-carrier launch were not the failing
layer.

The lead retried `worker_ensure` for that Worker. Instead of recovering the
missing carrier, the call attempted to hydrate every Team Task through one
`bd show` process per Task. It timed out on an unrelated closed Task assigned
to a different Worker. A second reproduction retried a prepared Worker and
timed out on another unrelated closed Task, proving that both exact-Session
recovery and an unconsumed first-binding retry were gated by the same projection
defect:

```text
bd --directory <teams-root>/<team> --json \
  show <unrelated-closed-task> --long --include-comments --include-dependents
```

The raw tool result and exact Session locators were retained locally during
incident response but intentionally excluded here because they contain local
paths and runtime identities. The operator resumed the exact Worker Session in
a new Herdr pane, which rebound the same Membership and let project work
continue independently of this fix.

## Root cause

Two independent contracts were missing from the implementation:

1. `worker_ensure` treated any current Membership as reusable, even when its
   persisted terminal target no longer existed. It returned `reused` and never
   relaunched the exact bound Session.
2. The reuse branch queried `listTasksWithVersions`, although Task state is not
   required to preserve or recover a Worker carrier. That helper then performed
   one compact `bd list` followed by concurrent full `bd show` calls for every
   Task, including unrelated closed history. `team_sync`, `worker_stop`, and
   shutdown contained variants of the same avoidable multi-process hydration.

The failure therefore crossed two authority boundaries unnecessarily: a
terminal-carrier operation was gated by an unrelated Task projection, and a
single logical Task read set became an N+1 group of independent Beads/Dolt
processes.

## Implemented contract

- Any current Worker with a live terminal target is reused without relaunch.
- If a prepared Worker's target disappeared before first binding,
  `worker_ensure` retries the same unconsumed launch capability in a new carrier;
  it neither creates a replacement Membership nor reads Task authority.
- If a Session-bound Worker's target disappeared, `worker_ensure` launches Pi
  with `--session <bound-session-file>`, using the persisted Worker
  cwd/model/thinking/tools and no first-launch capability. It keeps the same
  Membership and exact Session identity, then records the new backend-qualified
  target.
- If recovery fails, the new target is stopped when possible and the existing
  Membership/Session binding remains current. Failed compensation is explicit.
- `worker_ensure` performs no Task-authority read. It leaves Task state unchanged
  and directs the caller to reconcile assignments through `team_sync`.
- Multi-Task hydration uses one `bd show <id...>` command. Lifecycle guards
  select only nonterminal and, for `worker_stop`, matching-assignee candidates
  before full hydration, then reapply the filter to hydrated results.
- Herdr pane creation now retries only the explicit transient
  `agent_pane_busy` state for up to five seconds. `pane split` can return before
  the new shell reaches its prompt; every other `agent start` error still fails
  immediately and triggers pane-close compensation.

Executable authority lives in `extensions/index.ts`, `src/utils/beads.ts`,
`src/utils/tasks.ts`, and the focused contract tests. This journal preserves the
incident and validation evidence rather than duplicating the stable API.

## Validation

The live Task query for the prepared Worker on the incident Team returned only
its one in-progress Task and emitted a trace with two Beads calls: one `list`
in 717 ms and one matching `show` in 795 ms, 1.533 s total. Querying the
Session-bound Worker after its Tasks had closed made only the list call and no
`show`. This externally verifies that unrelated closed Tasks are no longer
hydrated by the lifecycle query.

The first isolated recovery smoke exposed a second real race rather than
passing accidentally: Herdr `pane split` returned a new pane, but immediate
`agent start` returned `agent_pane_busy`, and PiTeams compensated the prepared
Membership and shut down the smoke Team. That evidence caused the bounded
shell-readiness retry above.

The second fresh-session smoke passed end to end:

- the first assigned Task closed;
- the Worker bound one Membership, exact Session, and Herdr pane;
- after closing only that pane, normal `worker_ensure` returned
  `action: recovered`, kept the same Membership and Session, and rebound a new
  pane without a Task timeout;
- a post-recovery Task reached and was closed by that resumed Session;
- Worker stop and Team shutdown both succeeded.

A separate prepared-Membership smoke also passed: normal `worker_ensure`
returned `action: recovered` with `recoveryMode: first_binding_retry`, kept the
same Membership, consumed the same pending launch capability, replaced the
synthetic missing target, bound the exact resulting Session, and closed its
assigned post-retry Task. Worker stop and Team shutdown succeeded. The raw
smoke artifacts were retained locally during validation but intentionally not
published because they contain runtime identities.

Repository validation passed TypeScript and all focused recovery, Herdr,
Beads-version, Team-event, lifecycle, and compensation tests. An initial
concurrent full run reached 404 passing tests before the known 5-second agent-
surface snapshot timeout; that snapshot passed alone in 2.07 s and the tool-
result QA suite passed alone. The first final full `npm test` run, before adding
the prepared retry branch, passed all 50 files and 406 tests; the complete
implementation then passed all 50 files and 407 tests.

## Follow-up: single Beads list contention

After the recovery commit, the live incident Team exposed a lower-layer failure
in ordinary `team_sync`. The single command below timed out while the lead
waited on two final observer Tasks:

```text
bd --directory <teams-root>/<team> --json \
  list --label pi-teams:<team> --all --no-pager --limit 0
```

This is distinct from the fixed N+1 hydration path: no unrelated per-Task
`show` is needed for the failure. Current assessment is that a Beads/Dolt read
may block under concurrent live Task activity; no root cause or fix has yet
been verified. The next investigation must reproduce the contention with raw
command timing and semantic traces, compare supported read-only behavior with a
bounded read retry, and avoid treating a longer timeout as correctness.

`team_sync` also needs failure isolation by construction. A Task projection
timeout should produce an explicit typed partial result while preserving valid
Team and Worker carrier state; it must not project zero Tasks or fail the whole
composite observation. Low-effort hardening candidates discussed but not yet
accepted or implemented are: normalize persisted Member optionals into an
internal discriminated carrier union; extract a pure exhaustive
`planWorkerEnsure`; type Worker action/recovery results; consolidate the two
recovery executors; add Beads call-budget tests and a table-driven lifecycle
matrix; and permit bounded retries only for read commands with every attempt in
the trace.
