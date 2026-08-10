# Pi Team Bright semantic hardening

Updated: 2026-08-09
Stage: consolidation and hardening
Status: owner reopened delivery because the verified rc.11 increment did not
complete the agreed five-subsystem refactor; full implementation is active
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

The partial source is pushed only to remote branch `rc/v0.17.0-rc.11`. It
remains untagged and is not published to npm. `origin/main` and npm `next` stay
on rc.10. No registry, provenance, GitHub release, or published-release receipt
exists. Full Team runtime, terminal rendering, and model interpretation remain
outside the source-verification claim.

## Active continuation

The owner rejected the prior partial-completion interpretation. Delivery now
requires the complete agreed request, not another bounded release increment:

- expand the behavior inventory and outside-in tests across functional and non-
  functional behavior for all five subsystems;
- complete the remaining Team authority and Role realization, Alert authority,
  Coordination observation, and Trio-facing boundaries;
- isolate the additive Membership observation projector behind a narrow Team/
  runtime reader while keeping it core-independent and its public contract
  unchanged;
- split mixed contracts and the combined durable/in-memory façade only through
  behavior-preserving, consumer-owned seams with static dependency gates;
- preserve public surfaces and observable behavior by default, and handle each
  justified behavior change through explicit evidence and its own commit;
- continue separate focused optimization commits only when a measured or
  reviewed problem justifies them;
- keep this context current and the journal append-only until every completion
  gate has external verification.

The isolated worktree and local audit branch were restored at documentation HEAD
`a3c51d7`. Remote branch `rc/v0.17.0-rc.11` contains that partial increment;
`origin/main` and npm `next` remain on rc.10. The current direct leader Session
has the required proxy environment and Herdr control. Dedicated watchdog
`ptb-full-split-watchdog` and direct-leader Team
`semantic-hardening-boundaries` are active. The first continuation Team shut down
only after all Tasks became terminal, which reset expensive Task-history
hydration without changing the direct leader. Worker-authored Task evidence now
covers the current source graph, all 27 behavior entries, Alert hook-level replay,
Team carrier replacement, and Trio projection parity. All 27 entries are
characterized with explicit proof limits; characterization does not make them
normative. The shared domain-contract split passed independent review and entered
commit `6b7fb14`. The watchdog checks both leader liveness and goal completion,
and must not accept a release increment as Project completion while any target
boundary or behavior gate remains open.

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

Commit `6b7fb14` gives Team, Task, Alert delivery, and Coordination events
canonical contract homes. Historical `utils/models.ts`, Task card, and Task
version paths remain exact compatibility re-exports. Production imports use the
canonical owners where this does not create a cross-authority implementation
edge. Persisted shapes and public package exports remain unchanged. Commit
`32e12b5` keeps historical generated observation filenames while adding required
canonical contract outputs; the packed CommonJS and TypeScript probes pass.

Commit `8d63473` moves Worker carrier realization into Team authority. A required
Team-owned publication port replaces concrete Coordination imports, and a
durable adapter outside Team owns event publication and bounded startup
observation. The old utility path is a compatibility re-export.

Commit `a2e3f9c` adds a Team-owned assigned-work guard and stop/shutdown
service. Concrete Task reads and stopped-event publication remain in external
adapters. The service owns topology and Membership leases, exact carrier-stop
proof, deactivation, partial shutdown, and result policy.

This Team selection adds `TeamSessionLifecycleService` for
lead and Worker startup admission, exact Membership leases, runtime-generation
claims, binding, lead-session records, session-bound/failed publication, and
exact bound-Session runtime updates. Pi hooks still own fork and identity
recovery, terminal admission inputs, UI/refusal, deliveries, titles, footer, and
callback order. Implementation Task `semantic-hardening-boundaries-3pt`, registered
order-characterization Task `semantic-hardening-boundaries-03r`, read-only
architecture review Task `semantic-hardening-boundaries-0xl`, and independent
test Task `semantic-hardening-boundaries-3w7` are closed. Correction Task
`semantic-hardening-boundaries-6g2` moved exact lead Session binding into the
Team service, and independent test Task `semantic-hardening-boundaries-76m`
closed the order gate. Exact-Membership correction Task
`semantic-hardening-boundaries-7kz`, race test Task
`semantic-hardening-boundaries-ggw`, and independent verification Task
`semantic-hardening-boundaries-5hg` are closed. Audit/map update Task
`semantic-hardening-boundaries-2vn` and final read-only record review Task
`semantic-hardening-boundaries-blb` are closed. The current source bundle
commits the independently accepted Team Session lifecycle selection.

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
- `BEHAVIOR-CHARACTERIZATION` — all 27 inventory entries have bounded executable
  anchors and explicit proof limits. Broad Trio checks cover 48 registered-tool
  cases; representative TUI outcomes have independent semantic assertions.

Open boundary risks:

- `ALERT-PUBLICATION-FAILURE` / ALERT-004 is compatibility-required for this
  behavior-identical refactor. One-process hook simulation proves later exact-
  Session presentation and replay after an error, not process, fork, Pi Session,
  or OS restart. Any semantic change needs a separate owner-visible decision.
- Coordination implements rc.10 hydration, liveness, failed hints, bounded
  waits, indeterminate outcomes, and nudges, but still reads Team runtime, Task
  delivery, and Alert inbox records concretely.
- `ModelToolTeamPort`, its durable implementation, and its in-memory fake still
  combine multiple authorities. The projection evidence is now bounded, but the
  façade and fake authority split remains incomplete.
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
watchdog is `ptb-full-split-watchdog`. The watchdog checks every 600 seconds and
requires two full quiet intervals with no agent, terminal, Task, Git, context,
or journal progress before it treats a turn as stuck. It also checks every
completion gate in this document and refuses early completion. `unknown` is
uncertainty.

For a proven stuck turn, read the pane, send one Escape, wait, and resume the
exact coordinator Session only after process absence is proven. Start through
`_codex_with_proxy` with `openai-codex/gpt-5.6-terra:medium` in the same pane.
Use `agent prompt` for recognized agents and `pane run` only for shell commands.
Do not move, close, or focus unrelated panes, and never stop the Herdr server for
this Project. Normal coordination remains Task-first through `team_sync`.

## Next actions

1. Keep the active watchdog and direct-leader Team running; use their recorded
   liveness and Worker-authored Task events as launch evidence.
2. Use the completed source graph, behavior inventory, and contract split as
   gates for each next implementation Task.
3. Extract the remaining small Pi hook adapter, then complete Alert,
   Coordination, Trio façade and fakes, and additive Membership observation
   unless source evidence requires a safer order.
4. Commit each coherent boundary separately. Keep later optimizations as one
   measured problem per commit.
5. Run focused checks during implementation. Run one final aggregate only after
   every target boundary and inventory completion gate is closed on the exact
   stable source.
6. Update the audit, dependency map, result report, current context, and append-
   only journal. Independent verification and watchdog review must both confirm
   that the original request is complete before shutdown or final reporting.
7. Keep tag, main-branch integration, npm publication, provenance, and GitHub
   release outside this continuation unless the owner authorizes them again.
