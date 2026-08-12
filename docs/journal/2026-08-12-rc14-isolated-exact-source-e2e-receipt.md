# rc.14 isolated exact-source E2E receipt

Date: 2026-08-12
Stage: hardening
Result: product acceptance passed; cleanup completed

## Source and isolation

The run used Team `rc14-isolated-e2e` from source HEAD
`53367e412ad0217bfcf4845d92a07bb9ebec6de2`. The pre-run SHA-256 digest of the
binary working-tree diff was
`e420bd61c008de5265e86422270619b06dac48cb0950561534f0b93370d94180`.

The leader used the isolated Pi directory `/tmp/ptb-rc14-isolated-pi`. Its
`settings.json` had `packages: []`, so it had no ambient extension package.
The run loaded the worktree extension from
`extensions/index.ts` through the explicit launch `-e` coordinate. The native
session was named `rc14-isolated-exact-source-leader` and had Session ID
`019ff56b-e98e-7279-b8b9-34be366c23fb`.

The leader preflight recorded `PI_PROVIDER=openai-codex`,
`PI_MODEL=gpt-5.6-sol`, and `PI_REASONING_LEVEL=high`. The session header also
recorded `openai-codex/gpt-5.6-sol` and high reasoning. The names
`HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` were present. No proxy value was
recorded. `PI_MODEL_TOOL_WORKER_MODEL` selected
`openai-codex/gpt-5.6-terra`; isolated settings also selected that Worker
model.

## Worker-authored evidence

Eight Workers connected as `e2e-1` through `e2e-8`. Each Worker wrote a
preflight journal entry with `openai-codex`, `gpt-5.6-terra`, medium reasoning,
and PRESENT for all three required proxy names. Each then verified exact stdout
`42` from `node -e 'console.log(6*7)'` and closed its Task.

The Task and journal coordinates were:

- `e2e-1`: Task `rc14-isolated-e2e-0h0`, preflight event 32, result event 38.
- `e2e-2`: Task `rc14-isolated-e2e-rst`, preflight event 30, result event 40.
- `e2e-3`: Task `rc14-isolated-e2e-4jd`, preflight event 29, result event 34.
- `e2e-4`: Task `rc14-isolated-e2e-fka`, preflight event 39, result event 42.
- `e2e-5`: Task `rc14-isolated-e2e-8sm`, preflight event 55, result event 56.
- `e2e-6`: Task `rc14-isolated-e2e-8dj`, preflight event 37, result event 43.
- `e2e-7`: Task `rc14-isolated-e2e-2y2`, preflight event 36, result event 45.
- `e2e-8`: Task `rc14-isolated-e2e-rxm`, preflight event 44, result event 46.

The eighth create first returned `unknown_outcome` after a timed-out Beads list.
The stated next action was `retry_same_operation`. An identical retry with
operation ID `rc14-e2e-probe-create-8` created
`rc14-isolated-e2e-rxm`. No duplicate Task appeared.

## Safe recovery

After the first `e2e-1` Task closed, `worker_stop` returned
`{"kind":"worker_stopped","worker":"e2e-1"}`. One later
`ensure_worker` call reused logical Worker `e2e-1` and returned `effect:
"created"` with a connected carrier.

The replacement claimed Task `rc14-isolated-e2e-v7l`. It wrote Terra-medium
proxy preflight event 52. It verified exact stdout `81` from
`node -e 'console.log(9*9)'`, wrote result event 53, and closed the Task. This
proves recovery through a second Worker-authored Task result, not only carrier
liveness.

## Synchronization and diagnostics

The run made 27 non-overlapping `team_sync` calls: the required initial
snapshot, 24 update calls, a final active snapshot, and a post-stop update.
The machine receipt is
[`2026-08-12-rc14-isolated-sync-durations.jsonl`](artifacts/2026-08-12-rc14-isolated-sync-durations.jsonl).
Its SHA-256 digest is
`0cd205363e6ac2d2ab809a5df62bf99d6cf16e7508a61b63a08cd61937ca99e1`.

The external watchdog matched 27 starts to 27 ends. Product call boundaries
ranged from 16 ms to 5,308 ms, with zero calls over 15,000 ms and no overlap.
The manual bash markers ranged higher because they also enclosed Sol reasoning
and two separate bash turns. Manual calls 12 and 20 measured 16,587.604 ms and
18,739.175 ms, so the manual-marker gate failed. This does not fail the product
boundary gate. The artifact preserves the manual markers, watchdog boundaries,
coarser native-session message spans, and semantic outcomes separately.

The maximum observed live descendant `bd ... list` count was one. Thus, the
watchdog found no overlapping list children. Seventy-four one-second samples
each contained three `FSEvent` string occurrences. Incident samples had
thousands, so this run had no observed FSEvents storm. The diagnostic summary
is
[`2026-08-12-rc14-isolated-diagnostic-summary.json`](artifacts/2026-08-12-rc14-isolated-diagnostic-summary.json).

Collector hashes are:

- watchdog JSONL: `75871f02321bb6e189132d75e83dbcbc54945b254ab16f85888ffadb71383786`;
- unavailable `fs_usage` diagnostic file: `d282965c010697444e5517a53fa7d73cd47c2a25c3a56cb40855b1ba4dba2f07`;
- 74-sample relative-name/hash manifest: `4a7c71c888758c01418d7430eda9807378b7200ba1fb4658afee38e09a695153`.

`fs_usage` required root and did not collect filesystem activity. Its file hash
proves only the retained unavailable diagnostic. It is not acceptance evidence.

## Exact stops and shutdown

The final active snapshot showed eight connected current Workers, nine closed
Tasks, and no nonterminal Task IDs. The leader then received exact
`worker_stopped` results for current Workers `e2e-1` through `e2e-8`. The
post-stop update reported one stopped event for each exact Worker and no Task
change.

`team_shutdown` returned lifecycle `stopped`, `stopped_workers: []`, and
`unfinished_task_ids: []`. The empty stopped list is expected because all
current Workers had already stopped exactly. All Tasks were terminal before
shutdown.

The run did not execute the reserved aggregate. It did not commit, tag, push,
or publish.

## Proof limits

Worker journals and Task states prove model-authored preflight and result
mutations. They do not prove all Worker process internals. The watchdog and
macOS samples prove only their observed intervals and polling resolution.
Terminal output and diagnostic traces are evidence, not correctness proof.

The Pi session header did not retain the complete parent-shell command line or
an extension-source inventory. Isolation is anchored by the isolated Pi
settings, the observed environment, the explicit launch coordinate supplied to
this run, and the working product surface. It is not an independent argv-level
attestation of `-e`. Raw session and collector files remain under `/tmp`; the
repository keeps their hashes, summaries, and the complete timing projection.
