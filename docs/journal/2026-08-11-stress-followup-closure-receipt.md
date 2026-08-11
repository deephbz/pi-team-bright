# Stress follow-up closure receipt

Date: 2026-08-11
Source: `8c74a5c9e2b5c1c645fcfc89c107a438a4272fbc`
Scope: documentation of retained Session and outside-repository stress evidence.

## Source and aggregate

`ed72376` added exact create-replay metadata reconciliation, adaptive exact-ID
hydration with bounded canonical-`show` fallback, narrow Worker-stop queries,
`deliveryId` tombstones, and a wall-clock `BdRunner` deadline. Its first
aggregate failed in three correction lanes: durable cursor acknowledgement,
stale-PID Worker stop, and tool-result QA.

`8c74a5c` contains the aggregate-test stabilization. The retained Session shows
one final `npm run test:full` pass: 119 files and 875 tests in 241.77 seconds.
It was not rerun. Package/generated output, lane, agent-surface, tool-result,
privacy-range, JSON, and type gates passed. The follow-up Team stopped all
Workers and shut down with no unfinished Tasks.

A separate global checkout advanced to `8c74a5c` while preserving five existing
untracked files. Fresh `npm ci --workspaces=false`, typecheck, and
`verify:package` passed there. No source, test, global-checkout, publication,
tag, push, merge, or aggregate action occurred during this documentation Task.

## Comparative stress evidence

The four outside-repository records are under
`~/.local/state/pi-team-bright/stress/`:

- `stress-8c74a5c-20260811-b.json` — source receipt.
- `stress-8c74a5c-20260811-b.md` — source receipt view.
- `stress-8c74a5c-20260811-b-retrospective.json` — retrospective record.
- `stress-8c74a5c-20260811-b-retrospective.md` — retrospective view.

They record an eight-Worker run against `8c74a5c`: 104 of 104 Tasks closed,
eight Workers stopped, zero duplicate IDs, and clean shutdown.

Against `stress-dfe15527-20260811-a`, the comparison records 14 versus 23
unknown create outcomes, two versus eight unavailable `team_sync` outcomes, and
zero versus eight Worker-stop timeouts. It records zero task-read unavailable
outcomes. All 14 unknown creates were retried with the same operation ID and
produced one Task each.

The visible cursor head was 325 with no observed duplicate or missing cursor,
but the model surface exposes only a final head, not a complete cursor stream.
Seven late assigned Tasks remained after `caught_up`. Two later showed Worker
completion through version conflicts; the leader reconciliation batch closed the
other five. This is backlog and reconciliation evidence, not a claim that
`caught_up` proves assigned-work delivery.

The records contain no per-call duration, maximum `team_sync` duration, UI
responsiveness measure, or terminal-pixel evidence. Typed timeout and unavailable
outcomes are consistent with a bounded wait, but do not prove TUI-freeze
prevention. The workload and recovery shape differ from the baseline, so this is
not a latency or causal repair-benefit comparison.

## Pending owner decisions

The retrospective identifies four public-schema decisions. They are not
implemented: expose assigned-work backlog state when `caught_up` coexists with
assigned nonterminal Tasks; identify create replay explicitly with its original
operation identity; add bounded duration and correlation fields; and add failed
hydration-batch detail with retry guidance while preserving the no-watermark-
advance invariant.

## Provenance and limits

The source aggregate evidence is retained in the coordinator Session. The stress
records are local state, outside the repository. This receipt preserves their
comparison and proof limits, but does not replace executable source evidence or
prove real Pi execution, production Beads/Dolt contention, external writers,
watchers, OS scheduling, capacity, publication, registry state, or provenance.
