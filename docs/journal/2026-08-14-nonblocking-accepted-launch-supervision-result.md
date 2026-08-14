# Nonblocking accepted-launch supervision result

Date: 2026-08-14

Status: completed exploration. Architecture impact: none. No production behavior
changed.

## Finding

Do not replace synchronous Worker observation with a nonblocking accepted-launch
path. The prototype proves a possible supervision shape. It does not prove a
safe production path.

The installed Herdr client is version 0.7.5. Its `agent start --help` has no
accepted-start option. It waits for interactive readiness. Thus no live
accepted-actuation measurement exists in this result. The prototype uses a
synthetic exact accepted response only ([the raw artifact](artifacts/2026-08-14-nonblocking-accepted-launch-supervision-results.json)).

## Measured evidence

Seven fresh isolated source-coupled samples measured response through durable
Membership preparation, synthetic accepted actuation, target persistence, and
the durable `accepted` operation record. They measured 39.739 ms p50 and
55.209 ms p95. Later exact Session, runtime-generation, and `session_bound`
evidence measured 18.882 ms p50 and 50.948 ms p95.

Seven bound stable-Worker reuse samples measured 7.917 ms p50 and 16.947 ms
p95. This is the only reusable-capacity case in the prototype. These values do
not measure real Herdr, Pi startup, or full `ensure_worker` latency.

All adversarial probes completed. They covered early exit, live-unbound timeout,
pane loss, binding at expiry, concurrent ensure, leader restart after target
persistence, stop, shutdown, and Task delivery before binding. Each terminal
unbound case recorded exact owned cleanup. The expiry race retained the carrier
when exact binding won. The delivery adapter refused the pre-bind recipient
([the raw artifact](artifacts/2026-08-14-nonblocking-accepted-launch-supervision-results.json)).

The source snapshot at commit `45cad03` treated a live prepared carrier as
reusable. Its prototype design refused that action. This is historical source
evidence, not a claim about the integrated planner. The later integrated-source
recheck records the current planner behavior separately.

## Prototype shape

One durable operation has an ID, Membership ID, launch capability, target,
deadline, state revision, and cleanup receipt. It moves through `prepared`,
`accepted`, then exactly one terminal state: `bound`, `failed`, `expired`, or
`cancelled`. Binding requires the exact current Membership, durable Session,
runtime generation, and `session_bound` event.

The operation persists its terminal unbound state before cleanup. Cleanup holds
the exact Membership lease, stops only its owned target, confirms absence, and
deactivates only the same unbound Membership. Stop and shutdown first mark the
operation cancelled. A restart can reconstruct `accepted` from the durable
Membership target and its bench-only operation fence.

## Recommendation

Reject this as a drop-in production replacement. It needs a production-owned
operation authority, a durable Membership operation fence or atomic outbox,
leader-restart reconciliation, explicit deadline ownership, exact cleanup
receipts, and a tested positive Herdr accepted-start contract. It also needs
real-carrier tests for process exit, pane loss, TTY behavior, crash recovery,
and delivery order.

Keep exact Session binding as the only admission gate. Keep Task delivery after
that gate. Reuse only stable bound Workers. Do not infer a 100 ms full ensure
result from this synthetic response distribution.

## Reproduction

Historical source commit: `45cad03`. The raw artifact remains unchanged.

```sh
bun benchmarks/nonblocking-accepted-launch-supervision/run.ts --samples 7 --adversarial-samples 1
```

The source bundle is
[`benchmarks/nonblocking-accepted-launch-supervision/`](../../benchmarks/nonblocking-accepted-launch-supervision/).
The machine-operable result is
[`artifacts/2026-08-14-nonblocking-accepted-launch-supervision-results.json`](artifacts/2026-08-14-nonblocking-accepted-launch-supervision-results.json).
