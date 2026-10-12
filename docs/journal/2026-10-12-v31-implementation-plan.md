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
 ├─ v31-cursor   C3  Proposal A: branch-held cursor, ACK removal
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

Amendment to the verification note: the simulated world uses the real
filesystem under an isolated per-world temp HOME. All actors on one host share
`~/.pi`, so a shared real tree is the truthful model. Host access outside that
tree, and any real timer, fails the run. Crash-torn writes stay out of scope
until A9.

## Data boundary

The PTB repository is public. Real-derived traces stay in
`~/.pi/ptb-sim-corpus/` outside every repository. Committed fixtures are
synthetic or sanitized probe output.

## Not in scope now

- Linux probes A7 and A9: no Linux host access path yet.
- Release or publication.
- Hegel spike.
