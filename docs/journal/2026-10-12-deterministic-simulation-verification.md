# Verification strategy: deterministic simulation over the real code (v2)

Status: proposal, revision 2; both observers accepted v1 with changes, and v2
adopts them. Stage: shaping. Companion to
`2026-10-12-state-ownership-and-liveness-proposal.md` (v3.1). No code changed.

## Question

How can PTB verify the v3.1 design semi-formally without a second
implementation in Lean, Coq, or TLA+? The owner asks for property-based
testing, exhaustive testing, and fast simulation of the whole environment,
including OS and filesystem, in virtual time.

## Answer

Test the real TypeScript call chains inside one deterministic runner.

1. Inject narrow capabilities (clock, timers, randomness, filesystem
   primitives, process table, subprocess, Herdr CLI, Pi Session) into the real
   call chains. Fake OS primitives. Never fake PTB algorithms such as the lease
   or the launch bridge.
2. One runnable-operation queue owns every boundary: request arrival, atomic OS
   effect, completion, timer, watcher callback, crash. One `Entropy` source
   chooses the next runnable operation and every fault.
3. Explorers drive `Entropy`: exhaustive tables, bounded DFS, fast-check with
   shrinking, a seeded soak, and later Antithesis.
4. Small history monitors and the simulated world's ground truth form the
   oracle. No monitor reimplements a PTB reducer, and no oracle trusts PTB's
   own coverage claims.
5. Every fake assumption about Herdr, Pi, or the OS cites a recorded
   real-component probe. A fake without a passing probe makes its properties
   advisory.

```
explorers:  exhaustive tables │ bounded DFS │ fast-check (shrink) │ seeded soak │ Antithesis (later)
                                     └──────────┬──────────┘
                                                ▼
                         Entropy → runnable-operation queue (the only scheduler)
                                                ▼
SimWorld primitives: virtual clock/timers · FS ops (rename, O_EXCL, fsync; process crash first)
                     · process table (pid reuse, birth tokens) · Herdr fake · Pi Session (IDs and time injected)
                                                ▼  injected capabilities
real call chains: ensure_worker → launch bridge → lease (lock.ts) → child admission
                  Carrier Observation → journal → lead publisher → compaction gate → branch
                                                ▼
monitors: action-origin log · launch/generation ledger · event-coverage ledger · freshness · world truth
```

## Evidence from PTB history

- **Fact.** `formal/SyncPresentation.tla` models the provider ACK proof as an
  abstract value `valid | absent | rejected`. Its header says "TypeScript
  refinement stay[s] external". Defect 1 lived in that excluded refinement.
- **Fact.** Commit `cfeec66` states that the in-memory fake "previously
  replayed the pending result and hid the defect".
- **Fact.** `test/formal-adversarial/graph-conformance.test.ts` enumerates
  traces over the real `GraphTaskController`.
  `src/coordination/sync-state-traversal.test.ts` drives 888 combinations
  through the real service. Exhaustive enumeration over real code already works.
- **Fact.** Environment access is diffuse. The launch bridge selects its Team,
  runtime, and terminal implementations by direct import
  (`src/team-authority/worker-launch-bridge.ts:1-18`). The lease uses host
  `Math.random`, `Date.now`, `process.pid`, `randomUUID`, and `setTimeout`
  (`src/utils/lock.ts:109,194,207-227`). The lead adapter creates timers and a
  filesystem watcher (`extensions/pi-team-session-adapter.ts:70-115,494-527`).
  The in-memory Pi `SessionManager` generates host UUIDs and timestamps; two
  identical input sequences produced different IDs (systems review probe).

## External sources

- Antithesis, "Hypothesis, Antithesis, synthesis" (D. MacIver, 2026-03-24):
  Hegel runs the Hypothesis engine behind a thin per-language client, which
  gives internal shrinking and a failure database. It describes model-based
  testing. In March it called Hegel weak for concurrent, nondeterministic tests.
  A September maintainer post reportedly describes concurrent stateful work
  (cited by the systems review; not read by me).
- `@hegeldev/hegel` 0.4.7 (npm; `hegeldev/hegel-typescript` README): beta,
  Node 20.11+, libhegel engine in-process through Koffi FFI, `test` and
  `testAsync`. The docs index showed no stateful-test API on 2026-10-12.
