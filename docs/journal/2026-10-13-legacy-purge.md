# Graph-only legacy purge

Stage: hardening. Decision: [0024](../decisions/0024-graph-only-task-authority.md).
Implementation completed after the decision date. This record does not authorize
publication, deployment, or changes to live Team stores.

## Scope and ownership

Graph snapshots now own every Task operation. New Team creation persists an
explicit empty snapshot before it reports success. Task reads, Worker transitions,
views, Coordination, diagnostics, stop guards, shutdown guards, and startup
recovery use that authority. New configs omit the retired backend fields.

The change removes:

- The Beads adapters, Task store, backend provisioning, migration commands,
  materializer, runtime dependency, and tests that exercise only those paths.
- `formal/`, its 27 files, `scripts/formal-check.sh`, `verify:formal`, and the
  Java/TLC CI job. Production adversarial and process-recovery tests remain.
- Internal Alert, inbox, delivery, Team-event, model, Worker-launch, Task-card,
  and version-reference facades. Consumers import canonical owners and inject
  required ports. The unwired nudge-record adapter and port are removed.
- The simulator backend wire fake, differential check, and archived-source
  migration lane. The archived source depended on the removed backend.
- Dead fixtures left after the causal-path tests moved to focused graph tests.
  The machine inventory now points to current tests and states their separate
  boundaries. It makes no continuous real-Pi journey claim.

Shared publication contracts moved to `src/task-authority/publication.ts` before
the cutover. Coordination projections moved to their semantic owner. The
in-memory model-tool fixture uses the production graph controller and card
projection. Historical native Session, event, and delivery readers remain;
these readers grant no authority to mutate the retired backend.

`predefined-teams.ts` remains outside this purge. Its template behavior needs a
separate model-role/product review. Historical decisions, journals, simulator
fixtures, and result files remain unchanged.

## Store cases

| Store | Result |
| --- | --- |
| New Team | Explicit empty graph; no `.beads/`; first graph apply and restart work. |
| Valid graph with obsolete backend fields | Graph authority wins; reads, transitions, and delivery need no external backend. |
| Graphless Beads Team | Task operations and work-dependent stop/shutdown refuse; `.beads/` bytes remain unchanged. |
| Missing or corrupt established graph | Task authority is unavailable; never an empty Task set. |

The graphless refusal is: “This Team keeps its Tasks in Beads. PTB 0.24 does not
support it. The data stays in .beads/.” No export, migration, or fallback reader
remains. The operator can finish the old Team with its original version or
preserve its store and start a new Team.

## Delivery recovery

A committed Task can outlive a failed delivery enqueue. Worker startup reads its
recovery record, validates the current graph version and recipient binding, and
enqueues a deterministic delivery once. Retirement and receipt records prevent
duplicate presentation. Exact captured Membership and Session targets never
retarget to a replacement Membership.

The lead ratified a bounded rule for pre-0.24 records without captured targets:
if the current graph version matches and the current assignee is the recorded
recipient, recovery binds the current exact Membership as a fresh assignment
recovery. Otherwise it persists one Task/version/recipient diagnostic and retires
the record. Malformed recovery JSON remains as retired diagnostic evidence.
Startup does not crash or invent missing Task meaning.

## Simulator boundary and P7

P7 retains its original rule: carrier-observation publication never writes Task
authority. The monitor compares only carrier publications and graph writes with
the same exact actor coordinates and tool-call ID. Time overlap cannot attribute
a write. Missing exact attribution produces N/A with
`insufficient_attribution`. A legitimate `task_graph_apply` write and its Task
event do not violate P7.

The history records graph-write tracing capability and exact graph-write origins.
Journal fsync records appended rows before injected commit-then-error failure.
The existing sampling path retains raw evidence. Monitor tests include a pass,
a violation, an overlapping unrelated write, a legitimate graph mutation, and
unattributed history. Older result files remain historical evidence; this change
does not relabel their verdicts.

