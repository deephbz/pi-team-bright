# Decision 0018: Preserve Worker launch behavior under load

Date: 2026-10-10
Status: accepted
Architecture impact: none
Supersedes: timing rules in decisions 0012 and 0013

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
Check only the current launch Membership's terminal target. Carrier liveness
never proves admission or Task progress.

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
publication test verifies exact terminal-adapter dispatch. Existing Herdr,
admission, and compensation tests protect unchanged fences and cleanup.
These checks do not establish a supported Worker-count capacity or a measured
maximum contention latency.

## Reversal criteria

Revisit the ceiling if supported workloads approach it or Herdr changes its
maximum. A shorter latency target requires separate workload evidence and
failure semantics. Do not infer launch failure from a percentile target.
