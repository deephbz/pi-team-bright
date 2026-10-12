# WorldTrace extraction

This offline adapter reads local Team stores and their referenced Pi Sessions.
It emits the contract in [`../trace-format.ts`](../trace-format.ts).
It imports no PTB store readers. Those readers can repair or migrate stores.
Production authority, delivery, and launch behavior do not change.

Run from the package root:

```sh
npx ts-node sim/extract/index.ts
npx vitest run sim/extract/extract.test.ts
```

The CLI has no output-path override. It writes only to
`~/.pi/ptb-sim-corpus/`. Each run gets a separate directory. `manifest.json`
and `REPORT.md` identify the current run. Sources stay read-only. Output
files use mode `0600`; new directories use `0700`. The adapter refuses
repository output and symlink directory redirection. It prints only counts.
Never copy empirical output into a repository.

`reconstruct.ts` owns the projection and incident rules. It replaces identities,
paths, unknown keys, numbers used as identities, and all prose with opaque refs.
It preserves known tool names, schema keys, enum values, and safe count fields.
Refs remain stable within one trace. They have no reverse map in output.
Unknown tools do not enter traces. Historical PTB tool names remain unchanged.

The report separates observed incidents from candidates. An aborted turn does
not prove Escape. A generation change does not prove a kill. A stale runtime
record does not prove the current process is dead. Missing explicit evidence
produces no OS or human action. Native Session JSONL normally lacks such events.
Explicit lifecycle/input event exports are supported when present. The source
adapter never creates these records.

A matching `team_create` before config creation starts the lead window.
Otherwise config creation bounds the window. The first observation anchors
`pi.start`. A different Team creation ends unqualified lead actions. Entry ids
suppress copied history per actor. Timestamps merge the remaining observations.
These are partial histories, not a claim about the active Session branch.
Assumption ids record lossy treatments in each trace. Redacted arguments do
not guarantee executable replay against every historical tool version.

The report contains counts for all step kinds, including zeros. It also reports
missing sources, malformed records, snapshot coverage, and source digests.
Task/runtime snapshots qualify evidence and provenance. They never become
fabricated model calls. Live source reads are not an atomic snapshot.

[`../fixtures/traces/`](../fixtures/traces/) contains ten hand-written cases:
restart, Escape, PID reuse, cursor replay, stale binding, pane loss, clock gap,
shutdown/resume, a Worker that never starts, and a dead Pi in a live pane shell. They contain no real-derived values. Fixture assumptions
name simulator setup requirements. `extract.test.ts` validates every fixture
and checks privacy, equality joins, time order, uncertainty, and read-only I/O.
Fixture validation proves format conformance; it does not prove simulator
outcomes. Architecture impact: none outside this offline simulation tool.
