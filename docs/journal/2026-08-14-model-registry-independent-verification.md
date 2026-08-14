# Model-registry independent verification

Date: 2026-08-14
Status: conditional pass for patch-equivalent `1fdac31` and `bb1fcf8`; no production change
Task: `ptb-worker-startup-opt-pwi` at `v_c8ffebbdd9083fb5`

The machine-readable receipt is
[`artifacts/2026-08-14-model-registry-independent-verification.json`](artifacts/2026-08-14-model-registry-independent-verification.json).

## Result

The isolated checkout at integrated commit
`bb1fcf8f5fd5e39a55239c554e2eb0830ccea3b2` passed typecheck, 49 focused
projection/model-tool tests, 21 launch-compensation tests, and three temporary
registry compatibility tests. No production source changed and no push occurred.

The isolated source commit `1fdac31a99b7b9b3dfd5d9390c48eea8dcb8c723` and
integrated commit `bb1fcf8` have stable patch ID
`f3469d22bdb7d702f5a4614df6d0096572218cb0`. `bb1fcf8` is the cherry-pick of
that source patch. Their parents differ, so their ancestry and full trees differ
as expected. This verification covers the shared patch, not tree identity.

The source maps the current `ensure_worker` context's registry snapshot to the
configured Worker-default validation path only. It keeps the snapshot ephemeral.
The focused checks support explicit-request precedence, then Team-default
precedence, pre-actuation refusal for an invalid configured default, recovery
from the captured Membership model, and bounded CLI fallback only when no usable
snapshot exists. A present empty Set is known-empty and does not invoke the CLI.

A real child Pi process ran an exact-source, first-Worker canary through a
test-only direct carrier. It captured the configured default, achieved exact
Session binding, and submitted Worker-process Task claim and success evidence.
It then recovered with a present empty snapshot and retained the captured model.
A new Worker with a removed configured default refused before Membership or
carrier creation. The Team shutdown stopped the carrier and left all
Memberships inactive. The detached checkout, temporary install home, runtime
tree, and raw test pane were then removed. Herdr reports no matching temporary
agent or pane.

The runtime checked tool results, semantic traces, Team events, and the durable
Worker prompt against catalog leak sentinels. None contained a catalog key. The
receipt retains no model name or catalog.

## Timing boundary

The direct-carrier sample reached `membership_prepared` in 37.928 ms and exact
`session_bound` observation in 557.902 ms. Carrier acceptance was 46.596 ms,
target persistence was 62.677 ms, and child admission was 44 ms. The enclosing
ensure-tool call took 1876.357 ms.

The committed five-sample resolver benchmark reports CLI validation at p50
3270.9278 ms and p95 4464.1951 ms. Snapshot capture plus validation is p50
0.1255 ms and p95 0.8831 ms. That benchmark measures only the removed resolver
stage. The direct canary includes child Pi startup and session admission, so it
does not prove an end-to-end Herdr or TUI latency result.

## Limits and follow-up

A synthetic raw-pane Herdr probe failed before binding with
`agent_name_not_found` because its runner did not own the target terminal. It
compensated its prepared Membership. This is not a product defect, but it also
does not supply an independent live Herdr canary.

The isolated source `1fdac31a99b7b9b3dfd5d9390c48eea8dcb8c723` and its
integrated cherry-pick `bb1fcf8` have the same stable patch ID
`f3469d22bdb7d702f5a4614df6d0096572218cb0`. Different parents explain their
non-ancestry and different full trees. This record validates the shared patch.

Architecture impact: `none`.
