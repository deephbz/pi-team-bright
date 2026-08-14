# Nonblocking accepted-launch supervision prototype

This disposable benchmark tests a source-coupled supervision design. It returns
an `ensure_worker` response after Membership preparation, synthetic exact Herdr
acceptance, and exact target persistence. It does not treat that response as
Worker admission or work capacity.

Run from the package root:

```sh
bun benchmarks/nonblocking-accepted-launch-supervision/run.ts --samples 7
```

The default result is the integrated-source recheck:
`docs/journal/artifacts/2026-08-14-nonblocking-accepted-launch-supervision-integrated-source-recheck.json`.

`2026-08-14-nonblocking-accepted-launch-supervision-results.json` is preserved
raw historical evidence. It captured the old source planner behavior and is not
a current-source result. Do not overwrite it.

Each sample uses a fresh temporary home, Team, event journal, runtime record,
operation store, and synthetic owned carrier registry. The prototype imports
current Team, runtime, lifecycle-publication, Session-admission, bridge, and
stop/shutdown source. It makes no production source change.

The installed Herdr client is version 0.7.5. Its `agent start --help` exposes
only interactive-ready waiting. It has no accepted-start option. The benchmark
therefore validates a synthetic exact accepted-actuation seam. It does not
measure a live accepted Herdr command.

The response interval ends after the durable `accepted` operation record. The
later-binding interval ends only after exact Session binding and runtime
fencing produce `bound`. The runner also tests early exit, timeout, pane loss, late binding, concurrent
ensure, restart, stop, shutdown, delivery before binding, and stable-Worker
reuse. It records observations separately from safety assertions. Only safety
assertions set the exit status. The recheck requires the integrated planner to
refuse a live prepared carrier; it records the returned action and reason.

Read `plan.json` before interpreting results. The JSON artifact is the raw
record. The dated journal result is its human interpretation.