- Antithesis docs, "Deterministic simulation testing": pluggable nondeterminism
  (FoundationDB), seeded entropy, state-space exploration, invariant checks.
  Assertion vocabulary: `always` and `sometimes`.
- fast-check 4.10.2 docs: `fc.commands` with `asyncModelRun` and
  `scheduledModelRun`; `replayPath`. `scheduleFunction` starts the call at once
  and postpones only the promise resolution. The scheduler therefore controls
  completion order. It cannot control effect order by itself.

## Execution model

- Each simulated actor (lead, Workers, Herdr, OS) yields at every operation on
  shared state. The runner drains controlled microtasks before the next choice.
- The runner records the legal choices at each step and their bounds. It resets
  all actors for each replay and fails on unexplained host work (a real timer,
  a real file access).
- fast-check generates the choice sequence for this runner. No second hidden
  scheduler runs underneath bounded DFS.
- Exhaustive claims cover only the stated finite boundaries and bounds.
- First milestone: replaying one trace twice yields identical decisions and
  identical enabled operations.

## Properties (revised catalog)

Scope follows the v3.1 contracts. "Fresh" means sampled within the defined
freshness deadline, which includes probe timeout and jitter.

| Id | Kind | Property |
| --- | --- | --- |
| P1 | always | At most one admitted, current process generation per Membership. No stale candidate gains mutation authority. |
| P2 | always | `process: gone` at sample time t ⇒ the world process with that exact boot, pid, and birth token was dead at t. |
| P3 | always | `process: live` is held only while its evidence is fresh. After the deadline it becomes `unknown`. |
| P4 | always | Every reuse or spawn decision cites fresh exact-generation evidence (action-origin log). |
| P5 | always | Every pane close cites a PTB stop request or a human action (action-origin log). |
| P6 | always | At most one outstanding launch reservation per {Membership, prior generation}. |
| P7 | always | Carrier publication never writes Task authority. |
| P8 | always | An independent coverage ledger shows that every eligible journal event at or below the branch cursor is represented on the current branch, or that a snapshot covers it. |
| P9 | always | In healthy operation, no page appears twice on one branch. After a reservation timeout, replay stays within the bounded-replay rule. |
| P10 | always | Each journaled carrier event's `cause`, `paneId`, and `generation` match world truth. `suspectedHumanStop` is false whenever a PTB request caused the stop. |
| E1 | eventually | Observation convergence: assuming fair scheduling, available sources, and bounded calls, a world exit reaches CarrierView within the freshness deadline. |
| E2 | eventually | Branch delivery: assuming the lead stays bound and becomes idle and the compaction hold releases, a converged event reaches the branch. Latency is measured from eligibility. |
| E3 | eventually | Healthy launch: with bounded, healthy admission, a launch completes or reports `unknown`. Deadlock under the lease fails E3. |
| E4 | eventually | `blocked` past the threshold ⇒ one attention per re-arm epoch (a Worker Task event re-arms). |
| E5 | bounded | The `ensure_worker` receipt returns within a fixed virtual-time bound, independent of readiness. |
| S1–S6 | sometimes, per campaign | PID reuse; contended reservation; crash between split and record; Herdr loss during launch; compaction after an update; `suspectedHumanStop` true. |

`sometimes` coverage is checked per campaign or in dedicated witness runs. A
witness that no run reaches fails the campaign.

## Mutant gate

The harness counts as valid only if each mutant on the real production path
fails its own assertion with a minimal recorded trace.

| Id | Mutant | Assertion that must fail |
| --- | --- | --- |
| M1 | shell-based `isAlive` drives reuse | P4: reuse without fresh exact-generation evidence |
| M2 | `prepared` + live shell refuses retry after a decisive refusal | retry follows decisive no-start evidence |
| M3 | launch runs under the Membership lease | E3 |
| M4 | snapshot reads Tasks before the watermark | P8 |
| M5 | receipt waits for readiness (the 300 s wait) | E5 |
| M6 | a page stamps the journal head, or a reservation advances the cursor | P8 or P9 |

`prepared` + live shell refusal stays correct while an earlier start remains
unresolved. M2 targets only the decisive-refusal case.

