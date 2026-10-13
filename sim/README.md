# Deterministic simulator

Stage: consolidation. Scope: C1 verification support. Current campaign
production is `1a8a3f6` (C0, C2, and C3). Baseline production was `14d92fd`.
The simulator runs real PTB authority algorithms.
Architecture impact: none to production contracts.

The [v3.1 result journal](../docs/journal/2026-10-13-sim-v31-results.md) records
1000 generated runs, scale shards, all six witnesses, minimized findings, and
remaining oracle limits. `results/v31/campaign.json` is the machine result.
Earlier baseline and integration measurements below describe earlier trials.

```text
WorldTrace + ReplayReceipt -> real extension tools/events
                          -> SimWorld -> single Scheduler -> Entropy log
                                      -> isolated real HOME
                                      -> process / Herdr / bd wire fakes
```

Run `npx vitest run sim --reporter=verbose` and `npm run typecheck`.
Run the owned bd differential check separately:
`npx vitest run --config vitest.exhaustive.config.ts sim/bd-wire.external.test.ts`.
Run the bounded campaign with
`npx vitest run --config vitest.exhaustive.config.ts sim/campaign.test.ts`.
Set `PI_SIM_RECORD_CAMPAIGN=1` to write `results/current-campaign.json`.
No provider or real Herdr process runs in these lanes.

## Runtime boundary

- `SimWorld` requires the HOME isolated by `test/setup.ts` before imports.
  Worlds run serially per test process. Each world wipes that isolated tree.
- `SimActor` loads real `extensions/index.ts` in a fresh module graph per actor.
  Every graph shares the actual host dispatcher. Loading precedes scheduling.
- Real in-memory Pi SessionManager owns branch behavior. The wrapper injects
  Session ids, entry UUIDs and time. A JSONL mirror supplies the durable Session
  file required by Team creation. Streaming follow-ups use the operation queue.
- Timer, watcher, exec and actor callbacks bind their actor generation.
  Death drops callbacks and pending waits. PID reuse cannot restore an agent.
  The replay actor registry uses the exact boot/PID/birth identity and retains
  dead instances. Replay actor results expose `generation` and `alive`.
  The [generation repair](../docs/journal/2026-10-13-sim-pid-reuse.md) verifies
  stale-handle rejection and exact Session resume on a replacement generation.
- Async exec separates arrival, effect and completion. Timeout or abort leaves
  the effect unknown. Sync operations block other actors under `S-sync-block`.
- Real synchronous filesystem operations are atomic inside one queued callback.
  Guards reject real timers, subprocesses, async fs, filesystem escape, symlink
  escape and unowned descriptors. Swallowed violations still fail the world.
- The actor loader replaces only `ExecBdRunner.run`. Scheduled bd wire supports
  empty-store init/where/list. Provisioning, BeadsTaskStore and Team authority
  remain real. Other bd commands fail closed. The differential lane compares
  normalized outputs and authority fingerprints against owned bd 1.1.0.
  It normalizes workspace paths and generated database/project identities.

## Evidence and limits

`baseline.test.ts` replays the repaired synthetic fixtures directly. Scenario 1
waits 300000 virtual ms, cleans the failed carrier, then admits a real Worker
on retry. Scenario 2 reproduces a dead Pi reported as reused/connected while its
shell survives. Replaying scenario 2 compares receipts, choices, enabled sets,
history, Session branches and process truth exactly. See
`results/baseline-scenarios.json` for the scoped findings.

The pre-C2/C3 campaign in `results/baseline-campaign.json` replayed five of ten
synthetic fixtures twice. Five stopped at explicit simulator gaps. All twelve
fast-check timing/seed variants replayed twice and reproduced dead-Pi reuse.
The generated campaign covers that failure class only. It does not establish
all P/M/E properties. The campaign takes about 34 seconds and runs in the
exhaustive lane.

A1–A6 cite probe fixtures for Pi 0.83.0 and Herdr 0.9.3. They establish only the
recorded paths and bounds. A8 is inconclusive. A7 and A9 cite Linux host probes on the production
modules; A9 also covers macOS. Both cover process crash only.
Pane geometry and pane-close process-tree effects remain advisory.

The queue benchmark excludes module loading and real fs. Baseline tests also
print per-1000-operation wall time with both costs included. The last focused
integration trial measured 25.39 ms per 1000 queue operations; scenario 1
measured 1801.00 ms and scenario 2 measured 4021.55 ms with setup and real fs.
These are single trials under concurrent host load, not throughput guarantees.

The integrated default lane passed 1225 tests with 530 expected failures and
three skips. Both exhaustive simulator tests passed. Typecheck passed.
Expected failures in other lanes do not prove the v3.1 properties.

`host-calls.base.json` records 331 direct-host candidates on the original base
`a992f086017b8924c5c448456573c16452ca655d`. Regenerate an inventory with
`npx ts-node sim/host-call-audit.ts`. C0's executable residual allowlist lives in
`test/host-env-seam.test.ts`. The bd transport override covers its reachable
legacy spawn exception. Diagnostic duration measurements remain nondeterministic
and are not decision inputs.

Entropy tapes contain 65536 fast-check draws. Every choice logs its bound;
scheduler choices also log enabled operations. Invalid receipts and exhausted
tapes fail. Promise jobs drain for 64 checkpoints between queue choices.
Instruction-level process interleaving and host-crash durability are unclaimed.

