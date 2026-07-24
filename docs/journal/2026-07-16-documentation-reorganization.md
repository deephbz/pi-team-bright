# Documentation reorganization

Date: 2026-07-16

Status: historical change record

## Trigger

The active documentation needed to match the current implementation, expose
its Team-scoped communication boundary, and stop presenting superseded
workflows as current instructions.

## Observed evidence

- The extension registers 18 public tools in
  [`extensions/index.ts`](../../extensions/index.ts).
- Direct Message and broadcast recipients are resolved from the current roster
  of the named Team in [`src/utils/messaging.ts`](../../src/utils/messaging.ts).
- The current Task model, statuses, authority projection, and version contract
  are defined in [`src/utils/models.ts`](../../src/utils/models.ts) and
  [`src/utils/tasks.ts`](../../src/utils/tasks.ts).
- Existing loose plans, research notes, compatibility snapshots, and manual
  test scripts described removed tools, retired Task states, or outdated
  release assumptions.

## Interpretation

The repository needed separate projections for maintained current context,
accepted choices, and historical change evidence. The communication boundary
was already enforced by the implementation but was not stated as a product
scope rule.

## Change

Created `docs/current/` for the maintained product, domain, system, and
operations context; added decisions for the record model and Team-scoped
communication; and made this journal the dated evidence of the reorganization.
Reduced the README to an overview and quick start, retained the reference as
the exhaustive tool contract, and replaced former guide/footer locations with
pointers to maintained pages. Removed superseded loose documentation from the
active tree; version control preserves the original source records.

## Process provenance

Three specialist Workers audited in parallel without editing files: an
implementation-to-docs auditor, an information-architecture reviewer, and a
stale-artifact curator. Their findings converged on the active-versus-historical
split, the 18-tool surface, and the required Team-scoped communication rule.
Normal teammate spawn hit a host proxy/network startup failure; the same
Membership generations were recovered through exact Pi Session resume via the
host `_codex_with_proxy` wrapper.

The docs-contract test in `src/utils/tool-surface.test.ts` was updated so its
public-docs set reads the new `docs/current/operations.md` and adds an assertion
for the Team-scoped communication boundary. Unrelated test expectation drift
in `binding-correctness.test.ts` and `launch-compensation.contract.test.ts`
was left untouched; see open questions.

## Verification

- `npm run typecheck`.
- `npx vitest run src/utils/tool-surface.test.ts` (17/17).
- Relative Markdown link resolution across README, docs, and skills.
- Scans for unrelated project names, personal identity, and retired contract
  names (`process_shutdown_approved`, `cleanup_agent_sessions`,
  `task_submit_plan`, `task_evaluate_plan`, `spawn_lead_window`,
  `task_completed`).
- `git diff --check` whitespace.

Sanitized release audit before push (modeled on the sibling project's private
to public SOP, applied here because pi-teams is itself a public repo):
- `gitleaks dir .` and `gitleaks git .` both reported no leaks.
- An exact detached clone of the commit ran `npm ci`, `npm run typecheck`,
  the targeted docs contract test, link validation, and the identity scan; all
  passed.

Committed and pushed to `origin/main` as `90900d9`
(`docs: reorganize project documentation`).

## Open questions

- Keep the current pages concise as future features land; add a new decision
  only for durable product or contract choices.
- Revisit the communication boundary only when a concrete broader workflow has
  a specified identity, authorization, and delivery contract.
- Two pre-existing, environment-sensitive test failures surfaced only when the
  full suite ran single-worker; both predate this change and are unrelated to
  documentation. `binding-correctness.test.ts` expects `/no terminal adapter/`
  but the implementation says `no terminal binding`; `launch-compensation`
  expects an empty `staleBindings` array but the live tmux `TMUX_PANE` makes the
  real lead pane appear as a stale binding. Neither was fixed here to keep the
  change docs-only; a separate runtime test hardening pass should reconcile
  them.

## Resulting records

- [Current context](../current/README.md)
- [Documentation record decision](../decisions/0001-documentation-records.md)
- [Team-scoped communication decision](../decisions/0002-team-scoped-communication.md)
