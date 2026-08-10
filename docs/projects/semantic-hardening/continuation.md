# Semantic hardening continuation

Updated: 2026-08-10 during automatic context compaction.

## Owner contract

Continue the full subsystem hardening project without stopping at a release increment. Lead directly and use assigned Tasks for all Worker work. Keep the Herdr watchdog active. Do not push, tag, publish, or run the reserved aggregate until the full target is stable and the owner authorizes publication.

Preserve public tools, schemas, results, package exports, persisted records, filenames, ordering, errors, timing, terminal behavior, and undocumented observable behavior by default. A behavior change needs explicit evidence, classification, replacement tests, and its own commit.

The full target remains Team authority, Task authority, Alert authority, Coordination observation, Trio-facing projections, and the additive read-only Membership observation component. Session, process, pane, delivery, locks, files, timers, and traces are support mechanisms, not authorities.

## Current source state

The Project worktree branch is `audit/semantic-hardening-behavior-inventory`. Current accepted source commit is `b4bf6dee91cf25532cbc33a397167567ba6d347e` (`refactor: isolate Coordination nudge boundary`). Do not use the original checkout.

Recent accepted commits:

- `34ac729` — Coordination outside-in characterization.
- `f4f88a2` — Coordination query ports and durable adapters.
- `3869ef6` — Coordination observation service extraction.
- `b4bf6dee91cf25532cbc33a397167567ba6d347e` — Coordination nudge boundary.

The reserved aggregate has not run. Public behavior and package exports remain unchanged. Nothing after the earlier authorized RC branch increment has been pushed or published.

## Active Team and nudge slice

Active Team: `semantic-hardening-nudge`. The exact calling Session is leader.

Closed work:

- `semantic-hardening-nudge-ezn` specified the accepted nudge split.
- `semantic-hardening-nudge-v85` moved debt calculation into Coordination, added a durable nudge-record adapter, and retained Pi-only Session actuation.
- `semantic-hardening-nudge-jsx` added independent debt, record, conductor, Pi race, compatibility, and import-fence tests.
- `semantic-hardening-nudge-azk` replaced a concrete observation-service dependency with a narrow structural Task-projection reader.
- `semantic-hardening-nudge-tah` created the shared neutral Task-projection revision function and removed concrete hidden/event/hint imports from Coordination nudge debt.

The two legacy-oracle corrections are accepted. Nudge debt no longer rejects a
missing optional policy version; it keeps the former interpolation in the debt
key when logical Workers exist. A nudge-specific exact-leader binding resolver
avoids an early `none` or no-active-Team result and requires only the bound lead
Session, Team epoch, sync-liveness policy, Members/current lead identity, and
Session file. Its durable hidden-observation read still applies
`teamModelToolContractGap`: absent logical Workers therefore returns the exact
legacy unavailable result. Snapshot and update observation still require logical
Workers.

Current audit evidence is 99 production TypeScript files and 334 unique resolved
static local edges, with zero nontrivial cycles and zero runtime dynamic imports.
Focused nudge and registered Coordination tests, typecheck, package verification,
and agent QA passed. This is deterministic one-process evidence, not proof of
real Pi persistence, external Beads/Dolt contention, cross-process forks, native
watcher delivery, OS scheduling, external writers, or terminal pixels.

## Immediate continuation

1. Address the separately reproduced baseline terminal-admission defect in its
   own commit. Do not classify it as a nudge regression.
2. Start the Trio façade and separate-fake split. It must use distinct Team,
   Task, Alert, and Coordination application ports and must not collapse Task or
   Alert commits with failed Coordination publication.
3. Then isolate the additive Membership decoder, do measured local optimization,
   stabilize one exact tree, run the one reserved aggregate, refresh final
   artifacts, run the privacy scan, and obtain watchdog completion review.

## Nudge boundary still in force

Coordination owns debt meaning, event pagination, Task revision and failed-hint provenance, exact debt identity, and eligibility. The durable record adapter owns nudge JSONL reservation/promotion storage. `SyncNudgeConductor` owns timers only. Pi alone revalidates the exact Team epoch, lead Membership, Session, and full branch; reserves; sends the unchanged custom message; proves the exact persisted custom message; and then promotes. A stale reservation remains historical evidence. Fresh eligible debt can reserve and present once.

Preserve current delay validation, read order, exact messages, debt keys, full-lineage identity, JSONL path/schema, malformed-line tolerance, append/fsync order, custom-message payload, `triggerTurn`, `deliverAs`, and public projections.

## Proof limits and later work

Current evidence is deterministic one-process harness evidence. It does not prove real Pi persistence, external Beads/Dolt contention, cross-process forks, native watcher delivery, OS scheduling, concurrent external writers, or terminal pixels.

The next major boundary after nudge is the Trio split: one Trio facade over separate Team, Task, Alert, and Coordination application ports, plus separate in-memory authority fakes. Do not let Trio own authority state or collapse Task/Alert commits with failed Coordination publication.