Gate status (2026-10-13): M1, M2, M4, M5, and M6 fail their assertions, with
passing named controls. M3 survives in both campaign rounds. The bounded-unknown
defense absorbs it, so E3 does not fail within the campaign bound. The literal
all-mutants-killed gate therefore does not hold. M3 is a defended survivor, not a
kill.

## Fake drift control

A `probes` test lane records each probe's output as a fixture. Each fake
behaviour cites its fixture. A fake id without a passing probe record makes its
properties advisory instead of blocking.

| Id | Assumption | Probe | Host |
| --- | --- | --- | --- |
| A1 | `herdr agent list` omits non-agent terminals. | shell-only pane | Herdr |
| A2 | Herdr drops the Team agent name when Pi exits; the pane keeps its shell. | scenario-2 reproduction | Herdr |
| A3 | Pi emits `session_shutdown(quit)` before process exit. | scripted real Pi, SIGTERM and Ctrl-D | Pi |
| A4 | Pi queues a custom follow-up while streaming. | scripted real Pi | Pi |
| A5 | `getBranch()` keeps raw entries after compaction. | scripted real Pi | Pi |
| A6 | `herdr agent start` errors when the pane disappears. | real Herdr | Herdr |
| A7 | Linux `/proc/<pid>/stat` starttime changes on pid reuse. | Linux host | Linux |
| A8 | `herdr agent list` can return a partial result. | real Herdr under load | Herdr |
| A9 | Filesystem rename, exclusive create, and fsync behave as the fake states. | process-crash probe first; host crash later | macOS, Linux |

The scripted real-Pi harness (`scripts/team-sync-continuity-e2e/harness.mjs`,
`docs/maintainers/scenario-verification.md`) runs A3–A5 and the follow-up
queue integration beyond `SessionManager`.

## Language and framework

- **TypeScript stays.** Narrow capability injection gives the needed
  determinism.
- **Effect-TS** is not required. Revisit only if the capability set grows into
  its own effect system.
- **Rust** fits the macOS birth-token helper (`proc_pidinfo`). Rust simulation
  tools cannot run the TypeScript code or the Pi APIs.
- **fast-check first.** A Hegel comparison is optional, after one real defect
  supplies a shrink workload. Check the exact Hegel TypeScript version before
  the spike.
- **TLA+**: add no new models. Retire `SyncPresentation` when Proposal A
  removes its protocol. Keep `PublicationObservation` (commit before
  publication, current delivery, replay, retirement, complete reads;
  `formal/PublicationObservation.tla:182-187`) and `MembershipFence`
  (`NoStaleWrite`). Replace either one only after real-code monitors cover
  each surviving invariant with counterexamples.

## Order

0. **A2 probe**: reproduce scenario 2 and record `herdr agent list` and
   `herdr pane process-info` as the fixture. Needs owner approval because it
   changes live panes.
1. **Exhaustive table** over the v3.1 `planWorkerEnsure` (a pure function,
   `src/utils/worker-ensure-lifecycle.ts:56`) with M1 and M2. This needs no new
   infrastructure.
2. **Runner and minimal SimWorld** (clock, process table, Herdr list) on the
   real ensure and observation chain: replay-determinism milestone, P2–P4,
   P10, E1.
3. **Probes A3 and A5** with the scripted real-Pi harness.
4. **Launch fence** with the real lease and filesystem primitives (process
   crash first): P1, P5, P6, E3, E5, M3, M5.
5. **Proposal A harness**: lead publisher, compaction gate, Pi Session with
   injected IDs and time: P8, P9, E2, M4, M6.
6. **Soak and Hegel spike**: 20 × 50 in virtual time; optional Hegel shrink
   comparison.

No scenario counts as verified until its real call chain fails the mutant
and passes the fix.

## Owner decisions

Resolved 2026-10-13:

1. Probe policy (D3=B): a refuted real-world probe blocks a release only when a
   safety property depends on the faked assumption. Otherwise it blocks changes
   to that fake, and the docs mark the assumption unverified.
2. Linux (D4=C): Linux stays unverified. Probes A7 and A9 have not run. A later
   check runs them.

## Limits

- Simulation checks PTB against its stated model of the environment. Probes
  bound that model; they do not prove it complete.
- Separate real processes can interleave synchronous code that one Node loop
  serializes. The runner's yield points model this only at stated boundaries.
- Host-crash durability stays unclaimed until A9 passes on a host crash.
- No simulator throughput figure is measured yet.
