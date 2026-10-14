# Fake-drift host probes

Stage: exploration. Architecture impact: none.

The opt-in `run.mjs` lane records real-component evidence for the assumptions in
[Fake drift control](../../docs/journal/2026-10-12-deterministic-simulation-verification.md#fake-drift-control).
It does not test PTB authority or launch a Team. It is outside `npm test`.

```sh
node scripts/probes/run.mjs          # all seven probes on macOS inside Herdr
node scripts/probes/run.mjs pi       # A4 and A5 only
node scripts/probes/run.mjs herdr    # A1, A2, A3, A6, A8
```

The runner defaults to the package-local real Pi CLI. Set `PI_PROBE_CLI` to
an absolute `dist/cli.js` path to probe another version. Fixtures record the
Pi, Herdr, Node, OS architecture, date, and source base. The committed run
used Pi 0.83.0 and Herdr 0.9.3. It does not establish behavior for Pi 1.1.0.
A7 and A9 use the separate host-OS lane below.

## A7 and A9 host-OS lane

`host-os/probe.ts` runs the production process-generation, lock, and atomic
JSON modules. `host-os/pidwrap.c` forces PID reuse by cycling the PID space with
short-lived forks; it needs no privilege. Bundle the probe, copy both files to
the host, and use a throwaway HOME:

```sh
npx esbuild scripts/probes/host-os/probe.ts --bundle --platform=node --format=cjs --outfile=/tmp/host-os/probe.cjs
cc -O2 -o /tmp/host-os/pidwrap scripts/probes/host-os/pidwrap.c   # on the host
HOME=$(mktemp -d) node /tmp/host-os/probe.cjs a7 > A7.json        # Linux only
HOME=$(mktemp -d) node /tmp/host-os/probe.cjs a9 > A9.json
```

A7 takes about 72 seconds per trial at pid_max 4194304. A9 takes about two
minutes, mostly the 30-second stale-lock recovery. Replace boot IDs with
aliases before committing a fixture. Neither probe covers a host crash.

## D5 real-Team campaign

`real-herdr-liveness.mjs` runs Proposal B items 1, 3, 5, and 9 with the
production PTB extension, real Worker panes, and an isolated Team store.
Build the native helper first. Use a comma-separated item list for a focused
run. The [D5 journal](../../docs/journal/2026-10-13-real-herdr-liveness.md)
records results and the scoped timeout/outage mechanisms.

```sh
npm run build:process-generation
node scripts/probes/real-herdr-liveness.mjs
node scripts/probes/real-herdr-liveness.mjs 3
```

D5 fixtures replace runtime identities with fixture-local aliases. Failed
runs retain private diagnostics in their temporary sandbox. No Task is
assigned to the idle probe Workers. The harness closes its recorded panes
and verifies workspace removal.

## A1–A9 safety

- The Herdr lane needs explicit live-host permission. It creates one
  throwaway workspace with `--no-focus`. It controls only the returned pane.
- Pi uses an empty HOME and agent directory. A minimal child environment
  removes inherited Team bindings and provider credentials. No PTB extension
  loads. The probe extension rejects provider requests in terminal probes.
- A3 uses `/quit`, Ctrl-D, and SIGTERM on separate owned Pi processes.
- A4 uses the existing harness's loopback scripted provider. No model runs.
  A5 supplies a static compaction summary through the real extension hook.
- Cleanup closes the owned pane and workspace. Fixtures record the pane ID
  and the successful workspace-absence check. The runner removes its sandboxes.
- Fixtures replace home paths, user names, host names, and sandbox paths.
  Agent-list evidence retains only owned agents and the total count.

## A1–A9 predictions and limits

| Probe | Expected witness |
| --- | --- |
| A1 | A live shell appears in process-info and has no agent-list row. |
| A2 | The named Pi row disappears after exit; the same shell returns to foreground. |
| A3 | `session_shutdown` with reason `quit` precedes `process_exit`; the parent observes the PID gone. |
| A4 | A custom follow-up is absent from the held stream's branch; it reaches the next provider request after stream release. |
| A5 | Compaction removes old context while `getBranch()` retains every prior entry exactly. |
| A6 | A start against the just-closed owned pane returns `agent_pane_not_found`. |
| A8 | Concurrent agent-list calls expose an explicit partial-result witness. |

A2 tests Herdr's named-occupant boundary with the same `agent start` operation
used by PTB. It does not reproduce PTB Team admission or Task state. A6 tests
start after close; it does not cover an in-flight disappearance race.

A8 applies read pressure: 64 calls in eight waves of eight concurrent calls.
No partial witness means **inconclusive**. Count changes can reflect normal
agent lifecycle changes and do not prove partial reads. Do not use A8 as a
passing fake-drift gate without a witness.

A4 records an immediate `hasPendingMessages()` sample. Pi 0.83.0 returned
false at that point but delivered the custom message in the next request.
The provider-boundary evidence decides the verdict.

Results live in `sim/fixtures/probes/A*.json`. `holds` applies only to the
recorded version, path, and bounds. An exception exits the runner nonzero;
it must not be treated as a passing probe or replace older evidence silently.
