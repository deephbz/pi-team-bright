# Beads read-path investigation

Date: 2026-08-04
Status: complete for the snapshot N+1 fix and command selection

## Question and decision

The question was whether Pi Team Bright chose the wrong native Beads command, or whether Beads itself makes detailed multi-Task reads slow.

The answer is both. Pi Team Bright added its own N+1 command pattern after an already detailed multi-ID read. That defect is now removed. Native Beads `show`, and the inspected `beads_rust` equivalent, still loop over IDs and hydrate each issue separately. A supported set-oriented detailed batch command does not exist in either inspected CLI.

Keep native `bd list` for Team-scoped candidate selection and one multi-ID `bd show` for exact candidate hydration. Do not switch the production snapshot to `bd export` or `br sync --flush-only`. Those paths are fast set-oriented exports, but they do not preserve the current detail shape and opaque-version inputs.

For the retained native call, request only `--include-dependents`. JSON `show` always returns `comment_count`, the adapter does not consume Beads comment bodies, and `--long` changes text output only. The implementation therefore removes `--include-comments` and `--long`.

Architecture impact: **none**. Task authority, public semantics, component responsibility, and topology do not change.

## Pi Team Bright finding and result

Before this change, snapshot read did one Team-scoped `list`, one multi-ID detailed `show`, then one additional single-ID detailed `show` for every Task. The second read recovered candidate metadata that the first projection had discarded.

The new candidate-authority batch seam keeps each Task and its candidate metadata from the same multi-ID hydration. Snapshot now performs exactly one Team-scoped list and one multi-ID show, with no per-Task shows. The deterministic runner test asserts the command counts, all IDs in the one show, zero single-ID shows, and the exact retained flag. Focused independent verification passed 23 tests. The implementer also ran the final 401-test fast lane successfully.

The maintained rule is: an external CLI boundary must not add one call per candidate when one exact batch preserves the same semantics. The executable sources are [`src/utils/beads.ts`](../../src/utils/beads.ts), [`src/utils/tasks.ts`](../../src/utils/tasks.ts), and [`src/model-tool-contract/durable-model-tool-port.ts`](../../src/model-tool-contract/durable-model-tool-port.ts).

## Native Beads facts

