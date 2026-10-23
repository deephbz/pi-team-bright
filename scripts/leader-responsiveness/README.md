# Leader interaction regression probe

Task: reproduce or bound rc.4 Leader pane freezes using real keyboard input,
reuse existing Pi/authority fixtures, and preserve a next-incident recorder.
Acceptance requires quantified input/abort evidence, a detected positive control,
explicit cache conditions, and no assertion that the original incident is fixed.

```sh
npm ci
npm run probe:leader-responsiveness -- --output /tmp/ptb-tui.json
npm run probe:leader-responsiveness -- --diagnostics --pairs 1 --output /tmp/ptb-tui-instrumented.json
npm run test:freeze-diagnostics
npx vitest run scripts/leader-responsiveness/workload.test.ts
```

Requires Linux, Node 22/24, Python 3 and installed package dependencies. The
runner uses real Pi 0.83 (the package's pinned dev dependency), its native editor,
Escape handler, tool cancellation signal and PTY output. `run.mjs` reuses
`LocalProviderFixture` from the existing team-sync scenarios; `run.py` reuses the
stdlib PTY approach of `tui-empty.py`. No API key, remote provider, real Worker,
existing tmux/Herdr pane or user Session is used. Temporary HOME/agent/project
and cache directories prevent changing a live installation. Production PTB is
explicitly loaded alongside the test extension.

Each cold/warm pair uses an empty then retained TMPDIR, with fresh Pi processes
and Sessions. Startup reports spawn-to-first-ready-output and first-key echo;
this is whole instrumented Pi startup wall time, **not PTB-only CPU time**. The
fixture's imports also require transforms. File count documents cache use, not
individual transform hits. Three pairs run by default.

In the first warm process, a 10 synthetic Worker / 300 Task / 10,000 journal
fixture is prepared. Its service uses real graph authority, journal reads,
locking, asynchronous fsync/rename, updates/snapshot queries and repeated graph
revisions. Runtime/alert carrier evidence is synthetic. `updates` can correctly
return `unsettled`; this is not a fully live Team or public `team_sync` tool
execution. Graph revisions accumulate across the three 2-second samples: this
intentionally tests sustained work, not three identical fresh graphs. The
fixture ignores cancellation to expose the distinction between dispatch and
completion; that behavior must not be attributed to every production tool.

Three cases, three samples each:

- `async`: a non-cancellable 2-second timer, control for waiting without CPU work.
- `coordination`: repeat the real durable operations for at least 2 seconds.
- `block`: intentionally block JS for 700 ms; a subsequent async grace period
  keeps the tool active so queued Escape can reach its abort signal.

For each sample the external Python process injects a unique editor token during
work, then Escape 20 ms later regardless of whether echo arrived. Kernel ECHO
must be off. The observer measures unique token bytes emitted by Pi after ANSI
removal; this is **PTY output echo**, not physical screen paint. Node hrtime and
Python monotonic clocks are compared on Linux. Escape dispatch, abort signal,
and agent-end are distinct measurements. Missing evidence/timeouts fail; no
samples are dropped. A 100 ms budget gates healthy echo and abort delivery; the
700 ms control must delay both by more than 400 ms. The process exits nonzero on
violations, while preserving JSON. Small sample counts support maxima/ranges,
not production p99 or a universal latency guarantee. JSONL sidecars contain only
controlled fixture event metadata, not raw terminal/session/provider content.

The recorded rc.4 run fails the 100 ms gate under accumulated graph revisions.
This is a reproducible latency regression scenario, not proof of the original
freeze's root cause. Read the journal report for measurements and remaining
real-Team/macOS/Herdr/rendering gaps. An optional diagnostic run perturbs timing
and must be kept separate from the uninstrumented baseline.

For the next incident, use the [opt-in external watchdog](diagnostic.md). It
starts before jiti, observes main-loop heartbeat loss independently, and
correlates payload-free tool lifecycle and stdin dispatch records.
