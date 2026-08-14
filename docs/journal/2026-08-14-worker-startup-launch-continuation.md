# Worker startup launch continuation

Date: 2026-08-14

## Task state

Assigned Task `ptb-worker-startup-opt-uc7` is ready and assigned to `startup-path-engineer`. Its claim failed before source work: the Task authority returned `Legacy Task mutation is disabled on the graph-native Worker surface; apply a graph revision first.` The Worker surface has no graph-apply tool. An attention Alert with this evidence was sent to `team-lead`.

A second Alert recorded the external contract blocker: installed Herdr `0.7.5` has no non-waiting `agent start` mode. Its `--timeout` contract requires a value greater than 3000 ms, and successful CLI invocation waits for `interactive_ready`. The expected upstream accepted-start worktree was clean at its baseline revision when checked.

## Observed production contract

The current path is `WorkerLaunchBridge.ensureWorker` -> `spawnWorkerCarrier` -> `HerdrAdapter.spawn` -> `herdr pane split` -> `herdr agent start`; it then calls `observeLaunchedWorker`. The observation waits for an exact Worker `session_bound` event and rechecks the same Membership ID plus runtime generation tuple `(membershipId, pid, startedAt)` through durable authority. It is not a readiness or progress protocol.

`HerdrAdapter` already uses structured Pi argv, validates the pane-split result, retries only `agent_pane_busy` while a fresh shell becomes usable, and closes the new pane when agent start fails. It never uses `pane run` as a Worker launcher. `WorkerLaunchBridge` persists only the returned exact terminal target. It compensates a failed target only after confirmed stop, retains a Membership if stop is unconfirmed, and leaves Session binding and runtime-generation admission to the child.

The child lifecycle order is runtime claim, exact Session binding, `session_bound` event, then delivery startup. Existing tests protect this ordering and exact-process admission.

## Measurement evidence

The startup exploration artifacts report a Herdr owned-pane `agent start` p50 of 3047.4 ms, while pane split p50 is 9.47 ms. Recent durable `prepared -> session_bound` samples report p50 828 ms and p95 892 ms. Herdr source contains an intentional 3000 ms managed-agent settle delay before `interactive_ready`; therefore the present CLI wait adds about 2.2 seconds after the usual authoritative binding point.

The selected optimization remains: remove only the redundant human-interactive wait, preserve a positive Herdr command acceptance, and keep exact Pi Team Bright Session binding as the usable-Worker authority. Architecture impact is expected to be none.

## Required implementation after the upstream contract lands

1. Obtain the exact public Herdr accepted-start CLI/API contract and version. Do not guess the flag or bypass it with direct socket use or `pane run`.
2. Update `src/adapters/herdr-adapter.ts` to request that contract and validate a positive accepted result for the exact spawned pane and recognized carrier. Keep the bounded `agent_pane_busy` retry and pane-close compensation for failed acceptance.
3. Keep `WorkerLaunchBridge` awaiting `observeLaunchedWorker`; do not treat Herdr acceptance, pane presence, process birth, or interactive readiness as Session binding.
4. Add payload-free stage timing to the existing `PI_TEAMS_TRACE_JSONL` authority. Use monotonic elapsed values and stable Team/Membership correlation. Record at least prepared, accepted start, exact Session binding observed, and failure/compensation outcome. Do not add a second uncorrelated trace destination.
5. Add focused deterministic tests in `src/adapters/herdr-adapter.test.ts` for accepted-start arguments, exact positive-response validation, split-to-shell race, failed acceptance cleanup, and no `pane run`; retain/extend exact authority and compensation coverage in `src/utils/worker-startup-observation.test.ts`, `src/utils/launch-compensation.contract.test.ts`, and `src/utils/worker-identity-process-admission.characterization.test.ts`.
6. Run owned-pane before/after measurements with the same command shape and record raw samples, p50, p95, min, max, count, binary version, and cleanup result. The existing benchmark uses controlled split/start/close cycles and needs the accepted-start mode added before after data is valid.

No production source was changed before this handoff. This file is the only new worktree artifact.
