# D5 real-Herdr liveness verification

Stage: verification. Architecture impact: none. Production code is unchanged.

## Result

| Proposal B item | Verdict | Expected | Observed |
| --- | --- | --- | --- |
| 1: Ctrl-C twice | **holds** | Pi stops; its shell survives; carrier death asks the human. | The shutdown hook records `quit`. The generation verifier journals `process: gone`, `suspectedHumanStop: true`, and `ask_human`. Herdr removes the named agent. The same shell returns to foreground. |
| 3: Pi never starts | **refuted** | A prompt receipt precedes `refused`; the pane stays; a later ensure succeeds. | The receipt returns in 241 ms. The Pi executable exits 73 before starting Pi. Herdr times out. PTB records `unknown` with `malformed_start_reply`, then `launch_stalled`. A later ensure returns `attention / ask_human`; it does not start Pi. The same shell pane stays open. |
| 5: `/reload`, then `/new` | **refuted** | Reload preserves the process generation. New invalidates the binding but leaves Pi running and asks the human. | Reload holds: the PID and birth token stay equal, and status returns to `live`. New emits shutdown(`new`), startup(`new`), then shutdown(`quit`). Pi exits. The carrier journals `gone`; ensure returns `launch_stalled / ask_human`. |
| 9: Herdr outage and recovery | **holds** | One Team attention; no relaunch; independent process truth survives; terminal evidence recovers. | An isolated transport shim fails list calls for 11 seconds. Exactly one Team attention appears. Status keeps `process live` and sets `terminal unknown`. Recovery restores `terminal present`. The generation and launch count stay unchanged. |

These verdicts use the final Proposal B expectations. Item 1's historical
`reused` result describes the old defect. This campaign does not request a
relaunch after a human stop.

## Evidence and reproduction

Source base: `d2791cf593749d80002e6228fa69c15e0d4b5f3b`.
The probe branch merged `v31-integration` at `0457658`, then `v31-liveness`.
Host: macOS arm64. Herdr: 0.9.3. Pi: 0.83.0. Node: 25.6.0.
The macOS helper was built before the campaign.

```sh
npm run build:process-generation
node scripts/probes/real-herdr-liveness.mjs
# A focused item run:
node scripts/probes/real-herdr-liveness.mjs 3
```

Fixtures contain expected results, actual carrier events, native `ptb.status`
Session entries, exact launch receipts, process observations, and cleanup
receipts. Each fixture also records the lead's warning notification:

- [Item 1](../../sim/fixtures/probes/real-herdr-1.json)
- [Item 3](../../sim/fixtures/probes/real-herdr-3.json)
- [Item 5](../../sim/fixtures/probes/real-herdr-5.json)
- [Item 9](../../sim/fixtures/probes/real-herdr-9.json)

Runtime identities use fixture-local aliases. The same alias denotes the
same identity within one fixture. Native paths use placeholders.

## Isolation and bounds

The campaign creates an empty HOME, Pi settings directory, Session directory,
and throwaway Team. The leader runs real Pi RPC with the production PTB
extension. Its terminal target is an owned shell pane. Production
`ensure_worker` creates and starts the real Worker panes. Tool calls use
scripted loopback responses; no remote model executes. Workers receive no
Tasks or model prompts.

Every workspace creation and Worker split uses `--no-focus`. The harness
records pane handles from creation responses and checks ownership before
control. All owned panes were closed. Each workspace-absence check returned
`workspace_not_found`. The shared Herdr server stayed running.

A scoped PATH shim adds the isolated HOME and PATH to Worker split commands.
The production Herdr environment allowlist otherwise forwards `PI_*` but not
HOME or PATH. The Pi wrapper removes inherited credentials and supplies the
isolated settings and Session directories. No live Team store is used.

Item 9 faults only the isolated processes' `herdr agent list` and
`herdr pane list` calls. It does not test a shared-server restart. The outage
lasts across multiple normal observation polls. During and after status
entries anchor the convergence claim.

Item 3 shortens only its real `agent start` readiness timeout from 300,000 ms
to 4,000 ms. The failing canonical Pi executable records exit 73. Herdr's
error is valid JSON on **stderr**, with empty stdout. The production adapter
parses stdout and records `malformed_start_reply`. Even if that diagnostic
were corrected, this Herdr timeout alone would not prove decisive no-start
for the production caller. The shell-preservation safety behavior holds;
the required refused-and-successful-retry path does not.

Normal reload completes between observation polls. Its lifecycle trace proves
shutdown(`reload`) then startup(`reload`). Status proves the same generation
returned to live. No claim is made that a transient `stopping` view was sampled.
The `/new` trace independently proves that the replacement Session exits;
this is not an inference from a missing Herdr row alone. The final ensure
classifies the launch as stalled before considering `lastStop: new`.

## Follow-up

The lead received attention alerts for items 3 and 5. Release qualification
must resolve these mismatches or accept revised expectations. This campaign
does not repair production code or authorize a release.
