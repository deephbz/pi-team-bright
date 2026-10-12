# v3.1 implementation plan

Status: active. Owner instruction 2026-10-12: implement the agreed v3.1 design
autonomously, verify it with deterministic simulation (fast-check; the checker
is the simulated world), and run the simulator against current code, v3.1
code, reconstructed empirical traces and generated traces.

Design sources:

- `2026-10-12-state-ownership-and-liveness-proposal.md` (v3.1)
- `2026-10-12-deterministic-simulation-verification.md` (v2)

## Base and branches

Base: `8a8d50b` (v0.23.1). Integration branch `v31-integration`. Each change
is one branch off integration; the lead merges.

```
v31-integration
 ├─ v31-seam     C0  host capability seam (behaviour-preserving)
 ├─ v31-sim      C1  simulator core and actor harness
 ├─ v31-props    C1  exhaustive planWorkerEnsure table, monitors, properties
 ├─ v31-probes   C1  fake-drift probes A1–A6, A8 (fixtures)
 ├─ v31-traces   C6  empirical trace extractor and synthetic fixtures
 ├─ v31-cursor   C3  Proposal A: branch-held cursor, ACK removal (rebases onto C0)
 └─ v31-liveness C2  Proposal B: generation verifier, launch fence,
                     Carrier Observation   (starts after C0 merges)
```

Then: simulator against current code (mutant baseline) → merge C2/C3 →
simulator against v3.1 (P1–P10, E1–E5, S1–S6, M1–M6) → empirical and
generated trace campaigns → migration check under atomic reload → docs,
decisions, diagram.

## Shared contracts (lead-owned)

- `src/env/host-env.ts`: `hostEnv()` capability seam. AsyncLocalStorage
  carries one simulated actor's clock, random, process, exec and watch
  capabilities through every await.
- `sim/trace-format.ts`: world traces hold world inputs only.

Amendments after the systems review (`second-opinion-impl-plan`, REJECT of
the first contract draft; all six findings adopted):

1. Filesystem. The world root is the per-process HOME that the test runner
   isolates before any import. Worlds run one at a time and wipe the tree
   between runs. The simulator guards fs calls fail-closed to that tree. Code
   compares only `clock.now()` values; file timestamps are never time
   evidence. One Node loop serializes synchronous fs sequences that separate
   processes could interleave. That limit is stated, not modelled; the lock
   protocol keeps its own multiprocess tests and TLA+ fence.
2. Execution. `HostExec.run` is bounded and async, with `exited`,
   `spawn_failed`, `timeout` and `aborted` outcomes. `timeout` and `aborted`
   leave the effect unknown. Baseline blocking waits use `runSync` and
   `sleepSync`; other actors make no progress during the block
   (assumption `S-sync-block`). The baseline claim is narrowed to that model.
3. Callbacks. Simulated timers, watchers, exec completions and Pi hooks run in
   the registering actor's context and drop after that actor generation exits.
   `enterSimulation()` makes host access outside an actor throw.
4. Traces. Steps carry actor coordinates, semantic Pi navigation and source
   faults. Tool arguments may cite earlier results. A replay receipt holds the
   scheduler choices separately from the input trace.
5. Seam inventory. `cwd`, `platform`, `sleep` and `sleepSync` join the seam.
   Production generation wiring is a C2 integration gate.
6. Order. C2 stacks on merged C0; C3 rebases onto C0 after it merges.
   Migration defaults to a stopped-epoch upgrade. A live reload of a running
   Team is tested only if a reload barrier and its partial-failure path are
   defined.

## Lead rulings on planWorkerEnsure gaps

`ensure-table` (prop-author) found ten gaps in the v3.1 table. Rulings follow
the five rules of the proposal; the owner may reverse any of them.

| Gap | Case | Ruling |
| --- | --- | --- |
| G1 | bound, lastStop `new`, `resume` or `fork` | `attention` (`session_switched`). The process left this Worker Session. No reuse, no spawn. |
| G2 | bound, lastStop `reload`, process `live` | `reuse`. Reload keeps the generation; the reloaded hook re-admits it. |
| G2 | bound, lastStop `quit`, process `live` | `attention` (`stopping`). Never spawn while the generation lives. |
| G3 | unbound, launch `none` | `create`. |
| G4 | unbound, launch `refused`, process `live`, `stopping` or `unknown` | `attention`. A candidate generation may still bind; unknown fails closed. |
| G5 | unbound, lastStop not `none` | Ignore lastStop; the launch row decides. |
| G6 | prepared row text "Herdr unknown" | Read as launch `unknown`. The plan never reads the terminal. |
| G7 | action vocabulary | Add `attention` with `reason` and `nextActionHint`. |
| G8 | carrier absent / invalid | `create` / `refuse` as today. |
| G9 | bound rows | Ignore launch state. |
| G10 | prior refusal evidence | Equals launch `refused`. |

Reload rules from the product review: a Worker `/reload` journals no carrier
event unless `stopping` outlasts the hung-reload threshold, and the reloaded
process re-admits its own generation with a birth token. A Team reload
therefore leaves zero `unknown` Workers and zero replayed journal events.

## Data boundary

The PTB repository is public. Real-derived traces stay in
`~/.pi/ptb-sim-corpus/` outside every repository. Committed fixtures are
synthetic or sanitized probe output.

## Not in scope now

- Linux probes A7 and A9: no Linux host access path yet.
- Release or publication.
- Hegel spike.
