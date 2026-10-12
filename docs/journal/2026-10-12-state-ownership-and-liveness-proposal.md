# State ownership and Worker liveness proposal (v3.1)

Status: reviewer consensus reached; owner ratification pending. Revision 3.1. Stage: shaping. Architecture
impact: changed if accepted. No code changed. Source checked at package commit
`8a8d50b` (v0.23.1), HyperCarrier `6db7ad9`. Two review rounds (one systems
second opinion, one product observer) shaped v2 and v3. The reviews are
private diagnostic artifacts outside the repository. See "Review record".

Contract changes that need owner ratification:

- Proposal A supersedes the successful-provider-turn condition in Decision
  0016.
- Proposal B amends Decision 0018: elapsed time never closes a pane or
  deactivates a Membership.

## Problem

Two defect classes dominate the v0.23.1 defect summary.

- **Class A: PTB takes part in the conversation protocol.** Framework sync
  fabricates a `team_sync` call/result pair, then waits for proof that the
  provider received it. The proof is a matcher over five provider wire formats
  (`extensions/framework-sync-execution.ts:178`). One miss leaves the cursor
  unacknowledged; later syncs replay old events and supersede projected
  history, which breaks prompt-cache reuse (defect 1). Blocking `team_sync`
  waits let Escape look like Worker failure (defect 4).
- **Class B: PTB asks the wrong entity whether a Worker lives.** The Herdr
  `isAlive` probe returns true when the pane exists and has a shell pid
  (`src/adapters/herdr-adapter.ts:449-465`). `planWorkerEnsure` maps
  bound plus live to `reuse` (`src/utils/worker-ensure-lifecycle.ts:66-69`).
  The label `connected` means "a Session file is recorded"
  (`src/coordination/observation-service.ts:27`). A dead Worker whose last
  self-report was `settled` still reads `settled`
  (`src/adapters/durable-coordination-team-runtime.ts:20`). `herdr agent start`
  blocks on readiness, PTB runs it through `spawnSync`, and the adapter closes
  the pane on any start error (`src/adapters/herdr-adapter.ts:382-416`;
  `src/utils/terminal-adapter.ts:154-156`). Defects 5, 6, 7, 9, 10.

Owner-reported operator scenarios (no captured trace; provisional until
reproduced):

1. The lead ensures a Worker. The pane closes or Pi never starts. The lead
   waits a long time, or receives a wrong "alive" answer.
2. The user stops a launched Worker (Ctrl-C twice, Ctrl-D, pane close). The
   lead continues to treat the Worker as alive.

Inferred root cause of both: the probe observes a shell; the label claims a
Worker.

## Rules

1. **State ownership.** When a first-hand authority can answer a question, PTB
   derives the answer. PTB persists only facts that it originates: Team and
   Membership identity, exact Session binding, launch requests, Worker process
   generation, stop evidence, the Task graph, and the append-only Team event
   journal.
2. **Latency.** A derived answer may be cached in memory as a projection. The
   cache records source and `observedAt`, rebuilds from current authorities on
   start or reconnect, and is never persisted or read as authority.
3. **Delivery position belongs to the reader.** The reader's own history holds
   what the reader has seen.
4. **Time is not evidence.** Elapsed time produces attention. Only a
   first-hand fact moves a Worker into `gone` or `refused`.
5. **Unknown fails closed.** `unknown` never authorizes a spawn, a reuse, or a
   `gone` claim. It produces attention with evidence.

Scale target: one host, 10–20 leads, 10–50 Workers each (100–1000 Pi
processes); more than 30 cores and 100 GB RAM. CPU and memory are not the
constraint. Synchronous waits on the lead event loop, subprocess spawns per
probe, full-journal parses, and shared locks are the latency risks.

## Proposal A: the lead's Session branch holds the cursor

```
Team event journal (append-only, sequence N)
        │  fs watch (exists)
        ▼
lead Session adapter: one publisher per Session, idle-only
        │  reservation in memory, owns one page
        ▼
custom message "ptb.team-update"  details: {team, epoch, binding, from, through}
        │  committed only when Pi persists the native entry
        ▼
cursor = max(through) over ptb.team-update entries and team_sync results
         on ctx.sessionManager.getBranch(), scoped to current team epoch
         and authorized lead binding
```

- Delivery appends; it never rewrites or supersedes history.
- No provider acknowledgement. "Delivered" means "a native entry on this
  branch". This is historical presentation. It does not prove current model
  knowledge. After compaction removes the payload from context, the lead uses
  a fresh `team_sync snapshot`.
