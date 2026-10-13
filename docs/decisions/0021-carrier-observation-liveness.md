# Decision 0021: Derive carrier liveness from the process-generation verifier

Date: 2026-10-13
Status: accepted
Architecture impact: **changed** inside Pi Team Bright. HyperCarrier keeps these internals opaque.
Amends: [Decision 0018](0018-worker-start-under-load.md). Elapsed time never closes a pane or deactivates a Membership, and liveness comes from the OS generation verifier.
Basis: [Proposal B](../journal/2026-10-12-state-ownership-and-liveness-proposal.md#proposal-b-one-carrier-observation-module-owns-liveness); owner instruction of 2026-10-12 to implement the agreed v3.1 design ([implementation plan](../journal/2026-10-12-v31-implementation-plan.md), including the lead rulings).

## Context

Decision 0018 bounded a hung launch with a 300,000 ms ceiling and checked carrier
liveness through the terminal adapter. Three defects followed. The Herdr `isAlive`
probe returned true when a pane existed with a shell pid, so a live shell read as a
live Worker. A dead Worker whose last self-report was `settled` still read
`settled`. The blocking `herdr agent start` closed the pane on any start error, so
an operator could lose a pane that was still usable. The owner reported two
scenarios: a lead that waits a long time or gets a wrong "alive" answer after a pane
closes or Pi never starts, and a lead that keeps treating a Worker as alive after
the user stopped its Pi with Ctrl-C twice, Ctrl-D, or pane close.

## Decision

1. **Time is not evidence.** Elapsed time produces attention. It never closes a
   pane, never deactivates a Membership, and never sets a Worker to `gone` or
   `refused`. Only a first-hand fact does.
2. **Process liveness comes from the generation verifier.** Admission records
   `{pid, osBirthToken, bootId}`. Linux reads `/proc/<pid>/stat` field 22 and
   `/proc/sys/kernel/random/boot_id`. macOS uses the dependency-free helper built by
   the npm `postinstall` hook. It compiles packaged source with `rustc` and Xcode
   Command Line Tools. If `rustc` is absent, installation succeeds and the hook
   writes one diagnostic naming `npm run build:process-generation` (owner decision
   D1=B). Npm can hide that output. Pi startup therefore shows one native
   missing-helper warning per extension load with the same remedy.
   That command also repairs installs with disabled lifecycle scripts.
   A missing helper produces `generation_helper_missing`
   attention with `ask_human`; the tool result and native admission refusal name
   the helper and build command. This takes precedence over legacy-token and
   launch attention because reload or adoption cannot fix a missing verifier.
   Exact Session-bound re-entry by the same PID remains `already_current` without
   the helper (owner decision D2=A). This does not verify liveness or authorize a
   replacement. Different-PID replacement still refuses with `ask_human`.
   Prepared claims have no completed Session binding and retain their admission
   fence. Both decisions were accepted on 2026-10-13.
   An unsupported platform or a read error
   yields `unknown`. Only verified absence or a birth-token mismatch sets
   `process: gone`. A live shell or a present terminal target never sets
   `process: live`.
3. **Stop evidence is generation-scoped.** The Worker's `session_shutdown` hook
   records its Pi reason (`quit`, `reload`, `new`, `resume`, or `fork`), the target
   Session file when present, the Membership, and the process generation.
   - `quit` covers Ctrl-C twice, Ctrl-D, SIGTERM, SIGHUP, and extension shutdown.
   - `reload` keeps the same-generation `live`/`stopping` pair silent while the
     durable `lastStop` says `reload`. A verified death always journals.
   - `new`, `resume`, and `fork` mean the human replaced the Session in that pane.
     The process can stay live or exit. Pi 0.83.0 exits after `/new`
     (`docs/journal/2026-10-13-real-herdr-liveness.md`, item 5). In both cases
     `ensure_worker` gives `session_switched` with `ask_human`. PTB never
     relaunches into that pane. Stopping that Membership keeps its pane.
     The real run returned `launch_stalled`. Fix 8524df1 returns
     `session_switched` for a bound Worker.
   - Local shutdown intent survives a verifier failure. An exact stop-ID check
     fences older admission work.
4. **Launch returns a receipt without a readiness wait.** `ensure_worker` claims a
   durable launch ID under the Membership lease, records the launch ID before the
   pane split and the target before Herdr agent start, and returns `launch: requested` with the
   receipt. The lease is released before `herdr agent start` runs. That start is a
   bounded asynchronous RPC. Success sets `started`. A refusal sets `refused` and
   keeps the pane. An RPC bound sets `unknown` with attention. A ten-second receipt
   deadline covers claim, nested leases, Herdr preparation, and target
   compare-and-swap. Expiry returns attention and prevents a late start.
   - Only a decisive shell-busy refusal retries, on the same pane and launch ID.
   - An ambiguous start is never retried blindly. Restart orphan reconciliation is
     pending. A lead restart does not yet reconcile markers against Herdr or the
     verifier. Target reconciliation runs in process only.
5. **Publication baseline (lead ruling).** The accepted visible journal events are
   the only carrier publication baseline. There are no durable observation
   checkpoints. Each coordinate starts at `unknown`. Binding, launch, process,
   terminal, and activity changes are journaled in sample order. Terminal `present`
   and `unknown` are low-noise events: they use `wait` and no human toast.
   Herdr `done` maps to activity `idle`: the turn finished and Pi can accept input.
   It does not complete a Task or prove process liveness. Unknown wire statuses
   stay `unknown` and retain their raw value in evidence.
   Debounced `blocked` attention remains a separate event. A failed append leaves
   the accepted baseline unchanged. Healthy polling retries the current source
   difference. A transient observation lost before append is not durable.
   Publication rereads the journal under the Membership lease and fences the exact
   generation and terminal target. Worker admission publishes verified predecessor
   death before it overwrites that runtime generation. It holds the same lease
   through both steps and uses the same publication baseline as polling. A failed
   exit append prevents replacement and preserves the predecessor record for retry.
   This closes the death/recovery race without publishing a stale generation.
6. **Samples expire.** Each observation source owns its sample time. A sample
   expires to `unknown` after six seconds, including when collection fails. A stalled
   read stays single-flight. Derived legacy advice expires with its process sample:
   attention stays `legacy_unverified` / `ask_human`, but its probe becomes unknown
   and asks for verification. Historical journal messages keep their sampled evidence.
7. **Unknown fails closed.** `unknown` never authorizes a spawn, a reuse, or a
   `gone` claim. It produces attention with its evidence. Pre-upgrade records without
   a birth token read `unknown` until the current process rebinds or the human
   authorizes adoption. For a bound tokenless generation, `ensure_worker` returns
   `attention` with reason `legacy_unverified` and hint `ask_human` (G11).
   The carrier projection and `team_sync` also surface this attention. They retain
   the PID and probe result (`absent`, `present`, or `unknown`). An absent PID
   requires human restart of that Worker's Pi in its pane, or stopping the Worker.
   A present PID permits human reload or adoption in `/ptb status`. Unknown probe
   evidence requires human verification first. The missing-helper remedy in item 2
   still applies. The shared message puts the human action before evidence.
   `ensure_worker` retains the model safety rule; human projections omit that rule.
   The adoption confirmation excludes absent PID probes.
   None of these observations verifies a tokenless generation.
   Attention journals once per evidence change under the same generation fence,
   including when the process baseline is already `unknown`. Snapshot `connected`
   describes Session binding only; snapshot attention remains visible after the
   update cursor advances.
   Pending or stalled launch evidence does not replace this attention. It never
   authorizes a spawn. Other unknown-generation planner rows stay unchanged unless
   the verifier reports the missing-helper condition in item 2.

## Consequences

- A pane that closes during launch shows `refused` or `terminal: absent` within one
  poll. The lead gets a receipt at once, and the human can read the pane.
- A Pi that never starts while its shell survives shows `refused` or `unknown` with
  attention. It is not reused and the pane is kept.
- A user stop (Ctrl-C twice, Ctrl-D) shows `stopping`, then `gone` after the
  verifier. The Worker is reported as a suspected human stop. Relaunch needs the
  human's permission; this is skill guidance, with the process-generation exclusion
  as the runtime gate.
- A PID reused by another process shows a birth-token mismatch. It counts as `gone`,
  and admission accepts the new process.
- A Herdr outage produces one Team attention event. No relaunch happens. The
  verifier keeps its own process truth.
- Polling is bounded. Each lead polls its Workers on a 2–5 s cadence with one call
  in flight per source. The benchmark decides whether a shared host poll is needed.
- The journal records only decision-complete transitions. The TUI and `/ptb status`
  render them. `/ptb status` lists the CarrierView.

## Evidence that would reverse it

- Verification test 1 (Ctrl-C twice): Herdr keeps the agent entry after Pi exits, or
  the pane loses its shell. Then the rank 3 and rank 4 rules need revision.
- Verification test 6 (PID reuse) fails to produce a birth-token mismatch on a
  supported platform. Then the verifier's platform support changes, not the rule.
- The benchmark shows that the 2–5 s poll misses the latency target. Then add the
  socket subscription as a hint source, or a shared host poll. The rule still holds.
- A reload leaves unknown Workers or replayed events after healthy re-admission, or a
  real death goes unjournaled. Then the suppression rule must change.
- The owner rules that elapsed time must close a pane for a supported workload.

Executable evidence: [`carrier-observer.v31.test.ts`](../../src/carrier-observer.v31.test.ts),
[`carrier-observer.property.test.ts`](../../src/carrier-observer.property.test.ts),
[`carrier-observation.test.ts`](../../src/carrier-observation.test.ts),
[`v31-receipts.test.ts`](../../sim/v31-receipts.test.ts),
[`migration.v31.test.ts`](../../sim/migration.v31.test.ts),
[`worker-ensure-plan.v31.test.ts`](../../src/utils/worker-ensure-plan.v31.test.ts),
[`process-generation.test.ts`](../../src/env/process-generation.test.ts),
[`process-generation.native.test.ts`](../../src/env/process-generation.native.test.ts),
[`process-generation.install.test.ts`](../../src/env/process-generation.install.test.ts), and
[`process-generation.missing-helper.test.ts`](../../src/env/process-generation.missing-helper.test.ts).
The verification list in [Proposal B](../journal/2026-10-12-state-ownership-and-liveness-proposal.md#verification)
still names the real-Herdr checks that these unit tests do not replace.
