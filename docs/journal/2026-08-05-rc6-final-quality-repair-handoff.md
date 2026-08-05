# RC.6 final quality repair handoff

Date: 2026-08-05
Team: `rc6-final-quality-repair`
Tasks: `rc6-final-quality-repair-5kk`, `rc6-final-quality-repair-1mv`
Baseline HEAD: `27a532d1c9c9696afe3790c081028aae8af77d76`

## Result

The stopped-epoch delivery migration now preflights mixed Task, Worker, and
Alert journal records by event type. It leaves Worker evidence unchanged,
converts each raw Task or Alert revision with `taskVersionRef` from that exact
stored revision, preserves canonical revisions while removing legacy identity
fields, maps `design` to `goal`, retains surrounding evidence, confirms every
Task ID against the Team-scoped list, and writes only after full validation.
Event-only history does not read a current Task card.

Normal delivery, completion, reconciliation, and enqueue paths now accept and
validate the imported `TaskCard`. Coordinates remain limited to tombstone use.
The owner-transition precommit hook receives the raw authority envelope and
projects it through the canonical adapter, so prior-operation delivery carries
a real card. Production fallback card reconstruction is removed. Delivery
remains field-for-field equal to the mutation card and adds zero `bd` calls.

Static acceptance now rejects unknown delivery overloads, partial or fallback
card reconstruction, and current-card substitution for historic event
revisions.

## Focused verification

- `npm run typecheck` passed.
- The independent focused lane passed 12 files and 80 tests across migration,
  delivery, owner outbox, canonical cutover, call minimization, adapter,
  result, event, and Alert boundaries.
- The focused call-count lane passed 2 files and 12 tests. Delivery asserted
  `bdCallCount: 0`.
- A real temporary Beads mixed migration scanned 6 records, converted 5,
  failed 0, and resolved 0. Its second run converted 0. It used one
  Team-scoped list and one multi-ID hydration read.
- The final static delta passed 1 file and 11 tests.
- Independent verification changed no repository file. Its final verified
  source manifest SHA-256 was
  `3a17e5c709b08b54439d510f544d699d1316afa69843a744812824a17d6e9a85`.

Architecture impact: **none**. The repair changes no component responsibility,
dependency, data flow, persistence or trust boundary, deployment topology, or
canonical Structurizr view.

Blockers: **none**.

No aggregate test, reset, version, commit, tag, push, package, publication, or
release-preparation action ran.
