# Worker accepted-start launch result

Status: implemented and measured. The architecture impact is none.

The Herdr `--wait accepted` path returns after positive server acceptance. It does not prove Pi readiness, Session binding, or task delivery. Pi Team Bright still treats the exact Membership, runtime generation, and `session_bound` event as the authority gate.

The adapter validates `agent_started`, the expected recognized name and pane, a nonempty terminal ID, and pending or interactive state. It uses the old ready wait only after the exact local v0.7.5 parser rejection: status 2 with `unknown option: --wait`. The adapter caches only that pre-actuation rejection. The observed legacy response has `agent_started`, exact name and pane, nonempty terminal ID, `interactive_ready: true`, and no `launch_pending` field.

A Herdr accepted carrier that misses the bounded exact-binding observation is stopped and its prepared Membership is deactivated. If observation is cancelled after spawn, the same leased reconciliation runs. If exact binding wins, cancellation does not stop the bound carrier. A recovered carrier gets an exact Membership lease and runtime-generation fence before cleanup. A live prepared carrier is not reusable capacity.

The owned-pane evidence is in [the machine artifact](artifacts/2026-08-14-herdr-accepted-start.json). The protocol-17 v0.7.5 backport reduced exact-extension accepted-start p50 from 3047.4 ms to 39.85 ms. It reduced p95 from 3059.3 ms to 64.8 ms. All canary panes and recognized agents were removed.

The current tip client uses protocol 18 and cannot connect to the live protocol-17 server. Use the exact v0.7.5 protocol-17 backport for a live canary, or use an isolated matching server. The remaining risks are slow Pi binding, a failed carrier stop, and a new Herdr response contract. The bounded observer and exact compensation expose these cases instead of treating a pane as Worker capacity.