The inspected runtime is native Beads v1.1.0 at commit [`8e4e59d`](https://github.com/gastownhall/beads/tree/8e4e59d39f3459a43cf21a3236a13eca4dd874f7).

Multi-ID `show` is not a database batch. The command loops over positional IDs, resolves and gets one issue, then reads labels, dependencies, three counts, optional dependents, and optional comments for that issue ([`cmd/bd/show.go:114-223`](https://github.com/gastownhall/beads/blob/8e4e59d39f3459a43cf21a3236a13eca4dd874f7/cmd/bd/show.go#L114-L223)). Current upstream main still loops over IDs at revision [`67f812a`](https://github.com/gastownhall/beads/blob/67f812a23d34593d1a2b8a6e45d417a42d1690eb/cmd/bd/show.go#L116-L167), although detail construction now goes through a shared reader.

`list` is set-oriented and calls `SearchIssuesWithCounts` once, but it does not return detailed dependency and dependent records ([`cmd/bd/list.go:522-552`](https://github.com/gastownhall/beads/blob/8e4e59d39f3459a43cf21a3236a13eca4dd874f7/cmd/bd/list.go#L522-L552)). `query` uses the same list-style projection. `batch` is write-only. `sql` bypasses the supported storage contract.

`export` is genuinely bulk-oriented. It searches issues once, then bulk-loads labels, dependency records, comments, and counts for the complete ID set ([`cmd/bd/export.go:102-205`](https://github.com/gastownhall/beads/blob/8e4e59d39f3459a43cf21a3236a13eca4dd874f7/cmd/bd/export.go#L102-L205)). Its dependency loader uses batched `IN` queries rather than an ID loop ([`internal/storage/issueops/dependency_queries.go:54-132`](https://github.com/gastownhall/beads/blob/8e4e59d39f3459a43cf21a3236a13eca4dd874f7/internal/storage/issueops/dependency_queries.go#L54-L132)).

Export is not equivalent to show:

- it exports the whole regular-issue workspace and has no Team-label or exact-ID filter;
- its dependencies are edge records, while show embeds target issue details;
- it has no dependent-detail array, so reverse related edges need reconstruction;
- its bulk dependency counts count blocking edges, while show counts all dependency rows;
- its raw relation shape would change current opaque Task-version hashes; and
- its issue and relation bulk reads are separate storage calls, so export is not one atomic snapshot.

These differences are observable authority semantics, not only serialization details.

## Native measurement

The machine-readable samples are in [`2026-08-04-beads-read-path-benchmark.json`](artifacts/2026-08-04-beads-read-path-benchmark.json). All commands were read-only against stopped authorities.

For 18 Tasks, labeled list took 325-341 ms. Multi-ID detailed show took 5.26-5.71 seconds, and 18 additional single-ID shows took 8.25-8.48 seconds. The resulting 13.87-14.23 second command-chain estimate matched observed snapshots of 13.93 and 14.15 seconds.

Removing comment hydration reduced one relational 18-Task sample from 5.87 seconds to 5.34 seconds. Removing `--long` did not change JSON. Native export took 383-405 ms for 18 Tasks. It took 434-1,035 ms across recorded 160-Task samples and included all 159 dependency edges. This is strong performance evidence for set-oriented hydration, but not semantic-equivalence evidence.

## `beads_rust` facts

The independent researcher inspected [`Dicklesworthstone/beads_rust`](https://github.com/Dicklesworthstone/beads_rust) main at [`9ca6633f`](https://github.com/Dicklesworthstone/beads_rust/tree/9ca6633f866039282e8e2b899fde95fc19d87824), described as `v0.2.19-35-g9ca6633f`. Cargo declares version 0.2.19.

`br list` builds one SQL query and materializes matching issues, but remains a list projection (`src/cli/mod.rs:1741-1854`, `src/storage/sqlite.rs:7603-7685`). Multi-ID `br show` loops over IDs and calls `get_issue_details` for each (`src/cli/commands/show.rs:462-496`). Each detail call reads the core issue and its relations, labels, dependencies, dependents, comments, optional events, and optional rollup (`src/storage/sqlite.rs:14646-14705`). It is not a true batch.

There is no standalone export command. `br sync --flush-only` selects export IDs once, then hydrates core issues and relation maps in set-oriented batches of 1,024 IDs (`src/sync/mod.rs:9155-9222`, `src/sync/mod.rs:9826-9885`). `get_issues_by_ids` uses `WHERE id IN (...)` and chunks below SQLite's variable limit (`src/storage/sqlite.rs:7464-7497`). Like native export, this path omits show dependents, events, parent, and rollup semantics, so it is not a drop-in replacement.

The Rust backend is fsqlite 0.1.18 with WAL, a configurable busy timeout, and serialized mutation locking. Its concurrency suite includes five concurrent workers running list, show, and stats (`tests/e2e_concurrency.rs:957-1021`). Its contention replay has a four-worker CI profile and an opt-in 64-worker profile (`tests/bench_contention_replay.rs:796-910`). Criterion files state targets for list and export, but those targets are not measured results (`benches/storage_perf.rs:1-14`).

A safe local Rust timing attempt did not produce latency evidence. The disposable fsqlite database stayed busy after initialization, so the read commands did not run. The result was recorded as a failed experiment, not a benchmark.

## End-to-end benchmark plan

This plan was recorded before the post-fix run. Create one disposable Team with
six Workers and 18 terminal Tasks. Use the current working-tree extension on the
same Darwin arm64 host as the earlier rc.4 observation. Enable the payload-free
Pi Team trace, then request three consecutive full `team_sync` snapshots from
the exact leader Session.

The predicted full-snapshot wall time is 5.2-5.7 seconds, down from the two
observed rc.4 samples of 13.93 and 14.15 seconds. Each successful snapshot must
return all 18 Tasks and emit exactly one Team-scoped list plus one multi-ID show,
with no single-ID candidate reads. Treat the first run as cold and the next two
as warm. Preserve the native Session timestamps and trace records as evidence.

## End-to-end result

The cold snapshot completed in 5.317 seconds. The two warm snapshots completed
in 4.867 and 5.197 seconds. All three returned exactly six Workers and 18 Tasks.
The median was 5.197 seconds, compared with a 14.040-second mean for the two rc.4
snapshots. This is an 8.843-second or 63.0% latency reduction, equal to a 2.70x
speedup. The warm mean was 5.032 seconds, a 64.2% reduction and 2.79x speedup.

The result met the prediction. One warm sample was slightly faster than the
predicted range. Every run emitted one successful `list` and one successful
multi-ID `show`. No single-ID candidate read or extra Beads call occurred. The
remaining `show` consumed 4.542-4.969 seconds, or about 93% of wall time. This
confirms that the remaining snapshot bottleneck belongs to native Beads detail
hydration.

The machine result is
[`2026-08-04-snapshot-e2e-result.json`](artifacts/2026-08-04-snapshot-e2e-result.json).
Its six payload-free source records are
[`2026-08-04-snapshot-e2e-trace.jsonl`](artifacts/2026-08-04-snapshot-e2e-trace.jsonl).
An independent benchmark Worker verified the arithmetic, command counts,
complete outputs, provenance, and unchanged source diff.

## Assessment and next test

The surprising result is that `export` is already much faster at 160 Tasks than detailed `show` is at 18. This changes the optimization target: after removing Pi Team Bright's command multiplication, the remaining dominant cost belongs to Beads' detailed-read implementation, not process startup alone.

The production choice remains conservative because a faster wrong authority record fails the Task contract. The next native-Beads improvement should be a supported filtered `GetMany` or detailed batch command. It should use one set query for core issues plus batched relation maps, and it must return the same detail shape and error rules as single-item show.

Evidence that would reverse the current command choice is a supported exact-ID or Team-filtered batch API that preserves scope checks, candidate metadata, dependency and dependent identities, parent and related direction, count semantics, opaque-version inputs, timeout behavior, malformed-record handling, and complete-or-no-observation behavior. Benchmark it at 1, 20, and 60 Tasks, idle and under concurrent writes, before adoption.
