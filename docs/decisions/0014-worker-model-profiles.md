# 0014 — Select a model profile when creating a Worker

Date: 2026-09-15
Status: accepted; implemented and independently verified in the unreleased working tree

Pi Team Bright needs persistent frontier reviewers and cost-efficient specialist
Workers. The leader selects one model profile when it creates a Worker with
`ensure_worker`. Tasks select an assignee and inherit that Worker's execution
choice. This keeps model selection out of repeated graph revisions and preserves
reusable Worker context.

## Model selection

- A configured alias names an exact provider, model ID, and thinking level.
  A one-line usage description helps the leader choose an alias. Model profiles
  do not own Worker scope, prompts, tools, permissions, or credentials.
- `ensure_worker` adds an optional `model` string for the alias. Omission for
  a new Worker preserves existing default-model behavior; this decision adds
  no new default or fallback order. Reuse preserves the existing assignment.
  A conflicting explicit selection refuses without reconfiguring the Worker.
- The assignment belongs to the durable Worker. Membership and process
  replacement must not resolve its alias again against changed settings.
- Neither the leader nor the Worker switches models between Tasks or during
  work. A separate persistent reviewer supplies the frontier perspective.
- Human operators can change a model in the spawned Pi pane. Such a change is
  allowed. It must not trigger automatic restoration or refusal of ongoing
  work. The configured assignment and observed runtime selection remain
  separate facts.

A model profile does not establish independent judgment. Worker scope, separate
context, and the review Task define the requested perspective. Reviewers retain
ordinary Worker authority.

## Model-facing discovery and errors

Use a stable string schema and validate aliases against the configured catalog.
Return aliases and one-line usage descriptions in `team_create` and
`team_sync` snapshot responses. Do not add a discovery tool or repeat the
catalog in routine updates. Worker summaries show the assigned alias; detailed
evidence can show the resolved tuple.

An invalid alias fails before Worker creation or reconfiguration. Its
model-facing error includes valid alias choices as a recovery hint. An explicit
selection must not fall back to another model.

## Human-facing guidance

Both successful and failed `ensure_worker` TUI messages tell the operator that
aliases can be added in Pi Team Bright settings. Their Ctrl+O expansion shows
a settings example. This guidance belongs to the human projection; it must not
inflate the normal model-facing response.

## Replace per-Task model selection

Remove the existing Task `default`/`capable` selectors and the independent
per-Attempt alias resolver. Do not retain Task model overrides, model-match
assertions, a compatibility executor, or a migration path for that mechanism.
The owner explicitly accepted this breaking replacement.

The superseded claim code recorded an alias lookup without selecting the carrier
model. That lookup could not prove actual execution. Evidence must distinguish
the configured Worker profile from observed Pi execution. Do not manufacture
runtime evidence from configuration or model self-report.

This decision does not authorize deleting existing Team stores or Session logs,
changing live Teams, or publishing a release.

## Same-Session recovery

Recovery preserves the model and thinking level recorded in the Pi Session,
including a human override. It must not overwrite that selection with the
leader's initial profile. The initial assignment remains configuration evidence;
Pi Session history owns the continued selection. A fresh Worker starts with its
resolved creation profile.

## Verification and reversal

Verify compact catalog discovery, explicit alias selection, invalid-alias
choices without partial Worker creation, idempotent reuse, conflicting-selection
refusal, actual launch model/thinking, successful and failed TUI guidance, and
expanded settings examples. Run a real multi-model Task DAG, reuse its Workers,
and test recovery under the selected policy. Confirm that Task model fields and
the old resolver are absent.

Revisit fixed Worker selection only when real work requires cheap and frontier
execution in the same retained Worker context. Revisit discovery placement if
measured workflow cost shows that catalog restoration needs another surface.

[Verification evidence](../projects/worker-model-profiles-verification.md) records
focused, full-lane, package, and real multi-model recovery results.

Implementation entry points: `src/model-tool-contract/catalog.ts`,
`src/model-tool-contract/result-projection.ts`,
`src/model-tool-contract/tui-projection.ts`,
`src/utils/worker-resource-projection.ts`,
`src/team-authority/worker-launch-bridge.ts`, and
`src/task-authority/graph-control.ts`.
