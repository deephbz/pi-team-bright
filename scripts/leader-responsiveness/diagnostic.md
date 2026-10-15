# Capture the next Leader freeze

This is an opt-in diagnostic aid, not a fix or a production extension. It adds
no tool and does not contact a provider. Run the existing Leader configuration
with the preload before Pi loads jiti, and add the diagnostic extension alongside
the normal PTB extension. From this checkout:

```sh
PTB_FREEZE_DIR=/tmp/ptb-leader-freeze \
node --require "$PWD/scripts/leader-responsiveness/diagnostic-preload.cjs" \
  "$PWD/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" \
  -e "$PWD/scripts/leader-responsiveness/diagnostic-extension.ts"
```

Keep your ordinary Pi arguments and PTB configuration. `-e` above adds only
diagnostics; it does not load PTB. Prefer direct `node --require` over a global
`NODE_OPTIONS` setting. Descendant processes inherit an owner marker and are
excluded from instrumentation. Use a fresh directory for each experiment.

The preload timestamps input **dispatch to Node's stdin listeners**, records
only chunk byte count and whether byte 27 occurs, and sends a heartbeat every
100 ms to a separate process. The watchdog emits a `heartbeat_stall` after
500 ms without a heartbeat and `heartbeat_recovered` when it resumes. It
remains alive while Leader's JS event loop is blocked. `preload_start` to
`session_start` covers instrumented startup, including extension loading; it is
not time until the first painted frame. Tool begin/end records have tool name
and hashed call ID, never arguments, results, prompts, paths or typed text.

Each process produces `leader-PID.jsonl`, rotating to `.jsonl.1`. Defaults retain
at most 8 MiB across two files. Optional `PTB_FREEZE_MAX_BYTES` sets each file's
cap (minimum 4096); `PTB_FREEZE_INTERVAL_MS` sets heartbeat interval (minimum
20); `PTB_FREEZE_STALL_MS` sets watchdog threshold (minimum 50). Keep threshold
well above interval. Records contain epoch `at`/`observedAt` and process-relative
`monoMs`, enabling alignment with an external PTY recorder. There are at most
16 in-flight IPC sends and 50 non-heartbeat events per second; the next retained
record reports `dropped`. A saturated recorder cannot provide complete input or
tool correlation. The watchdog exits on IPC disconnect, and never sends signals
to Leader. Logs are created mode 0600 (new directory mode 0700).

Interpret evidence conservatively:

- A heartbeat gap means the process failed to service the timer or send IPC.
  It can indicate synchronous work, CPU starvation, OS suspension, or recorder
  scheduling/I/O delay. It is not a captured JS stack and does not identify root
  cause. Find the last tool begin without matching end and compare external PTY
  timestamps. The watchdog can itself stall if the whole host or its disk stalls.
- Input dispatch is **not physical key arrival**, editor update, terminal paint,
  or Escape cancellation completion. During a blocked loop, Node cannot record
  the input until it resumes. Byte 27 can be an arrow/function-key prefix; it is
  not proof that Escape was pressed. Use the external PTY test for known inputs.
- Timely heartbeats with a frozen pane point toward application state, render,
  terminal transport, or waiting work; they do not establish which one. A tool
  can remain pending while the main loop is healthy. This recorder does not
  promise cancellation of async coordination operations.
- Startup prior to the preload and time to spawn/schedule the watchdog are not
  measured as event-loop blockage. Compare explicit fresh-cache and warm-cache
  runs using the same external harness and keep the cache condition in results.
- Logging perturbs scheduling. Use a local disk, compare enabled/disabled runs
  when measuring performance, and preserve logs promptly after an incident:
  continued operation rotates away old evidence.

Focused self-test (no provider or Pi launch required):

```sh
node --test scripts/leader-responsiveness/diagnostic.selftest.cjs
```

The self-test forces a 400 ms synchronous stall, verifies independent detection
and recovery, input content exclusion, call correlation, bounded flood output,
rotation and shutdown. These are diagnostic-mechanism tests, not a reproduction
of the original Leader pane incident and not real TUI responsiveness results.
