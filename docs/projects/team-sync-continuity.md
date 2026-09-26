# Team synchronization continuity

Date: 2026-09-26
Status: complete; verified isolated candidate, unpublished
Base: `87e2c7da25dbf7d486780f40856b41032031af55` on the completed model-role candidate
Branch: `codex/team-sync-continuity`

## Required outcome

A leader that finishes a reply must still receive new Team observations.
Framework scheduling must batch accumulated updates by count and maximum delay.
`/teamsync` must perform one immediate observation. It must deliver a real
executed tool result when changes exist. An empty observation must show a TUI
notice without a model turn. An idle Team with unfinished Tasks must not hold a
wait open. A productive Worker must keep one wait alive beyond the current
internal timeout. Pi lifecycle APIs own activity evidence; timers only schedule
batch delivery or recover missed notifications.

## Boundaries

Task state, Worker runtime activity, pending delivery, leader observation, and
model attention remain distinct. Quiescence does not mean Task completion.
Unknown runtime or authority evidence does not prove quiescence. Exact Team,
epoch, Membership, Session, branch, and presentation evidence fence observation.
No background read alone advances the model-observation cursor.

The implementation extends the existing Coordination and Pi Session adapter.
It does not introduce a broker or a new Task authority. Live settings, installed
package selection, and publication remain outside this isolated change.

## Verification rounds

1. Inspect latest Pi APIs, current runtime evidence, and independent observer
   feedback. Record supported presentation and wait mechanisms.
2. Implement the shared observation path, scheduler, and command. Test boundary
   behavior independently of timing and model compliance.
3. Run real Pi scenarios for delayed and count-triggered delivery, empty manual
   sync, unfinished idle Tasks, and active waits across internal deadlines.
4. Challenge branch changes, aborts, reload, duplicate events, admission changes,
   failed presentation, and unavailable evidence. Repair demonstrated failures.
5. Review the final diff independently; run integration and package checks;
   audit every required outcome against current evidence.

Product and systems observers review each substantive round. Independent
verification owns end-to-end evidence. Source and native runtime results must
support completion; a test count alone is insufficient.

## Round 1 findings

The existing runtime publishes exact Worker `agent_start` and `agent_settled`
evidence. It already treats settled Workers as quiescent without requiring Task
completion. Its productive wait expires after one internal interval and returns
`indeterminate` even when the Worker remains active. The delayed nudge asks the
model to call sync and therefore still depends on model compliance.

The tagged [Pi 0.87.1 extension API](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/core/extensions/types.ts)
provides commands, lifecycle events, custom messages, and context transformation.
It does not provide imperative native tool execution. `agent_before_settle` can
continue with custom entries but cannot append a native tool-result entry.

The adapter will execute the shared synchronization operation directly, preserve
an explicit framework-origin execution record, and project that actual result
as a tool call/result pair in provider context. It will not claim that the model
requested the call. Hidden observation acknowledgement requires both the exact
persisted record and its exact structured provider-context result. Native model
calls retain their existing presentation evidence path.

Product review requires batching, no turn for empty checks, and separate idle
and Task-complete states. Systems review requires current identity checks after
asynchronous boundaries, one observation path, and no cursor advance from a
probe. Both observers reject reminders as a substitute for executed sync.

## Rounds 2 and 3

The shared observation service now supports read-only probes, immediate selected
observations, and native waits. Scheduler tests cover count-triggered delivery,
a stable first deadline, busy suppression, skipped-presentation retry, queued
notifications, and stopped generations. Deprecated settings preserve explicit
opt-out and delay until their replacement is present.

Round 2 review found that a resolved presentation callback could falsely mark a
skipped attempt as delivered. Publication now requires a positive receipt.
Automatic empty races stay silent. Empty initial Teams do not trigger a turn.

Round 3 review found stale Membership and failed-provider cursor risks. Selected
observations and acknowledgements recheck exact binding. Provider-request proof
is held until a successful turn. A failed native result cannot retain a pending
lock forever. Pagination and eventless authoritative Task changes are covered
by the shared projection.

Current focused evidence: 19 scheduler/settings/debt tests and 77 core tests
pass; integrated typecheck passes. An actual Pi 0.87.1 command check after Team
creation and snapshot showed the empty notification without a provider request
or Session entry. The full real Worker journey and failure challenges are still
running; these focused results do not establish completion.

## Round 4 findings

The full suite exposed fixtures that acknowledged observations before a
successful provider turn. Those fixtures now dispatch all registered lifecycle
handlers and exercise the successful-turn boundary. Independent review found
three runtime gaps: an unbounded event backlog, duplicate context after failed
presentation, and retry presentation after Team replacement.