- **Reservation arbitration.** Automatic publication stays idle-only. While a
  reservation owns a page, a competing `team_sync updates` returns the
  existing nonblocking `observation_in_progress` result. The reservation ends
  on one of three events: the native entry appears, a branch, Session, or
  binding change invalidates it, or a bounded failure timer fires. The timer
  releases only in-memory ownership; it never advances the cursor. If the
  compaction gate drops a held send, the next read replays from the branch
  cursor.
- `/tree` to a point before an update recomputes the cursor from the selected
  branch and receives the missed events. A fork copies cursor entries into a
  new Session; the fork stays unbound, so copied entries never activate a Team.
- `team_sync updates` reads `since = branch cursor` and returns at once. A page
  stamps its own page boundary. It never stamps the journal head.
- `team_sync snapshot` captures a journal watermark before it hydrates Task
  authority (`src/coordination/observation-service.ts:466-480` reads in the
  other order today). A newer Task state can appear early and repeat later;
  that is acceptable. The snapshot is not an atomic cross-authority read.
- Authority-revision reconciliation stays. Task state can change without a
  journal event (`observation-service.ts:300-310`).
- Remove: framework-sync record and ack entries, the provider-payload matcher,
  supersession, `hidden-observations/`, the reader use of
  `events/cursor.json`, and blocking waits inside `team_sync`.
- Keep: `operation_id` replay and version checks on writes; the compaction
  delivery gate; batch scheduling; Worker-side Task delivery with its own
  ACK, tombstones, and resume. Proposal A changes the lead observation cursor
  only.

`SKILL.md` changes in the same release:

- The lead waits by ending its turn. A `ptb.team-update` wakes it. Remove
  "use `team_sync` updates to wait" and the `/teamsync` immediate-check line.
- The lead's last message before a wait names what it waits for, so the human
  can tell waiting from done.
- After a suspected human stop, ask the human before relaunch.
- On `blocked`, tell the human the pane id.

Defect 2 (lost system sections on framework-started turns) belongs to Pi.
Proposal A keeps `triggerTurn`, so it does not fix defect 2.

## Proposal B: one Carrier Observation module owns liveness

### Evidence hierarchy

Each source answers one question. No source answers another source's question.

| Rank | Source | Question it answers |
| --- | --- | --- |
| 1 | Process-generation verifier: recorded pid plus OS birth token | Does the exact Worker process exist? |
| 2 | Worker `session_shutdown` stop evidence, generation-scoped | Did this Pi begin to stop, and with which Pi reason? |
| 3 | Herdr `agent list`: Team-qualified agent name, `agent_session`, `agent_status` | Is a Pi agent in this pane, with this Session, in which activity? |
| 4 | Herdr pane snapshot | Is the terminal location present? |
| hint | Worker self-reported `runState`; Herdr events | Something changed; check ranks 1–4 |

- Only rank 1 sets `process: gone` (verified absence or birth-token
  mismatch). Rank 4 alone never yields `live`; a live shell is never a live
  Worker.
- Rank 2 is stopping intent. Pi emits `session_shutdown` before disposal and
  before process exit (Pi `core/agent-session-runtime.js:296-303`). The reason
  is `quit | reload | new | resume | fork` (Pi
  `core/extensions/types.d.ts:626`). `quit` covers Ctrl-C twice, Ctrl-D,
  SIGTERM, SIGHUP, and extension shutdown alike. `new`, `resume`, and `fork`
  mean the human replaced the Session in that pane: the pid stays live, but
  the binding is dead. The hook records reason, `targetSessionFile`,
  Membership, and process generation. Today it writes no stop evidence
  (`extensions/pi-team-session-adapter.ts:803-828`).
- Herdr `agent list` omits non-agent terminals (`herdr/src/app/agents.rs:367`).
  A missing row cannot tell an intact shell from an absent pane. Rank 4 needs
  its own pane snapshot, or `terminal` stays `unknown`.
- Every observation carries Membership, launch id, and process generation.
  Late evidence about one generation never changes its successor.

### Process-generation verifier

- The Worker records `{pid, osBirthToken, bootId}` at admission. The admission
  timestamp keeps its current meaning; PTB never reads it as OS birth.
- Linux (the production host): `/proc/<pid>/stat` field 22 (`starttime`) plus
  `/proc/sys/kernel/random/boot_id`, with no subprocess.
