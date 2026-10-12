# Deterministic simulator

Stage: consolidation. Scope: C1. Production base:
`a992f086017b8924c5c448456573c16452ca655d`. Shared contracts are merged from
`7a361cc` on `v31-integration`. The simulator does not replace PTB authority,
launch, lease, or delivery algorithms.

```
WorldTrace + ReplayReceipt -> WorldReplay -> real extension tools/events
                                         -> SimWorld -> one Scheduler
                                                     -> Entropy choice log
                                                     -> shared real HOME
                                                     -> process / Herdr fake
```

Run `npx vitest run sim --reporter=verbose`. The focused lane has 19 tests.
`core.test.ts` replays a synthetic trace twice, then replays its full choice log
and its scheduler receipt. It compares decisions, enabled sets, history, and
assumption use. A single queue-only trial measured 21.78 ms per 1,000 operations.
This excludes setup, Session allocation, and real extension work.
The package lane passed: 152 test files, 2,103 tests; 2 files and 3 tests skipped.

## Runtime boundary

- `SimWorld` requires the HOME isolated by `test/setup.ts` before imports.
  Worlds run one at a time. Each world wipes that isolated tree. Module-time
  HOME paths therefore remain inside the world.
- `SimActor` invokes real `extensions/index.ts` tools and hooks through
  `runWithHostEnv`. `actor-loader.ts` loads a fresh PTB module graph per actor
  through Vitest. All graphs share the real host dispatcher. Native module
  loading completes before the operation queue starts.
- Real Pi SessionManager owns branch and compaction behavior. The wrapper
  injects Session ids, entry UUIDs, and timestamps. Streaming follow-ups enter
  the operation queue.
- Timer, watcher, exec, and actor callbacks capture their actor generation.
  Exit drops queued callbacks and pending waits. PID reuse does not restore an
  old agent name. `enterSimulation()` rejects host access outside an actor.
- Async exec has separate arrival, effect, and completion operations. Timeout
  and abort do not prove that no effect occurred. `sleepSync` advances virtual
  time without running another actor, under `S-sync-block`.

## C0 integration gate

The real-extension factory test passes for lead and Worker projections. On the
baseline it explicitly supplies bootstrap process role variables. C0 must remove
that test stub and enable guarded Session startup and full public-tool replay.
The baseline still calls real timers, time, randomness, and subprocesses.
A guarded `pi.start` probe failed with `Host escape: Real subprocess: spawnSync`.
No full launch or observation property is claimed by the core replay milestone.

`host-calls.base.json` lists 331 direct-host candidates by file, line, and
primitive on the production base. Generate a current inventory with
`npx ts-node sim/host-call-audit.ts`. Candidates do not prove reachability.
High-priority blockers are:

- `extensions/index.ts`: process role/env, argv, execPath, cwd, wall time.
- `extensions/pi-team-session-adapter.ts`: process env/cwd, Date, timers, watch.
- `src/utils/lock.ts`: process pid/kill, Date, UUID, random, timeout.
- `src/utils/terminal-adapter.ts`: direct `spawnSync`.
- `src/adapters/herdr-adapter.ts`: environment, Date, blocking `Atomics.wait`.
- Runtime, Team, and journal/publication modules: time, UUID, process identity,
  and timers. The inventory lists each candidate.

C0 owns production changes. C1 changes only `sim/`.

## Bounds and gaps

- Every entropy choice logs its bound. Scheduler choices also log the enabled
  set. fast-check generates the seed tape. Supplied tapes can be shrunk.
  Exhausted tapes, invalid receipt coordinates, and changed choice logs fail.
- Promise jobs drain for 64 checkpoints between queue choices. Unscheduled
  async filesystem work fails. Synchronous filesystem effects are atomic inside
  the current operation. Instruction-level process interleaving is unclaimed.
- Guards reject real timers, subprocesses, path escape, symlink escape, and
  unowned descriptors. A swallowed violation still fails the next world drain.
  Module loading and fixture setup run outside this guard. A9 host-crash
  durability is unclaimed. Do not retain copied builtin functions before guard
  installation; Node live builtin exports are synchronized at installation.
- Herdr behaviors cite A1, A2, A6, and A8. Process birth tokens cite A7. Pi
  shutdown, follow-ups, and branch behavior cite A3, A4, and A5. These assumptions
  remain advisory until the probe lane supplies passing evidence. Process-info
  envelopes and pane geometry still need probe comparison.
- Nonempty pre-existing Team setup needs a public-tool bootstrap trace. The
  runner fails rather than creating PTB authority by hand. Cross-Session forks,
  arbitrary shell input, healthy Beads wire behavior, and process restart with
  Session recovery remain explicit gaps. Unsupported inputs fail.
- Workers launched by a trace must have actor coordinates somewhere in that
  trace so the runner can preload their isolated module graph. No provider,
  real-Herdr, or P/M/E campaign gate is claimed here.

Architecture impact: none to production contracts. This is verification support.
