# 0007 — One live ProcessBinding per current Membership

Status: accepted

A current Membership admits at most one live Pi process generation. Exact Pi
Session equality is necessary but does not prove process exclusivity.

[`src/utils/runtime.ts`](../../src/utils/runtime.ts) owns runtime-startup
admission. It permits a prepared first claim with its exact launch capability,
an idempotent same-process re-entry only after Session binding, and a sequential
exact-Session resume only after `ESRCH` exit evidence. Missing, malformed,
wrong-Membership, live, permission-denied, and unknown PID evidence refuses.

[`extensions/index.ts`](../../extensions/index.ts) applies admission under the
exact Membership lease before lifecycle or terminal writes for teammates and
leads. `worker_ensure` reserves a recovered carrier target and compensates only
that candidate when persistence fails. It does not claim readiness or progress.

The executable evidence is
[`src/utils/runtime-startup-admission.test.ts`](../../src/utils/runtime-startup-admission.test.ts),
[`src/utils/session-lifecycle.test.ts`](../../src/utils/session-lifecycle.test.ts),
and [`src/utils/ergonomic-tool-contract.test.ts`](../../src/utils/ergonomic-tool-contract.test.ts).
The accepted independent receipt and its limits are
[`docs/journal/artifacts/2026-07-30-one-live-process-binding.json`](../journal/artifacts/2026-07-30-one-live-process-binding.json).