The live rc.1/rc.2 migrations replace the removed archived-source migration lane
as bounded operator evidence. The [rc.2 notes](../release/v0.24.0-rc.2-release-notes.md)
record defects found through the live rc.1 runs and their repairs. These live
observations do not prove every old-store or reload schedule.

## Verification anchors

- `src/task-authority/graph-only-cutover.test.ts`: new empty graph and first
  apply, restart, obsolete fields, graphless refusal with unchanged bytes,
  real stop/shutdown guards, missing/corrupt snapshots, failed enqueue recovery
  at Worker startup, and no backend spawn.
- `src/task-authority/graph-recovery-records.test.ts`: targetless recovery,
  stale versions, assignee mismatch, retirement, and malformed records.
- `src/utils/worker-task-update-version-ref.test.ts`: exact leader and Worker
  registrations, opaque-version reads, claim, and stale CAS refusal.
- `src/task-graph-view/integration.test.ts`: graph view integration.
- `sim/monitors/monitors.test.ts`: exact P7 attribution and missing-evidence cases.
- `scripts/verify-observation-package.cjs`: packed artifact excludes the retired
  dependency and model-checker sources; public observation imports still work.

The cutover commit `5156038` passed typecheck and the fast lane with 157 files,
1938 tests, and 3 skipped tests. The run used a PATH without `bd` and no installed
`native/bin`. The formal-removal commit `9f5750e` passed six production
publication-window tests. Facade removal `77176e0` passed typecheck, 83 focused
tests across nine files, and all 11 release-P1 tests. The focused acceptance run
passed 80 tests across five files.

The release-P1 exact-stop test also failed against an isolated extraction of
`5156038` with `native/bin` absent. Its fixture lacked a birth token and boot ID
and mocked the obsolete PID-only seam. The corrected fixture supplies a synthetic
exact generation and mocks generation absence through `hostEnv`. Its assertions
stay unchanged. Production stop policy stays unchanged.

The exhaustive preflight found additional fixture gaps. Process-recovery and
adversarial CAS fixtures now persist an explicit empty graph. Lifecycle fixtures
now create logical Workers and assert the graph-apply receipt before testing
stop guards. They verify that shutdown retains the unfinished Task unchanged.
The Task-surface fixture now uses its exact bound lead Session and calls the
registered tools without legacy argument or result rewriting. A description
assertion now matches the accepted current `team_sync` contract.

The full v3.1 campaign passed on base `e5c93a8` in 751 seconds and on cutover
`9f5750e` in 705 seconds. Both used the same no-backend PATH and no installed
`native/bin`. The first base launch failed before Vitest started and supplies
no timing evidence. The earlier 240-second outer cutoff was too short; the
measured duration is pre-existing. The final gate reruns the full campaign at
the final source revision without reducing seeds, runs, or schedule families.
Generated campaign results remain outside this change.

Known limit: `npm run probe:model-tools` fails before script execution with
`ERR_PACKAGE_PATH_NOT_EXPORTED`: `No "exports" main defined` for the installed
`@earendil-works/pi-ai` package under the existing ts-node loader. The lead
confirmed that loader failure is pre-existing. This purge retargets the probe's
fixture but does not redesign its loader. Registered-tool tests remain the
executable interface evidence. The accepted Task result records the final
aggregate, package, lane, privacy, and line-count receipts.

## Change size and architecture

The shared-owner commit `c2a70a9` changed 7 files (+200/-197 lines). The coherent
cutover `5156038` changed 164 files (+1383/-16264 lines). The model-checker removal
`9f5750e` removed 982 lines across 30 files. Facade removal `77176e0` changed
62 files (+196/-918 lines). Final base-relative totals include
facade removal, current documentation, and generated observation declarations;
the final Task evidence records the exact committed diff.

Architecture impact: **changed** inside PTB's Task authority, persistence, and
recovery boundaries. HyperCarrier's canonical diagram keeps PTB internals opaque.
The public Membership-observation protocol and deployment topology stay unchanged.
No package version, tag, publication, or parent composition changes in this work.
