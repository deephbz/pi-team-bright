# Linux real-scale run: 4 leads × 25 Workers

Stage: hardening. Architecture impact: none. Base: 0.24.0-rc.2 (`9c7dd67`).

## Setup

- Host: the same Ubuntu 24.04 host as the [A7/A9 probes](2026-10-13-linux-host-probes.md),
  16 cores, 31 GB RAM.
- Pi 1.2.0, Herdr 0.9.3, Node 22.22.2. The host's Pi settings and extensions match
  the maintainer laptop. The default model and the magpie provider are the exceptions.
- Model: `openai-codex/gpt-6-luna` for the 4 leads (medium) and the 100 Workers
  (`default-worker` role, high).
- One isolated Herdr session at 420×130, with one workspace per lead.
- Each lead got the same prompt: create a Team, run `ensure_worker` 25 times, and apply 26 Tasks
  (25 hash Tasks, each Worker with one, plus one summary Task that needs all 25). Then supervise with `team_sync`.

## Result

All 104 Task results are correct. Each Team has 25 correct hashes and a correct summary.
The journal cursors increase strictly. The check reads `events/team-events.jsonl`.

| Team | First event to summary | Intervention |
| --- | --- | --- |
| l2 | 101 s | none (its lead first misread the skill path; a model error) |
| l4 | 104 s | none |
| l3 | 724 s | human `/reload` of one Worker |
| l1 | 924 s | lead alert to one Worker; human `/reload` of another |

- All 25 Workers in each Team bound to their Sessions within 7–23 s.
- Peak: 105 Pi processes, 23.6 GB RSS (max 267 MB each), 9.9 GB free memory,
  load average 21.8. Herdr listed 104 agents with no failed list call.
- All 4 leads ran `team_shutdown` at the same time. Each took about 60 s. All 100 Workers
  stopped and their panes closed. No Task was left unfinished.

## Findings

### F1: A failed Task-authority read disables a Worker's delivery permanently (high)

Fact: 2 of 100 Workers (l1/w15, l3/w06) showed this startup error:
`bd ... list ... database is locked by another dolt process` (timeout).
It came from `reconcileTaskChanges` in `TaskChangeDelivery.start`.
`RecipientDeliveryLifecycle.activate` then stopped both the direct pair and the Task pair and
rethrew the error. Neither Worker ever received its Task. The lead's alert then returned
"Alert accepted", but no turn followed. `ensure_worker` reused the live Worker and
reported `actuation_pending` indefinitely. A human `/reload` recovered both Workers at once.

Inference: when many Workers start at the same time, they contend for the embedded Dolt lock.
This repeats the Beads/Dolt contention tail of the rc.3 stress run.
Owning invariant: a temporarily unavailable Task authority must defer delivery
activation and retry it. It must not end delivery for the Session. Session-ready
reconciliation already applies this rule ("ready delivery is deferred"); the first
`reconcileTaskChanges` does not.

### F2: An idle Worker that holds an `in_progress` Task gets `nextActionHint=wait` (medium)

Fact: after l1/w14 ran its command, its provider stream closed (`WebSocket closed 1000`).
It never recorded the result. `team_sync` reported
`activity idle; agent_status=done; nextActionHint=wait; nonterminalTaskIds=t14` with
0 Alerts, and the lead waited. One `alert_send` recovered it.
This is the known Worker progress-recording limit with a new cause: a provider
disconnect. The hint does not let the lead know that it must act.

### F3: An alert receipt does not show whether a recipient can receive (medium)

Fact: for F1 Workers, `alert_send` returned "Alert accepted by w06; Task state unchanged".
The recipient's delivery lifecycle was inactive, so no turn followed. The receipt
records persistence only.

## Not covered

- 20 leads × 50 Workers. That size needs about 120 GB of memory with real Pi
  processes, and this host has 31 GB.
- Host crash, a shared Herdr outage, and Worker replacement at scale.
