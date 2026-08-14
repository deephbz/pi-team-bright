# Accepted-start binding budget

Date: 2026-08-14

Status: implementation and deterministic verification complete. The required
real accepted-mode Team canary is blocked by the available Herdr client.

## Decision

Keep the ordinary and legacy-ready exact Session-observation default at 3,000
ms. A successful Herdr `--wait accepted` launch consumes a one-time 6,000 ms
default instead.

This is an intentional accepted-path failure-detector policy, not compatibility
with legacy interactive readiness. Installed Herdr documents up to 30,000 ms
for its legacy interactive-ready wait before Pi Team Bright starts its ordinary
3,000 ms exact binding observation. Accepted mode can therefore compensate a
slow binding sooner. The measured durable `prepared -> session_bound` p95 is
892 ms, so 6,000 ms gives about 6.7 times that observed tail while bounding an
unbound-carrier failure.

This is a binding-observation budget. It does not make accepted actuation,
pane presence, process birth, or interactive readiness Worker authority. The
existing exact Membership, runtime generation, and `session_bound` event checks
remain unchanged. `PI_TEAMS_WORKER_STARTUP_WAIT_MS` remains an explicit bounded
override and takes precedence over the adapter default. An operator can set it
to 30,000 ms, but that selects a longer accepted-path observation only; it does
not recreate legacy interactive-ready semantics.

The adapter records the accepted-only default by exact pane ID. The launch
bridge consumes it once for that carrier. Legacy fallback and other terminal
adapters have no such value and keep the 3,000 ms default. Carrier cleanup
removes an unconsumed value.

Architecture impact: none. This changes an internal timing default, not an
authority, component, dependency, or topology.

## Deterministic evidence

The focused full-config lane passed 60 tests:

```sh
npx vitest run --config vitest.full.config.ts \
  src/adapters/herdr-adapter.test.ts \
  src/utils/worker-startup-observation.test.ts \
  src/team-authority/worker-launch-bridge.boundary.test.ts \
  src/utils/launch-compensation.contract.test.ts
```

`npm run typecheck` and `git diff --check` also passed.

The observer accepts exact binding evidence at controlled 2,800 ms, 3,000 ms,
and 3,200 ms delays with the accepted default. It times out at 6,200 ms. An
explicit 3,200 ms override times out at 3,201 ms. A 30,000 ms override accepts
controlled 29,999 ms binding evidence and times out at 30,001 ms. The launch
test proves an unbound accepted carrier is stopped and deactivated before an
exact retry makes a new carrier. It leaves no live first carrier or active first
Membership.

## Canary boundary

`HERDR_ENV=1` was present. Installed CLI help and `herdr agent list` were read
before any control operation. The available installed client documents only
legacy interactive-ready `agent start`; it has no `--wait accepted` option.
The available accepted-start binaries are tied to separate unclean Herdr
worktrees, so this Task must not use them as an exact, reproducible canary
client or modify Herdr.

No disposable Team, pane, or agent was created by this Task. Run the required
canary with an operator-designated clean accepted-start client/server pair. It
must prove one disposable Team's exact Worker Session binding, normal cleanup,
and no retained carrier.