- macOS: `proc_pidinfo(PROC_PIDTBSDINFO)` start seconds plus microseconds,
  through a native binding or one batched helper. `ps -o lstart=` has
  whole-second precision and can collide on same-second pid reuse, so PTB
  never uses it for admission or recovery decisions.
- Unsupported platform or permission error: `unknown`.
- Observation, admission, and recovery use the same verifier. Today admission
  and recovery refuse any occupied pid, including a reused one
  (`src/utils/runtime.ts:70-102,137-146`).
- A record without a birth token reads `unknown` until the current process
  rebinds or an explicit stopped-epoch upgrade runs. Pre-upgrade Workers have
  no token (`src/utils/runtime.ts:26-33`). `/ptb status` offers a
  human-authorized adoption for a Worker with a present pid, a matching Herdr
  `agent_session`, and no stop evidence. Adoption records the current birth
  token for that pid.

### Transport

Phase 1 uses the CLI the adapter already speaks
(`src/adapters/herdr-adapter.ts:151`). Every poll is asynchronous and bounded,
with one call in flight per source and jitter. Each source keeps a last-good
timestamp. Per lead every 2–5 s: one `herdr agent list`, one pane snapshot,
and one verifier batch. A failed or partial list never means `gone`.

Herdr `events.subscribe` is socket-only, retains 512 events with no resume
cursor, and can drop events silently (`herdr/src/api/event_hub.rs:13`). If PTB
adds it later, it is an invalidation hint only: subscribe, then list, then
reconcile dirty identities, plus a periodic full reconcile.

`agent list` covers the whole host, so per-lead polls duplicate host work.
The benchmark decides whether a shared host poll is needed.

On Herdr socket loss or server restart, mark only Herdr-derived fields
`unknown` and emit one Team-level attention event per outage. The verifier
still reports `process`. A restarted Herdr never authorizes an automatic
relaunch. After reconnect, refresh target identities before placement or
recovery.

### CarrierView and events

```
CarrierView per Worker (in memory, rebuilt on lead start):
  binding:  unbound | bound(sessionFile)
  launch:   none | requested | started | refused | unknown
  process:  live | stopping | gone | unknown      (rank 1, 2)
  terminal: present | absent | unknown            (rank 4)
  activity: working | idle | blocked | unknown    (rank 3, never journaled)
  lastStop: {piReason, suspectedHumanStop, observedAt} | none
  evidence: [{source, fact, observedAt}]
```

Journal these transitions: `binding`, `launch`, `process`, `terminal: absent`
(terminal loss without a process-death claim), and one `blocked` attention.
Each journal event is decision-complete:

```
{ worker, membership, launchId, generation, field, from, to,
  cause: {source, fact}, observedAt, paneId,
  suspectedHumanStop: bool, nextActionHint }
```

- `suspectedHumanStop` is true for a graceful exit or pane close with no
  PTB-originated stop request for this Membership (`worker_stop`,
  `team_shutdown`, compensation). It is a suspicion. No source proves human
  intent.
- `nextActionHint` (`ensure_worker`, `ask_human`, `wait`) is a hint. The
  observation projection adds the Worker's nonterminal Task ids
  (`nonterminalTaskIds`, `src/coordination/observation-contracts.ts:19`). The
  lead reads one line: "gone, holds Task X in progress, suspected human stop,
  pane P".
- `blocked`: one event per Worker per Attempt, armed when `blocked` persists
  past a short threshold, re-armed by the next Worker-authored Task event.
  Exit from `blocked` is not journaled.
- The lead-facing text names the cause. It no longer reads "Worker X failed."
  (`src/coordination/observation-service.ts:646`).
- The human sees `gone` and `blocked` lines in the TUI, rendered from the
  journal event. `/ptb status` and `/ptb doctor` list the CarrierView.

### Worker launch without a blocking wait

```
ensure_worker
  ├─ under the Membership lease (short):
  │    claim one durable launchId for {Membership, prior generation}
  │    a concurrent ensure returns the same launchId
  ├─ release the lease
  ├─ create the pane, record {launchId, target}       ← launch marker first
  ├─ return {kind, launchId, launch: requested, lastStop}
  └─ async: herdr agent start (bounded RPC)
       ok        → launch: started
       refusal   → launch: refused, evidence kept, pane kept
       RPC bound → launch: unknown, attention
     reacquire the lease briefly; accept only a result whose launchId matches
Worker admission presents launchId → session_bound event
Worker-authored Task event → end-to-end proof of work
```