Event delivery now selects one nonempty canonical page from a single journal
read. A 251-event regression drains six pages with heads 50, 100, 150, 200, 250,
and 251. Every page requires its own acknowledgement. A later external event
can make an earlier leader-only page eligible for delayed delivery. This keeps
ordered delivery and can require several model turns for a large backlog.

A failed presentation retains the hidden baseline. A fresh execution replaces
an older unacknowledged projection only when both share the exact Team epoch,
Session, cursor, and acknowledged baseline entry. Replacement becomes effective
when its custom message is present on the current branch. Session history keeps
the actual execution records.

## Operational limits

The first observation on a branch remains a complete Team snapshot. A large Team
can consume substantial model context. The journal reader still loads its file
in memory. This change bounds event-result pages and removes repeated full-file
reads within one probe; it does not replace journal storage.

Existing Team epochs keep their resolved policy, including an old delay or
explicit disable. New Teams use the new defaults. Automatic delivery receives
one retry after provider failure. Repeated failure shows a warning and pauses that batch
until manual `/teamsync` recovery. Cancellation also requires manual recovery
for that batch. Empty automatic races remain silent.

## Reproduction

Run `node scripts/team-sync-continuity-e2e/run.mjs` with Node, Python 3, tmux,
and installed package dependencies. Set `PI_TEAM_SYNC_TEST_PI_CLI` to test a
specific Pi CLI. The harness creates an isolated HOME, agent directory,
loopback scripted provider, and private tmux server. It verifies the actual
leader and Worker executable paths. It does not use live provider credentials
or an existing terminal server.

Architecture impact: changed inside Pi Team Bright. Coordination owns
observation and acknowledgement; the Pi adapter owns scheduling and context
presentation. HyperCarrier keeps Pi Team Bright opaque in its canonical
Structurizr source. Its component, dependency, and deployment topology do not
change. Parent adoption and publication remain separate work.

## Round 5 verification

Final source review found and repaired retry presentation after Membership
replacement and overlapping automatic/manual retries. The controller now checks
current identity after its asynchronous binding read and shares one in-flight
guard across retry and fresh execution.

Actual Pi 0.87.1 checks passed active waits across internal deadlines, idle
unfinished Tasks, delayed automatic delivery, exact provider tool-call/result
projection, Session switch/resume, and the visible empty-command TUI notice.
A real provider-error, abort, and process-reload challenge preserved the hidden
cursor until successful recovery and retained a newer Worker Task note.

The count-trigger scenario exposed a stale snapshot after Task graph creation.
A selected snapshot could reuse a background Task read that began before the
graph commit. Selected reads now start fresh authority reads. Background probes
retain coalescing. A controlled overlap regression proves that the post-commit
snapshot contains the Task and that its next acknowledged probe stays quiet.
The real Pi rerun passed: the post-graph snapshot contained both Tasks, one
Worker change stayed below the threshold, and the second distinct Task change
triggered automatic delivery. The final combined run and aggregate passed.

The real automatic-failure challenge also passed. Two deliberate provider
failures used the same framework record, emitted one recovery warning, and
produced no third request. The hidden cursor stayed unchanged until manual
recovery completed successfully.

## Final result

All five review rounds are complete. Product and systems observers found no
remaining material defect. The final full suite passed 1,084 tests; four tests
were skipped across two files. Typecheck, test-lane closure, packed observation
import, installed canonical settings example, generated declarations, and diff
checks passed.

The combined real Pi 0.87.1 run passed all five primary journeys and both
failure challenges. The leader and Worker used the same verified Pi executable.
The provider received adjacent framework tool-call/result pairs. The persisted
Session kept explicit framework-origin records. Empty RPC and real PTY checks
made no provider request. These checks used a loopback scripted provider and
actual Pi processes; they are not an authenticated production-provider canary.

The implementation is isolated on the stated branch. No publication, parent
adoption, or live-settings edit occurred. The operational limits above remain.

## Default tuning

The owner selected a 20-second batch delay and a threshold of three projected
changes. The canonical settings resolver and runtime fallbacks share these
defaults. Explicit settings and stored Team policies retain their values.
Scheduling, idle gating, and retry behavior are unchanged. This is parameter
tuning within the verified implementation; it adds no architecture change.
The preceding full-suite and real Pi evidence predates this parameter tuning.
Focused verification passed: 30 settings, scheduler, adapter, and framework
execution tests; typecheck; canonical example parsing; and diff checks.
