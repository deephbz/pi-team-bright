# Warm activation prototype result

Date: 2026-08-14
Stage: exploration inside hardening
Architecture impact: none
Source commit: `8324307dadf7107494d0485a6974bd192454fbac`

## Result

The seven-sample machine result is complete. Its individual timings and
redacted invariant records are in
[`2026-08-14-warm-activation-machine-results.json`](artifacts/2026-08-14-warm-activation-machine-results.json).
The runner and method are in
[`benchmarks/warm-activation/`](../../benchmarks/warm-activation/).

No production warm carrier is recommended. A fast Session or pane operation
does not prove Worker Membership, exact Session binding, readiness, progress,
or Task authority.

## Measurements

All samples used the explicit `openai-codex/gpt-5.6-terra` and `medium`
profile. They sent no model prompt and used offline mode. Percentiles use
nearest-rank successful samples only.

- Persistent RPC cold start was p50 2877.213 ms and p95 6634.275 ms. RPC
  `new_session` was p50 34.672 ms and p95 81.229 ms.
- Process-warm SDK initial Session construction was p50 8.090 ms and p95
  35.980 ms. SDK `newSession()` was p50 8.082 ms and p95 15.142 ms. Pi was
  imported before each sandbox applied its isolated environment, so these
  measures exclude Node startup and module import/cache cost.
- A fresh Node process that preloaded Pi main took p50 990.829 ms and p95
  1540.849 ms to import. Its one-shot RPC activation was p50 75.613 ms and
  p95 81.719 ms.
- A Bun-bundled, preloaded Pi Team Bright factory took p50 1402.038 ms and p95
  4252.216 ms to import. Its one-shot RPC activation was p50 95.336 ms and
  p95 161.202 ms.
- A new Herdr pane plus unbound interactive Pi carrier was p50 3068.064 ms and
  p95 3563.553 ms. Its local probe command in the live carrier was p50 23.158
  ms and p95 191.846 ms.

This is one machine run under concurrent local work. Its long tails are part of
the result. Compare mechanisms only within this receipt. Use the individual
samples in the JSON before making a capacity or latency claim.

## Facts

Every successful sample projected the fixture cwd, context marker, model, and
thinking level. The RPC and SDK replacements changed both Session identity and
Session file. They kept the same process and retained the probe module while
its factory generation increased from one to two. The changed fixture marker
also changed from `A` to `B` after replacement.

The RPC cancellation probe acknowledged `abort_bash` and returned a cancelled
bash result in 174.108 ms. A killed RPC process recovered only through a new
process and a new Session. All normal RPC, SDK, preloaded-main, inline-factory,
and pane paths emitted a graceful `session_shutdown` record.

The preloaded main and inline-factory launchers had no Pi Session artifacts
before their single activation lease. They had no Team environment at import.
Their pipe-based RPC mode had no TTY. The one-shot failure probes exited and
were not reset or reused. The result records pre-import and Session RSS values.

Herdr named every pane carrier at process start, and the runner read its exact
agent, pane, and process records. It sent a graceful shutdown command and then
closed only its own child pane. The runner then checked exact agent and pane
absence. No temporary warm pane remained after cleanup.

The exact Pi Team Bright factory in an unbound process exposed leader-only
tools and three common Task tools. This is leader-surface evidence, not a
Worker binding. The normal unbound carrier had only four active built-in tools.

## Assessment

RPC and SDK replacement are low-latency Session operations. They retain
process-scoped extension state, launch choices, and resource risk. They cannot
change a process into a new Worker Membership.

The preloaded main path removes import time from one-shot activation. It still
creates a fresh process and has no safe after-the-fact Herdr name or Worker
admission. Preloading the Pi Team Bright factory does not solve this boundary:
it selected the leader surface before Worker admission.

The Herdr carrier proves that a reserved terminal can be named, observed,
commanded, and cleaned. Its fast command is not a safe activation path. It
must not publish runtime evidence or infer work.

This experiment did not create a prepared Membership. It therefore does not
claim exact Worker `session_bound` admission. A future production proposal must
prove that admission, one process generation per Membership, a fresh Worker
resource projection, post-bind Worker-only tools, and failure destruction.

## Ranked decision

1. Keep no production warm carrier.
2. Keep persistent RPC replacement as a benchmark-only Session mechanism.
3. Keep SDK replacement as a benchmark-only in-process Session mechanism.
4. Keep one-shot preloaded main as a lower-bound experiment only.
5. Reject preloaded unbound Pi Team Bright factories as Worker activation.
6. Keep the reserved Herdr carrier as an observed disposable carrier only.

The evidence that would reverse this decision is an isolated distribution that
proves every listed Worker invariant, including exact admission and cleanup,
without reusing a pre-bound Session or exposing pre-bind tools.