- No lease spans readiness or child admission. Today recovery holds the lease
  that the child's admission needs
  (`src/team-authority/worker-launch-bridge.ts:667-719`).
- No step closes a pane on elapsed time or on a start error. The human can read
  the pane.
- A lead crash between pane split and record leaves a launch marker without a
  target. After restart, PTB reconciles markers against Herdr and the verifier.
  An ambiguous start produces an orphan warning. PTB never retries it blindly.

`planWorkerEnsure` reads `launch` and `process`. It never reads `terminal`.

| binding | launch / process | plan |
| --- | --- | --- |
| bound | process `live` | reuse |
| bound | process `gone` (verified) | exact-Session resume, reported `recovered` with `recoveryMode` |
| bound | process `stopping` or `unknown` | attention, no spawn |
| bound | `lastStop.piReason` in `new`, `resume`, `fork` | ask human; never relaunch into that pane |
| prepared | launch `refused` | first-binding retry |
| prepared | launch `unknown` | attention, no spawn; a missing agent row can precede a delayed start |
| prepared | launch `requested` or `started`, or Herdr unknown | attention, no spawn |

Today `prepared` plus a live shell refuses as `unbound_live`
(`worker-ensure-lifecycle.ts:61-64`), and a relaunch reports `created`
(`src/model-tool-contract/durable-model-tool-team-application.ts:96`).

Recovery of an in-progress Task needs an explicit wake for the exact Session.
The wake changes no Task state and creates no Attempt.

### Scenario walk-through

| Scenario | Today | Proposed |
| --- | --- | --- |
| Pane closed during launch | lead blocks up to 300 s in `spawnSync` | receipt at once; `refused` or `terminal: absent` within one poll |
| Pi never starts, shell survives | `isAlive` true for 300 s, then pane closed | `refused`, or `unknown` plus attention; pane kept |
| User stops Pi (Ctrl-C ×2, Ctrl-D) | shell alive → `ensure_worker` reuses dead Pi | `stopping` at once; `gone` after verifier; suspected human stop |
| User runs `/new`, `/resume`, `/fork` in a Worker pane | binding looks live | binding dead, pid live; ask human |
| Pi crashes or is killed | `settled` stays `settled` | verifier: `gone` within one poll |
| User closes the pane | same, plus stale placement target | `gone` and `absent`; placement skips absent targets |
| Worker waits on a permission prompt | `still_active` every 120 s; human never told | one `blocked` event with pane id |
| Herdr restarts | stored targets stale | one Team attention event; verifier keeps `process` truth |
| Verifier unavailable | n/a | `unknown`, attention, no spawn |
| Shutdown hangs, or reload fails | n/a | `stopping` past a short threshold: one attention with pane id, `ask_human` |
| PID reused | false live, or recovery refused | birth-token mismatch: `gone`; admission accepts the new process |

## Subsystem split assessment

The top-level split (team, task, alert authority; coordination; model-tool
contract; adapters; task-graph view) matches the domain. The split did not
cause these defects. Changes inside it:

1. Add Carrier Observation as the single liveness owner. It replaces logic in
   `utils/runtime.ts`, `utils/sync-liveness.ts`,
   `coordination/observation-service.ts`, and `adapters/herdr-adapter.ts`
   `isAlive`. Launch control stays in the launch bridge and reads the module.
2. Move cursor ownership into the lead Session adapter. Coordination keeps a
   stateless `read(since)` over the journal plus authority reconciliation.

Deferred: about 10k lines of domain logic in `src/utils/`; 24 `durable-*`
adapters (12 are 10–25 lines); the legacy Beads authority behind a composite
guard. These cost navigation but did not cause the defects.

## Scale work

Every journal append parses the full journal under lock and fsyncs
(`src/coordination/event-journal.ts:262-313`), so cost grows quadratically per
Team. The ready-front read takes a Team-wide lock
(`src/adapters/durable-graph-task-authority.ts:174-181`), and each Worker
delivery engine runs a periodic scan (`src/utils/task-delivery.ts:1035,1146-1154`).

Fix: tail-read the journal head, keep a disposable incremental read index,
coalesce reconcile per lead. Define the observation-latency target first.
Then benchmark 20 × 50 Workers with a long journal, simultaneous startup, and
event bursts. Include Herdr list and parse time and Worker-side lock
contenders. Report p95/p99 observation and launch-receipt latency, lock wait,
and subprocess count. Make no capacity claim before the benchmark.

Spot measurement (macOS dev host, not a benchmark): eight batched `ps` reads
of 50 pids took median 32 ms, maximum 47 ms.

