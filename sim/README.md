# Deterministic simulator

Stage: consolidation. Scope: C1, on base `a992f086017b8924c5c448456573c16452ca655d`.
The simulator runs host primitives and the real PTB extension. It does not replace
PTB authority, launch, lease, or delivery algorithms.

```
WorldTrace -> WorldReplay -> real extension tools/events
                         -> SimWorld -> one Scheduler -> Entropy choice log
                                     -> shared real temp tree
                                     -> process generations / Herdr wire fake
```

Run `npx vitest run sim --reporter=verbose`. `core.test.ts` replays a synthetic
trace twice, then replays its recorded choices. It compares decisions, enabled
sets, history, and assumption use. The focused core and wire lane passed 13 tests.
A single queue-only trial measured 26.38 ms per 1,000 runnable operations. This
excludes setup, Session allocation, and real extension work.

## Actor boundary and C0 blockers

`SimActor` loads `extensions/index.ts`, records registered tools and handlers,
and invokes them through `runWithHostEnv`. It uses the real in-memory Pi
SessionManager. The wrapper injects Session ids, entry UUIDs, and timestamps.
It rejects cross-Session forks until that allocator also accepts injected ids.
The Pi follow-up queue uses the world's operation queue.

The real-extension initialization test remains pending C0 integration. Current
factory initialization reaches `findLeadTeamForSession` through module-time HOME
paths. The guard rejects this access. No full launch or observation property is
claimed by the core replay milestone.

`host-calls.base.json` lists 331 direct-host candidates by file, line, and
primitive on the named base. Generate a current inventory with
`npx ts-node sim/host-call-audit.ts`. Static candidates do not prove reachability.
The observed and high-priority blockers are:

- `src/utils/paths.ts`: module-time `os.homedir()` paths.
- `extensions/index.ts`: process role/env, argv, execPath, cwd, HOME, wall time.
- `extensions/pi-team-session-adapter.ts`: process env/cwd, Date, timers, watch.
- `src/utils/lock.ts`: process pid/kill, Date, UUID, random, timeout.
- `src/utils/terminal-adapter.ts`: direct `spawnSync`.
- `src/adapters/herdr-adapter.ts`: environment, Date, blocking `Atomics.wait`.
- `src/utils/runtime.ts`, `teams.ts`, and journal/publication modules: direct
  time, UUID, process identity, and timers; see the complete inventory.

C0 owns these production changes. C1 changes only `sim/`. The lead requested
that C1 commit before merging the amended contracts from `v31-integration`.
Those contracts change the trace inputs, root policy, and host capabilities.

## Bounds and evidence limits

- Every scheduler choice logs its bound and enabled set. One fast-check seed
  supplies the tape. A supplied tape can be generated and shrunk independently.
  Exhausted tapes and changed replay choices fail.
- Timer, watcher, external-input, and actor callbacks use one queue. Promise
  jobs drain for 64 checkpoints between decisions. Unscheduled async filesystem
  work fails. Synchronous filesystem effects are atomic inside the current
  operation. This does not model instruction-level process interleaving.
- Runtime actor work cannot create a real timer or subprocess. Filesystem guards
  reject path escape, symlink escape, and unowned descriptors. A swallowed
  violation still fails the next world drain. Module imports and fixture setup
  run outside the runtime guard. A9 host-crash durability is unclaimed.
- Herdr assumptions cite A1, A2, A6, and A8 at use sites. Process birth tokens cite
  A7. Pi shutdown, follow-ups, and branch behavior cite A3, A4, and A5. All remain
  advisory until the separate probe lane supplies passing evidence. The fake's
  process-info envelope and geometry need comparison against probe fixtures.
- Unmodeled commands and shell input fail. This lane does not run real Herdr,
  start real processes, test provider behavior, or claim the P/M/E campaign gates.
- HostGuard patches builtin function surfaces while worlds exist. AsyncLocalStorage
  restricts enforcement to actor work. Do not run worlds concurrently with code
  that retains copied builtin function references before guard installation.

Architecture impact: none to production contracts. This is verification support.
