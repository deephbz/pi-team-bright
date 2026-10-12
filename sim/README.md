# Deterministic simulator

Stage: consolidation. Scope: C1 verification support. Baseline production:
`14d92fd` (C0 host seam). Integration dependency: `21c2cb5` (C3 and C0 follow-up).
C2 is not present at that tip. The simulator runs real PTB authority algorithms.
Architecture impact: none to production contracts.

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
recorded paths and bounds. A8 is inconclusive; A7 and A9 remain unprobed.
Pane geometry and pane-close process-tree effects remain advisory.

The queue benchmark excludes module loading and real fs. Baseline tests also
print per-1000-operation wall time with both costs included. The last focused
integration trial measured 69.51 ms per 1000 queue operations; scenario 1
measured 5286.05 ms and scenario 2 measured 6229.12 ms with setup and real fs.
These are single trials under concurrent host load, not throughput guarantees.

The integrated default lane passed 1212 tests with 530 expected failures and
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

Nonempty pre-existing Team setup, cross-Session forks, process restart/recovery,
arbitrary shell execution and nonempty Beads task operations remain unsupported.
Worker module graphs preload from actor coordinates and literal ensure_worker
names. Human input is opaque terminal text. Full P/M/E campaigns are unclaimed.

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
