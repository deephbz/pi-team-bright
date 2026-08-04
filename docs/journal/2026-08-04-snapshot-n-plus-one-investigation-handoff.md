# Snapshot N+1 investigation handoff

Date: 2026-08-04
Status: completed and superseded by the [read-path result](2026-08-04-beads-read-path-investigation.md)

This file preserves the pre-implementation handoff state. The implementation,
independent verification, native Beads decision, and `beads_rust` findings now
live in the linked result artifact.

## Owner decisions and request

The owner approved removing the Pi Team Bright snapshot N+1 Beads CLI pattern.
The implementation must batch authority reads and document the rule that external
CLI boundaries must not use N+1 calls when one exact batch can preserve the same
semantics. The owner also requested a native Beads CLI command review while a
separate teammate inspects the `beads_rust` project for CLI parity, batching,
latency, and high-concurrency evidence.

## Confirmed Pi Team Bright root cause

`DurableModelToolTeamPort.readModelToolTasks` calls
`listTasksWithVersions`, then loops over every listed Task and calls
`CandidateBeadsTaskAdapter.read`. `listTasksWithVersions` already performs one
`bd list` and one multi-ID `bd show`, but maps the raw records to `TaskFile` and
discards candidate metadata. The adapter then rereads every Task separately to
recover that metadata.

For N Tasks, one snapshot currently performs:

1. one `bd list`;
2. one multi-ID long `bd show`;
3. N single-ID long `bd show` commands.

The owning source locations are:

- `src/model-tool-contract/durable-model-tool-port.ts`, method
  `readModelToolTasks`;
- `src/utils/tasks.ts`, function `listTasksWithVersions`;
- `src/utils/beads.ts`, methods `showManyRaw`, `readMany`, and
  `readCandidateTaskAuthorityRecord`;
- `src/model-tool-contract/beads-task-adapter.ts`, method `read`.

The approved smallest design is a batched candidate-authority read that preserves
Task state and candidate metadata from the same raw multi-ID hydration. Snapshot
projection must consume those records directly and must not call one adapter
read per Task. Preserve public results, exact scope checks, opaque versions,
candidate-metadata gap behavior, timeout behavior, and hidden-baseline semantics.
Add a deterministic command-count test and maintained current/performance
guidance against N+1 external CLI calls.

## Direct native Beads measurements

Read-only measurements used the stopped 18-Task rc.4 stress Team. Three idle
runs measured:

- `bd --version`: 80-85 ms;
- labeled `bd list`: 325-341 ms;
- minimal multi-ID `bd show` for 18 Tasks: 4.1-4.3 s;
- long multi-ID show with comments and dependents: 5.26-5.71 s;
- 18 sequential long single-ID shows: 8.25-8.48 s;
- the current snapshot Beads command chain: 13.87-14.23 s.

Those totals match the observed final snapshot times of 13.93 and 14.15 s.
Multi-ID long show scaled almost linearly: about 0.44 s for one Task, 1.01 s
for three, 1.88 s for six, 2.75 s for nine, and 5.35-5.71 s for 18.

Native Beads v1.1.0 source was cloned read-only at `/tmp/beads-v1.1.0`, tag
`v1.1.0`, commit `8e4e59d`. `cmd/bd/show.go` loops over every supplied ID.
For each ID it resolves and reads the issue, then separately gets labels,
dependencies, three counts, and optionally iterates dependents and comments.
Thus its multi-ID surface is a serial CLI loop, not a set-oriented database
batch. Pi Team Bright then repeats that fanout through its N single-ID shows.

## Native Beads command review so far

Installed v1.1.0 help was reviewed for `show`, `list`, `query`, `export`, `sql`,
and `batch`.

- `show` is the detailed read surface, but multi-ID show loops per ID and its
  comment/dependent flags explicitly warn they may be slow.
- `list` is a set-filter surface. JSON records include metadata and labels but
  not dependency or comment arrays. It cannot by itself preserve the current
  detailed Task/version contract.
- `query` provides compound filtering but projects the list-style surface. It
  is not a detailed batch hydration command.
- `batch` is explicitly write-only. It does not accept show, list, ready, or
  other reads.
- `sql` can use set-oriented queries but bypasses the Beads storage layer. It is
  a debugging/workaround surface, not a safe default product boundary.
- `export` is a promising supported bulk read. Its help states that every JSONL
  issue includes labels, dependencies, and comments. It is intended for export,
  migration, and interoperability rather than backup.

Measured `bd export` results:

- 18 Tasks: 383-405 ms and about 33 KB;
- the stopped 160-Task stress authority: 811 ms cold and 434 ms warm, about
  198 KB;
- the 160 records included all 159 dependency edges, labels, and candidate
  metadata.

Next native-Beads work must inspect `cmd/bd/export.go` and its storage calls,
then compare export records against current `showManyRaw` semantics: working-set
freshness, scope filtering, metadata, full comments, relation direction,
dependent derivation, counts, version inputs, deleted/infra records, malformed
records, and external writers. Do not select `export` for the implementation
until that semantic comparison is complete. If export is equivalent after Team
scope filtering and in-memory reverse-relation derivation, it can potentially
replace both list and show with one supported command. Otherwise implement the
approved batched candidate-record seam over the existing multi-ID show first.

## Delegation state and blocker

The exact current leader Session cannot create a Team: `team_sync(snapshot)`
returns `no_active_team`, while `team_create` returns `active_team_exists`.
This is the known implementation-version/binding mismatch in the long-lived
Session.

A new Herdr tab `snapshot-batch-fix` was created as `w4:t56`, pane `w4:pT4`.
It launched Pi through `_codex_with_proxy` with a requested Terra/medium model.
The TUI initially displayed Terra, but the agent process reported
`openai-codex/gpt-5.6-sol` at medium. Per the prompt, it stopped before
`team_create`; no implementation Team, Worker, Task, or file change was made.
A follow-up request to add `beads-rust-researcher` therefore has no active Team
to use and must not be treated as dispatched.

Continuation must start or reconfigure a confirmed
`openai-codex/gpt-5.6-terra:medium` coordinator through the proxy, verify its
inherited proxy environment without printing values, then create one Team.
Delegate these Tasks:

1. `snapshot-batch-implementer`: implement the selected smallest batch read,
   deterministic N+1 command-count test, focused semantic tests, and current /
   performance documentation. Do not commit, version, push, or publish.
2. `snapshot-batch-verifier`: blocked by the implementation Task; independently
   inspect the final diff and run the smallest command-count and candidate
   metadata checks. It must not implement.
3. `beads-rust-researcher`: read-only inspection of the authoritative public
   `beads_rust` repository. Record exact revision/version; inspect list/show/
   export/query equivalents, backend and set-oriented behavior; find benchmarks
   and concurrency tests; run a safe local benchmark only if practical; report
   source citations and separate fact from inference.

Use Team snapshot after setup, updates for supervision, exact Worker stop
evidence, and Team shutdown. Leave Herdr tabs open unless the owner asks to
close them.

## Release continuation still pending

The earlier rc.4 publication workflow
`30863985909` succeeded for exact source commit
`800c143eac246dfae0534d53ad82e1eaad021669`. The annotated tag is
`v0.17.0-rc.4`. Registry-byte, dist-tag, provenance, GitHub Release, and durable
release-receipt verification were not completed in this Session and remain
pending. Do not republish the same version.

Architecture impact: **none** for the approved removal of duplicate CLI reads
if the same authority and public semantics remain. Selecting export or changing
version inputs requires an explicit semantic review before retaining that
classification.
