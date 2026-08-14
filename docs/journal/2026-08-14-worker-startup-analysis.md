# Worker startup latency analysis

Date: 2026-08-14

Status: measurement and artifact verification complete; implementation remains.

## Result

The seconds-scale startup floor is not fresh Pi alone. Pi is material, but Herdr currently owns the largest synchronous delay.

Measured p50 values:

- minimal offline Pi RPC readiness: 403.8 ms;
- exact Pi Team Bright RPC readiness: 468.9 ms;
- exact interactive Pi startup estimate: 515.1 ms after removing Pi's deliberate 150 ms benchmark drain;
- Herdr pane split: 9.47 ms;
- Herdr managed `agent start` with the exact extension: 3,047.4 ms;
- recent durable Worker `prepared -> session_bound`: 828 ms;
- warm Pi RPC session replacement: 44.98 ms;
- later in-process exact-extension SDK session creation: 17.44 ms.

Herdr enforces an intentional three-second settle delay before managed-agent `interactive_ready`. Pi Team Bright synchronously waits for `herdr agent start`, although its own exact Session-binding event is usually durable after about 0.8 seconds. This duplicate wait adds approximately 2.2 seconds after the authoritative Worker binding signal is already available.

Cold startup cannot reach 100 ms with CLI flags. Pi's eager static import measured about 335 ms before runtime and extension work. Offline mode and resource exclusions reduce later work but cannot remove this floor.

Warm activation can plausibly reach approximately 100 ms. The current evidence supports a persistent or reserved carrier design, but not a release claim. Exact Membership admission, pane attachment, cwd/model/resource projection, and recovery fencing still require a real end-to-end canary.

## Durable source bundle

- Evergreen performance contract: `docs/projects/worker-startup-performance.md`
- Machine result: `docs/journal/artifacts/2026-08-14-worker-startup-performance.json`
- Evaluator: `scripts/worker-startup-benchmark.mjs`
- Pi Team Bright source revision: `a8e3cb48a6ce3405f86df08114e0a4b73dccdf98`
- Pi: 0.83.0
- Node: 25.6.0
- Herdr: 0.7.5

## Verification

The final evaluator passed Node syntax validation. The machine result passed JSON parsing and `git diff --check` passed. A focused history rerun reproduced 938 matched launches and the latest-day 828 ms p50. A three-sample warm RPC rerun measured 48.01 ms p50.

## Continuation

1. Add a focused timing trace before behavior changes.
2. Prefer a public Herdr non-waiting start acknowledgement. Do not use unchecked `pane run` as an authority substitute.
3. If no public Herdr acknowledgement exists, shape the smallest safe asynchronous adapter contract before coding.
4. Run a real Team canary after removing the duplicate wait. Verify exact `session_bound`, delivery, failure compensation, and recognized-agent cleanup.
5. Shape the warm carrier pool separately. Treat it as an architecture change and preserve distinct carrier, process, Session, Membership, Worker, and Task identities.

No implementation, commit, push, tag, or publication occurred during this analysis.
