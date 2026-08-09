# Pi Team Bright semantic hardening

Updated: 2026-08-09
Stage: consolidation and hardening
Status: exact `0.17.0-rc.11` source `638d5934` passed its reserved aggregate and
local release gates; it remains untagged and unpublished
Architecture impact: changed for internal Task and Team dependency ownership;
HyperCarrier's canonical diagram remains unchanged because it keeps Pi Team
Bright internals opaque

## Outcome and current result

The Project makes current functional and non-functional behavior executable,
then moves source dependencies toward five semantic subsystems without changing
the public surface by default. The durable concise outcome is
[`result.md`](result.md). The accepted decomposition and current evidence live in
the [`subsystem audit`](subsystem-boundary-audit.md) and machine
[`dependency map`](subsystem-dependency-map.json).

The ten-commit series from public rc.10 integration base
`7453ce1b2a2ca49f8729a6bf399f7c1f25bfca6a` ends at
`15e707b5668af383d6949934bd8e67a35b8bc097`. It adds outside-in
characterization, two Task dependency seams, Team-owned lead discovery,
duplicate-validation removal, deterministic lock tests, a reproducible Task-
hydration benchmark, and rc.10 audit evidence. Public tools, schemas, package
exports, persisted records, filenames, retry, timing, and default behavior are
unchanged.

The superseded rc.8 publication patch stash was removed after the reviewed rc.10
implementation entered `15e707b`; no Project stash remains. Exact source commit
`638d5934bd52c7f4a3fe18525e5d72569a227211` adds the result bundle and rc.11
release metadata. Its one reserved Node 22.22.1 aggregate passed 88 files and 695
tests in 253.59 seconds. Lane, package, QA, public, persistence, JSON, link,
privacy-range, exact-tarball, observation, Beads, and Pi-load gates passed.

The source remains untagged and unpublished. No push, npm publication, npm
`next` change, registry or provenance claim, GitHub release, or published-release
receipt exists. Full Team runtime, terminal rendering, and model interpretation
remain outside the source-verification claim.

## Sources of truth

- [`result.md`](result.md) — concise outcome, optimization decisions, evidence,
  limits, and release gate.
- [`subsystem-boundary-audit.md`](subsystem-boundary-audit.md) — maintained
  ownership facts, citations, boundary assessments, risks, and direction.
- [`subsystem-dependency-map.json`](subsystem-dependency-map.json) — machine-
  operable graph, evidence, resolved gates, and remaining gates.
- [`behavior-inventory.json`](behavior-inventory.json) — behavior IDs,
  classifications, anchors, and proof limits.
- [`journal.md`](journal.md) — append-only chronology and corrections.
- The rc.11 [source verification
  receipt](../../journal/2026-08-09-v0.17.0-rc.11-source-verification-receipt.md)
  — exact aggregate, privacy, one-pack, artifact, canary, and publication limits.
- The original
  [`handoff`](../../journal/2026-08-09-semantic-hardening-and-subsystem-audit-handoff.md)
  and [baseline receipt](../../journal/artifacts/2026-08-09-semantic-hardening-baseline.json)
  — ratified scope and rc.8 declaration evidence.
- Source and tests — exact stable contracts. Docs keep intent, current status,
  decisions, evidence routes, and limits.

## Subsystem target and implemented seams

The five accepted core subsystems remain:

1. Team authority and Role realization.
2. Task authority.
3. Alert authority.
4. Coordination observation.
5. Trio-facing interface and projections.

Public Membership observation remains additive and core-independent. Session
actuation, terminal adapters, locks, atomic writes, paths, tracing, diagnostics,
watch hints, and timers remain support mechanisms, not authorities.

Implemented Task seams are narrow. Task update and journal contracts plus
`TaskReconciliationQuery` are Task-owned, and Task delivery consumes the
injected query. Task mutation consumes the consumer-owned
`TaskMutationPublicationPort`; a stateless durable adapter outside Task authority
calls Coordination, failed-hint, and delivery writers. One publishing Beads
adapter factory reaches leader and Worker mutation paths, while default adapters
remain read-only.

