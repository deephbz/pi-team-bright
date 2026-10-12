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
generated trace campaigns → migration check (live reload, lead first) → docs,
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
   between runs. The simulator guards fs calls fail-closed to that tree. The
   only file timestamp read as time is the lock-file mtime, and `lock.ts`
   writes it from `clock.now()` (millisecond precision). A failed metadata
   write after exclusive create removes only that exact new owner. One Node loop serializes synchronous fs sequences that separate
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
| G1 | bound, lastStop `new`, `resume` or `fork` | `attention` (`session_switched`). The process left this Worker Session. No reuse, no spawn. `worker_stop` on such a Worker deactivates the Membership and keeps the pane, because a human now uses it. |
| G2 | bound, lastStop `reload`, process `live` | Before re-admission: `attention` (`reload_pending`, hint `wait`). The same Session and exact generation re-admitting after that stop clears it; an older re-admission never clears a newer stop. Then the bound + live row gives `reuse`. |
| G2 | bound, lastStop `quit`, process `live` | `attention` (`stopping`). Never spawn while the generation lives. |
| G3 | unbound, launch `none` | `create` only when no candidate exists: process `gone` or none and no pending launch id. Otherwise `attention` as G4. |
| G4 | unbound, launch `refused`, process `live` or `stopping` | `attention` (`candidate_live`, hint `wait`, pane id). |
| G4 | unbound, launch `refused`, process `unknown` | `attention` (`verifier_unknown`, hint `ask_human`, pane id). |
| G5 | unbound, lastStop not `none` | Ignore lastStop; the launch row decides. |
| G6 | prepared row text "Herdr unknown" | Read as launch `unknown`. The plan never reads the terminal. |
| G7 | action vocabulary | Add `attention` with `reason` and `nextActionHint`. |
| G8 | carrier absent / invalid | `create` / `refuse` as today. |
| G9 | bound rows | Ignore launch state. |
| G10 | prior refusal evidence | Equals launch `refused` only with decisive no-start evidence for the current launch id. A timeout, a stale refusal or a missing Herdr row stays `unknown`. |

Reload rules from the product review, scoped by the systems review: a Worker
`/reload` journals no carrier event unless `stopping` outlasts the hung-reload
threshold, and the reloaded process re-admits its own generation with a birth
token. Zero `unknown` Workers and zero replayed events hold for healthy
reloads with a supported verifier, a successful re-admission and a preserved
branch. Real death and pane loss during a reload still journal.

## Migration of existing Teams

Preferred: live reload, lead first, then each Worker. The new lead reads
token-less Worker records as `unknown` and never spawns over them; each
Worker's reload re-admits it with a token and keeps its Session context. The
lead's first `team_sync` returns a snapshot with a watermark, so no journal
replay occurs. Fallback: a stopped-epoch upgrade. It discards every Worker
Session, so it serves only when a live reload fails.

## Oracle inputs

Monitors judge PTB only by what the world can see, against world truth at
the same instant. PTB never has to cite its own evidence. The simulator
records a typed history:

- world truth: process births and deaths with generation, pane creation and
  closure with cause (`human` or the acting PTB actor), Herdr and verifier
  faults;
- PTB acts: every exec call and result (Herdr, bd) with actor and call id;
- PTB claims: tool calls and results with call id, journal appends read from
  the world's `team-events.jsonl`, durable runtime and launch records read
  from disk, and lead branch entries (`ptb.team-update` stamps and
  `team_sync` results).

E5 bound: an `ensure_worker` receipt returns within 10 s of virtual time.
Each fake Herdr call costs at most 1 s.

## Data boundary

The PTB repository is public. Real-derived traces stay in
`~/.pi/ptb-sim-corpus/` outside every repository. Committed fixtures are
synthetic or sanitized probe output.

## Not in scope now

- Linux probes A7 and A9: no Linux host access path yet.
- Release or publication.
- Hegel spike.