`migration.v31.test.ts` builds a legacy store through real baseline tools at
`14d92fdc2c7cf0b21f6853ba495d828350901e03`. It extracts production sources into
ignored `dist/sim-migration-baseline`; it excludes baseline tests. Git must contain
that revision, and `tar` must be available. The test preloads separate legacy and
current extension graphs. One world retains the filesystem, processes, panes and
native Session branches across lead-first reloads. Three in-progress Tasks and
exactly 50 baseline journal events precede migration. Assertions cover snapshot
watermarking without replay, token re-admission, Session and Attempt continuity,
carrier reuse, no pane closure, and a stopped-epoch fallback with new Worker
Sessions. An ongoing lead turn stays ongoing across reload; this keeps the first
explicit sync ahead of the idle automatic publisher. Human-action attention
excludes `wait` hints.

The trace runner still rejects nonempty declarative Team setup. Cross-Session
forks, arbitrary shell execution and nonempty Beads task operations remain
unsupported. Worker module graphs preload from actor coordinates and literal
ensure_worker names. Human input is opaque terminal text. Full P/M/E campaigns are unclaimed.

## Oracle history

`history.ts` owns version 1 of the observable history. Runner `sim-c1/5`
returns it in `history`. Every entry has `version`, `sequence`, virtual `at`,
and `origin`. Actor coordinates use `ActorRef`. Origins distinguish human,
OS, PTB actor, setup, and observation. PTB origins can carry tool and exec call
ids. They do not claim to cite PTB's decision evidence.

- `process.birth/death` and `pane.create/close` capture immediate world truth.
  Process facts include exact boot/birth generations. Pane closure retains its
  human or PTB origin. `fault.set/clear` and `world.input` retain source inputs.
- `exec.call/result/effect` expose wire calls, bounded outcomes, and actual
  effects. `tool.call/result/error` expose the public PTB boundary. Calls use
  stable ids. A process death can leave an outstanding call without a result;
  history never fabricates a returned receipt.
- `step.begin/end` bracket each selected queue operation. After its promise
  checkpoint, `HistoryObserver` reads changed files under the world Team root.
  It emits `journal.append/reset`, `durable.runtime/launch/team/record`, and
  `disk.invalid`. Member-held launch fields retain `source: member` and a
  `#members/` location. Separate launch files retain `source: file`.
- `lead.branch` records the current public Pi branch ids. `lead.entry` retains
  each new entry, Team-update observation stamps, and tool-result call ids.
  No PTB store, pending observation map, or in-memory authority is inspected.
  UI, Pi messages, and terminal input have separate typed entries.

Disk entries carry raw JSON plus typed wire fields. Missing legacy fields stay
absent. Sampling order is not disk write order. `at` is the observation time;
a journal's own timestamp remains in `event.at` and `event.raw`. Several writes
inside one queue operation can collapse into one durable snapshot. Journal
lines remain individually visible. Branch entries come from public Pi
SessionManager reads. Host-crash and instruction-level write interleaving
remain outside this model.

`history.test.ts` checks both owner scenarios, call pairing, exact process
generations, PTB cleanup origin, disk observations, and branch-stamped sync
results. It also allows real automatic Team updates to run after idle and
checks their branch stamps. A separate test writes false process claims to
disk and verifies that history preserves them independently of world truth.
C2 generation freshness and reservation fields are absent on production base
`0aa8a85`; the observer does not infer them. E5's independent monitor bound is
10000 virtual ms, as ruled in the implementation plan.

## v3.1 campaign support

`v31-campaign.config.ts` selects the campaign driver. The default is 1000
fast-check samples. `v31-schedules.ts` owns the synthetic schedule families.
The campaign reports missing oracle inputs separately from passing properties.
The lead authorized typed normalization of nested carrier journal fields and
numeric cursor order. Canonical raw bytes stay unchanged. Only the monitor
accessor changed; verdict logic remains independent. Explicit temporal bounds
and assumption classifications are recorded in the result.

Use `npx vitest run --config vitest.exhaustive.config.ts sim/v31-receipts.test.ts`
to verify the persisted counterexamples without rerunning the campaign.

Runner `sim-c1/5` adds delayed Herdr and generation-source completion and a
journal `commit_then_error` fault. The latter throws after the real journal
file descriptor completes `fsyncSync`; accepted bytes remain readable. Delayed
generation reads return the captured sample, so later death or PID reuse can
interleave with publication. `campaign-faults.test.ts` checks those boundaries
and replacement after PID reuse. The simulator identifies each actor's captured
generation independently from occupancy of its old numeric PID.

## Trace validation and simulator assumption registry

The fixture validator accepts only probe ids present in `fixtures/probes` or
S-* ids in this table. Presence does not imply a passing probe. Synthetic tool
arguments use live public schemas. Backward result references defer their value
checks until replay. Empirical arguments remain historical, redacted evidence;
they receive structural validation only. Invalid historical calls are never
silently repaired. Replay checks resolved arguments before execution.

| Id | Meaning and limit |
| --- | --- |
| S-sync-block | A synchronous wait advances virtual time while all other actors freeze. |
| S-first-worker-pane-is-pane-1 | Fresh synthetic worlds allocate pane ids in creation order. |
| S-delayed-call-retains-original-membership | Delayed calls retain their original actor coordinates. |
| S-sync-cursor-owned-by-session | Repeated updates use the real Session-owned cursor; traces supply no cursor argument. |
| S-extraction-partial-observation | Source logs do not describe every world event. |
| S-session-window-from-team-config | Team config bounds the extractor's Session window. |
| S-redacted-tool-arguments | Redaction preserves joins but can destroy live argument patterns. |
| S-lead-start-at-first-observation | The extractor projects lead startup at its first observation. |
| S-assistant-stop-is-turn-end | An observed assistant stop projects a settled turn. |
| S-compaction-record-is-action | A compaction record projects a compaction input. |
| S-branch-summary-parent-is-tree-target | The branch-summary parent projects a tree target. |
| S-initial-workers-from-session-bindings | Existing Worker setup derives from recorded Session bindings. |