Team authority now owns durable lead-Session discovery. Pi composition retains
environment precedence, hook timing, lifecycle orchestration, and adapter
construction. These changes remove concrete source dependencies; they do not
claim full Task, Team, or system isolation.

## Decisions and constraints still in force

- Preserve observable behavior by default. A behavior change needs a separate
  owner decision, historical evidence, normative replacement test, and commit.
- Keep Team, Task, Alert, Coordination, Trio, Membership observation, Session,
  process, pane, delivery, and runtime evidence distinct.
- Keep public tools, schemas, package exports, observation protocol, persisted
  records, filenames, compatibility readers, retry, timing, and defaults stable
  during structural refactoring.
- Assigned Tasks remain the sole durable delegation protocol. Alerts remain
  exceptional coordination and never mutate Task state.
- Consumer-owned cross-authority ports are implemented outside the consuming
  authority. Do not relocate concrete imports into a nominal authority adapter.
- Workers do not commit. The leader integrates stable Tasks and commits the
  exact selected tree.
- Run focused tests during iteration. Reserve one broad aggregate run for the
  exact stable release-candidate tree.
- Do not add a dependency, outbox, service, or general framework without one
  named behavior or measurement that requires it.
- Preserve raw observations and historical records. Derived liveness, failed-
  event hints, nudge debt, and presentation records never become Team, Task, or
  Alert authority.

## Current gates and risks

Closed gates:

- `TASK-RECONCILIATION-INJECTION` — injected Task-owned query with deterministic
  equivalence and import-direction evidence.
- `TASK-PUBLICATION-INVERSION` — consumer-owned port, external durable adapter,
  leader and Worker composition, exact order, warning, failure, no-op, replay,
  and import-fence evidence.

Open boundary risks:

- `ALERT-PUBLICATION-FAILURE` / ALERT-004 remains characterized and
  unclassified. Restart and later exact-Session presentation evidence remain
  open. Do not choose an outbox, warning, or replacement behavior first.
- Coordination implements rc.10 hydration, liveness, failed hints, bounded
  waits, indeterminate outcomes, and nudges, but still reads Team runtime, Task
  delivery, and Alert inbox records concretely.
- `ModelToolTeamPort`, its durable implementation, and its in-memory fake still
  combine multiple authorities. Broad Trio parity and privacy coverage remains
  incomplete.
- Team lifecycle and carrier policy remain partly in Pi composition. Public
  Membership observation still reads broad private record shapes.
- Beads hydration has a measured latency tail. Removing reverse-dependent
  hydration, filtering closed Tasks, or raising the timeout would change current
  meaning or policy. Actual optimization remains deferred.

These risks bound future work. They do not show a regression in `15e707b`, and
they do not authorize speculative completion before the next release candidate.

## Herdr recovery

Herdr is an exceptional terminal recovery surface, not Team or Task authority.
Require `HERDR_ENV=1`. Query with `herdr agent list`, then use `agent get` and
`agent read --source recent-unwrapped` for the exact agent. Never rely on UI
focus or stale pane IDs.

The direct leader is named `ptb-semantic-direct-leader`; the independent
watchdog is `ptb-leader-watchdog`. The watchdog checks every 600 seconds and
requires two full quiet intervals with no agent, terminal, Task, Git, context,
or journal progress before it treats a turn as stuck. `unknown` is uncertainty.

For a proven stuck turn, read the pane, send one Escape, wait, and resume the
exact coordinator Session only after process absence is proven. Start through
`_codex_with_proxy` with `openai-codex/gpt-5.6-terra:medium` in the same pane.
Use `agent prompt` for recognized agents and `pane run` only for shell commands.
Do not move, close, or focus unrelated panes, and never stop the Herdr server for
this Project. Normal coordination remains Task-first through `team_sync`.

## Next actions

1. Commit this verification receipt and maintained-context update without
   changing the verified source identity.
2. Keep tag, push, npm publication, npm `next`, provenance, and GitHub release as
   separate authorized operations with external verification signals.
3. If publication is authorized, verify the tag and registry artifact against
   source `638d5934` and the recorded one-pack facts before writing a published-
   release receipt.
4. Continue remaining boundary or performance work only as separately scoped
   Projects with explicit behavior and reversal evidence.
