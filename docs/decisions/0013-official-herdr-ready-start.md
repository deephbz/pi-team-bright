# Decision 0013: Use the official Herdr ready-start command

Date: 2026-08-19
Status: accepted
Architecture impact: none
Supersedes: decision 0012 rules 3, 4, and 8 only

## Decision

Use one official Herdr Worker-start command:

```text
herdr agent start <carrier> --kind pi --pane <pane> --timeout 6000 -- <pi arguments>
```

Validate the returned `agent_started` record, canonical Pi command, exact name
and pane, detected Pi kind, and `interactive_ready: true`.

Do not probe or request `--wait accepted`. Do not keep an unsupported-option
fallback or capability cache. Herdr owns the 6,000 ms interactive-readiness
bound. Pi Team Bright keeps its ordinary 3,000 ms exact Session-binding
observation after carrier readiness. An explicit binding-observation environment
override still wins.

Keep the two failure detectors distinct. The Herdr timeout bounds interactive
readiness. It does not bound or prove exact Membership and Session binding.

## Reason

Released Herdr 0.7.5 and 0.8.0 support `--kind`, `--pane`, and `--timeout` for
`agent start`. They do not support `--wait accepted`. The accepted-start option
existed only in uncommitted local prototype worktrees and never entered Herdr
Git history or a release.

The prior adapter attempted the unsupported command after pane creation. It
fell back only after the exact local parser error, then cached that result for
the adapter process. This was safe against duplicate actuation, but it made an
unreleased prototype part of production control flow.

One supported command is correct by construction and removes accidental policy
from the shared terminal adapter. An explicit 6,000 ms official timeout also
avoids Herdr's 30-second default failure bound without delaying successful
starts.

## Performance

Official Herdr installations already used the ready-wait fallback. This change
does not add a successful-start wait to supported deployments. It removes the
first failed parser round trip and bounds Herdr readiness failures at 6,000 ms.

The earlier protocol-17 prototype measured accepted actuation near 65 ms p95,
compared with about 3,059 ms for interactive readiness. That result remains
historical experiment evidence. The official CLI cannot provide its response
boundary, so Pi Team Bright does not claim that result for this release.

Configured-model registry validation, stable Worker reuse, removal of leader
Task reconciliation, exact binding, generation fencing, and compensation remain
unchanged.

## Consequences

The Herdr adapter has one start argv and one response validator. The
accepted-start capability cache, parser fallback, accepted response projection,
per-pane binding budget, and terminal-adapter timeout hook are removed.

Unpublished custom Herdr binaries lose their prototype-only fast path. Released
0.7.5 and 0.8.0 behavior remains supported.

Concurrent `ensure_worker` performance is separate deferred work. Its shaping
context is [`worker-ensure-concurrency.md`](../projects/worker-ensure-concurrency.md).

## Reversal criteria

Revisit the response boundary only after Herdr publishes a documented operation
in a released version. Integrate that exact public contract through an explicit
version or capability boundary. Do not detect it through a speculative
actuation attempt.
