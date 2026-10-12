# Decision 0018: Preserve Worker launch behavior under load

Date: 2026-10-10
Status: accepted; amended by [Decision 0021](0021-carrier-observation-liveness.md) on 2026-10-13
Architecture impact: none
Supersedes: timing rules in decisions 0012 and 0013

## Amendment (Decision 0021)

Decision 0021 changes the following rules in this record:

- Elapsed time never closes a pane or deactivates a Membership. A ceiling expiry
  produces attention, not carrier death.
- Carrier liveness no longer comes from the terminal adapter. The rule "check
  carrier liveness through the terminal adapter" and the "fail promptly on
  carrier loss" trigger are superseded. Process liveness comes from the OS
  generation verifier. A pane shows terminal presence only.
- Launch no longer blocks on Herdr readiness. `ensure_worker` returns a receipt
  at once, and the bounded start RPC runs asynchronously.

The 300,000 ms ceiling, exact Membership and launch-ID fences, and the lock
rules still apply. The text below is the original 0018 record.

## Decision

Contention can delay Worker admission. Elapsed time does not prove launch
failure. Fail promptly on carrier loss, Herdr's agent-exit report, Worker
refusal, or an exact Membership failed event.

Keep a 300,000 ms hang ceiling, Herdr's maximum. Use it for official Herdr
interactive readiness, transient shell-busy retries, and exact binding
observation. `PI_TEAMS_WORKER_STARTUP_WAIT_MS` still overrides binding
observation. A ceiling expiry bounds a hung launch; it remains suspicion.
It does not prove carrier death.

During binding observation, check carrier liveness through the terminal
adapter at a bounded cadence. Report `carrier_gone` separately from `timeout`.
Check only the current launch Membership's terminal target. A read error or
CLI failure leaves liveness unknown. Continue observation until decisive
evidence or ceiling expiry. Carrier liveness never proves admission or Task
progress.

Before shutting down a refused launcher-spawned Worker, publish a failed event
with its launch-environment Membership ID. Preserve that ID when authority
has replaced the Membership. An old refusal cannot fail a newer launch.

Worker admission waits for persistence locks without a wall-clock budget.
The launch ceiling owns hang containment. Preserve lock ownership, heartbeat,
stale-owner recovery, exact Session binding, generation fencing, and
exact-target compensation. Other lock callers keep their existing budgets.

## Reason

The former three-second binding, six-second Herdr readiness, five-second
shell-ready, and persistence-lock budgets could reject a live Worker under
contention. A slower launch must keep the same admission semantics.
A large hang ceiling contains indefinite waits without treating ordinary
contention latency as failure evidence.

## Verification and limits

Deterministic tests cover binding after ten seconds with a live carrier,
prompt carrier loss, exact failed-event identity, ceiling expiry, override
expiry, and admission lock contention beyond the ordinary budget. The durable
publication tests verify exact terminal-adapter dispatch, recovery after
transient probe errors, and ceiling expiry with undecidable probes. Session
hook tests verify failed-event publication before shutdown and stale refusal
isolation. Existing Herdr,
admission, and compensation tests protect unchanged fences and cleanup.
These checks do not establish a supported Worker-count capacity or a measured
maximum contention latency.

## Reversal criteria

Revisit the ceiling if supported workloads approach it or Herdr changes its
maximum. A shorter latency target requires separate workload evidence and
failure semantics. Do not infer launch failure from a percentile target.
