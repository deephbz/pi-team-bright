# rc.4 Leader pane freeze: real TUI probe and incident recorder

Base: `v0.24.0-rc.4`, `0f39e060035d3e113c34deab1e1bd845a8e4e818`.
Task: investigate Leader interaction responsiveness, not Worker missing reports.

## Result

The original incident is **not reproduced or resolved**. A new reproducible
real-Pi PTY workload exceeds a proposed 100 ms input responsiveness budget under
sustained durable graph/journal coordination. This supports keeping the issue
open and gives a regression probe and next-incident capture path.

The completed baseline intentionally exits 1 on its latency gates. That is a
measured failure, not a skipped/unsupported test or a claimed green regression.
No production implementation, cancellation semantics, version or release changed.

## Evidence hierarchy and reusable infrastructure

- PR #30's 10 Workers / 300 Tasks / 10,000 events <100 ms per blocking segment
  and <300 ms cumulative measurements remain **release-reported evidence**.
  No self-contained runner for that exact measurement was located in this tree.
  Existing `scripts/probes/graph-*.bench.test.ts` require unavailable
  `/tmp/ptb-freeze/graph-source/team` data (17 Workers). They were not fabricated
  or run against a substituted fixture as if identical.
- Existing simulator async host/fs parity, async Herdr/process-generation and
  graph-view tests: **52 tests passed**. Virtual-time semantic evidence is not
  keyboard evidence. `sim/replay.ts` maps `human.escape` directly to an aborted
  turn-end event; it bypasses stdin, key routing and real cancellation.
- Existing `src/utils/trace.ts` records completion timings with synchronous
  appends; it cannot show a still-pending tool or independently observe freeze.
- New workload composes real durable graph/journal/CoordinationObservationService
  with synthetic carrier bindings. Its unit smoke passed. Two sampled operation
  wall times: journal 2.60/2.04 ms, updates 63.20/46.97 ms, snapshot 10.77/4.73 ms,
  graph revision 62.77/52.30 ms. These are **wall times, not blocking segments**.
- New PTY path loads actual Pi 0.83.0, production PTB and a test extension; it
  uses the existing loopback `LocalProviderFixture` and existing Python PTY
  technique. It exercises native editor, Escape routing, AbortSignal and
  agent-end. Workers/Herdr and external terminal emulator are not present.

## Completed baseline measurements

Linux / Node v24.19.0 / Pi 0.83.0. Three samples per case, all retained.
The graph starts with 300 Tasks, 10 synthetic Worker bindings, 10,000 events.
Repeated graph revisions accumulate across samples (15, 9, 7 iterations), so
later samples exercise more history. Each iteration includes real journal
append, updates/snapshot reads, and a committed new graph revision.

| Case | PTY key echo ms | Escape → abort signal ms | Escape → agent end ms |
|---|---:|---:|---:|
| 2-second asynchronous wait | 2.58–2.81 | 10.46–11.68 | 1927–1929 |
| Sustained durable coordination | 42.53, 111.26, 163.77 | 42.26, 100.47, 153.29 | 1947–2005 |
| Deliberate 700 ms JS block | 649.41–652.64 | 636.58–637.53 | 1127–1129 |

The positive control is detected, proving the harness does not count the
terminal driver's echo or wait for an echo before injecting Escape. The
100 ms healthy-input gate fails in 2/3 coordination samples for both metrics.
These sparse samples are not p95/p99 estimates or a universal limit. Increased
latency with accumulated revisions is a hypothesis for targeted CPU profiling,
not proof of a particular graph routine or the original incident's root cause.

The test tool intentionally ignores cancellation while awaiting work, making
fast Escape signal delivery distinguishable from eventual tool/agent completion.
The approximately 2-second completion delay must not be generalized into a
claim about cancellation behavior of each production coordination tool.

Three cold/warm pairs (separate fresh TMPDIR for each pair; retained between
cold/warm; fresh Pi process and Session each time):

| Pair | Cold ready ms | Warm ready ms |
|---|---:|---:|
| 1 | 3157 | 1153 |
| 2 | 3273 | 1121 |
| 3 | 3197 | 1093 |

First-key echo after readiness: 10.9–12.7 ms. These are complete instrumented
Pi startup wall times including test imports, not the release's PTB-only CPU
attribution. No startup-time input is injected before raw-mode readiness.

## Opt-in diagnostics validation

The recorder starts before jiti through a Node preload, sends bounded IPC
heartbeat/input metadata to a separate process, and adds payload-free Pi tool
begin/end correlation. The watchdog retains two bounded files, excludes Worker
descendants, and exits on disconnect. It never sends a signal to the Leader.
The self-test passed 2/2: a forced ~400 ms stall was detected, input content was
absent, dropped records observable, flood/rotation bounded, and shutdown clean.

A separate instrumented real-Pi run detected all three deliberate 700 ms blocks:
watchdog recovery gaps 709, 755, 758 ms, with preceding tool-begin and delayed
stdin-dispatch records. It also recorded startup gaps. All 9 test-tool calls
were correlated. That run's coordination echo max was 110.44 ms, so its echo
gate also failed. Its startup timings are not comparable overhead estimates:
typecheck/package verification ran concurrently during part of that run. The
uninstrumented baseline above had no deliberate concurrent verification job.

Heartbeat loss is not a stack trace: CPU starvation, OS suspension and recorder
scheduling/I/O can also explain it. Timely heartbeat with a frozen pane narrows
investigation toward application/renderer/transport state but proves no root
cause. Input dispatch does not establish physical key arrival or screen paint.

## Reproduce / capture next incident

See [probe commands and exact method](../../scripts/leader-responsiveness/README.md)
and [field recorder instructions](../../scripts/leader-responsiveness/diagnostic.md).
Run the recorder alongside the user's ordinary Leader/PTB configuration on the
next live macOS/Herdr Team, preserve both rotated files immediately after a
freeze, and note local incident time. It does not log prompts, tool payloads or
input text. Existing Pi arguments/configuration remain necessary.

Remaining matrix: actual 10 concurrent Worker processes and Herdr panes; user's
Pi version/extensions; native macOS terminal rendering; launch/reload and model
switch overlap; filesystem/CPU contention; long-duration soak; production tool
progress and cancellation completion. No live account or installed Team was
changed for this task. Root-cause analysis needs a live trace or a tighter
reproduction; benchmark success alone is insufficient.

Validation: package typecheck, focused workload test, diagnostic self-tests,
explicit strict typecheck of probe extensions, test-lane closure, and package
verification passed. Broad unrelated suites were not rerun.

Raw artifacts:

- [Baseline JSON](artifacts/2026-10-15-leader-tui.json) and same-prefix event JSONL.
- [Instrumented JSON](artifacts/2026-10-15-leader-tui-diagnostic.json) and same-prefix
  watchdog/event JSONL.
- [Existing/focused test output](artifacts/2026-10-15-leader-freeze-existing-tests.txt).
- [Recorder self-test output](artifacts/2026-10-15-leader-freeze-diagnostics.txt).

Harness development initially exposed two test-driver mistakes: Ctrl-C used to
clear the editor could exit Pi, and the positive-control tool ended before
queued Escape could abort it. The final runner uses Ctrl-U and keeps a bounded
async grace period after the deliberate block. Only completed corrected runs
are the quantified evidence above; no preliminary failed run is claimed as a
production freeze.