## Implementation order

0. Reproduce scenario 2 (verification test 1).
1. Generation identity and fail-closed admission: verifier, stop evidence,
   `planWorkerEnsure` on `launch` and `process`.
2. Durable launch fencing and async launch control.
3. Carrier Observation polls, decision-complete events, lead notification,
   and human surfaces (TUI lines, `/ptb status`, `/ptb doctor`).
4. Proposal A with the `SKILL.md` changes; supersede Decision 0016.
5. Journal tail-read and the scale benchmark.

No owner scenario counts as fixed until its complete path passes, including
lead notification (step 3).

## Verification

1. Throwaway Team. Launch a Worker, press Ctrl-C twice in its Pi. Expect: pane
   keeps a `shell_pid`; the Herdr agent entry loses its Team name; today
   `ensure_worker` reports `reused`.
2. Kill a Worker with SIGKILL. Expect `process: gone` within one poll.
3. Start a Worker whose Pi command fails. Expect a receipt at once, then
   `refused` with the pane kept, then a successful `ensure_worker` retry.
4. Worker at repeated permission prompts. Expect one `blocked` event with pane
   id per Attempt.
5. `/reload` and `/new` in a Worker pane. Expect `stopping` then live for
   reload; binding dead and ask-human for `/new`. A reload that never
   completes yields one `stopping` attention.
5a. Start Pi slowly so that `agent list` has no row while `agent start` is
   still pending. Expect launch `unknown`, attention, and no second pane.
6. PID reuse. Expect birth-token mismatch.
7. Two concurrent `ensure_worker` calls. Expect one launchId and one pane.
8. Lead crash between pane split and record. Expect an orphan warning and no
   blind retry.
9. Herdr outage. Expect one Team attention event and no relaunch.
10. Branch cursor: competing `team_sync` during a reservation, crash before
    persistence, compaction, `/tree` before an update, fork. Expect no
    repeated page in normal operation and no skipped event.
11. Snapshot during concurrent Task writes. Expect no skipped event.
12. Recovery of an ACKed in-progress Task. Expect a Worker-authored Task event
    after the wake.

## Owner questions with reviewer recommendations

Both reviewers recommend the same answers. They need owner ratification.

1. **Release of an in-progress Task held by a `gone` Worker.** Use
   `task_graph_apply` with the new assignee and the exact graph version. A
   revision supersedes the active Attempt with reason `graph_revised`
   (`src/task-authority/graph-control.ts:436-444`). Inspect the affected
   dependent closure before you apply. The apply receipt names the superseded
   Attempt. The old Session receives a tombstone on resume. The lead can also
   `cancel` with evidence (`graph-control.ts:713-715`). No new transition now.
   Carrier loss never changes a Task automatically.
2. **Relaunch after a suspected human stop.** Ask the human first. This is
   skill guidance with no runtime block. A current explicit owner instruction
   to recover counts as permission. `lastStop` in the `ensure_worker` result
   keeps the guidance usable after compaction. The process-generation
   exclusion stays a runtime safety gate.

## Review record

| Round | Systems second opinion | Product observer |
| --- | --- | --- |
| v1 | A accept with changes; B reject as written; split accept with changes | Right target; events not decision-complete; wrong `gone` signal |
| v2 | A accept with changes; B reject (unknown → resume; shutdown read as death; coarse macOS token; no launch fence); split accept; scale and order accept with changes | Lead decision-complete after five fixes (`likelyHumanAction` source, `prepared` plan, `blocked` noise, `nextAction` scope, human visibility) |
| v3 | A, split, scale, order accept; B accept with changes (unknown launch must not retry) | Lead and human decision-complete; add legacy adoption and a `stopping` attention |
| v3.1 | adopts the v3 fix | adopts both v3 fixes |

Remaining disagreement: none. v3.1 applies the three round-3 fixes as the
reviewers stated them; the reviewers did not re-read v3.1. Acceptance is
design-only. Owner ratification and the fault tests remain.

## Evidence that would reverse this

- Pi gains a public framework tool-execution API with persistence and ordering
  guarantees (Decision 0016's reversal condition). The cursor location in the
  branch still holds.
- Verification test 1 shows that Herdr keeps the agent entry after Pi exits,
  or that the pane loses its shell. Then rank 3 or 4 needs revision.
- The benchmark shows the 2–5 s poll misses the latency target. Then add the
  socket subscription as a hint source, or a shared host poll.
