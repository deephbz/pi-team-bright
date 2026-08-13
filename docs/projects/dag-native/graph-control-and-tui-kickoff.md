# Graph-native control flow and Task graph TUI kickoff

Date: 2026-08-13
Stage: shaping with bounded prototypes on the hardening DAG branch
Base: `feature/dag-native-rc13` at `fb9768b332435dcd5614946dd5c279920dce52ee`

## Problem

The first real `plan -> implement -> review -> verify` run proved mechanical
ready-front dispatch, but it exposed two semantic gaps. A Worker used `blocked`
to represent ordinary dependency waiting, and closing a failed review released
verification because Task closure did not distinguish completion from accepted
success. The human view also lacks a compact graph projection that makes the
ready front, active work, failed gates, loops, and joins visible.

## Desired outcome

Make Task primitives graph-native without adding a separate Workflow authority
or model-facing workflow language. The graph must represent natural dependency
waiting and bounded retry or repair loops until an explicit success criterion is
met. Ordinary control flow must remain mechanical. A human side pane must render
the same authoritative Task graph without becoming another Task authority.

## Initial concept graph

```text
Task ──assigned_to──> Worker
Task ──depends_on───> Task
Attempt ──advances──> Task
Attempt ──evaluated_by──> Criterion
CriterionResult ──permits──> successor readiness
CriterionResult ──requests_repair──> next Attempt
TaskGraph ──projected_as──> HumanGraphView
```

Candidate distinctions require validation before they become contracts:

- dependency waiting is derived graph state, not a Worker-authored blocker;
- work completion and success acceptance are not the same fact;
- a loop creates another bounded Attempt or activates an explicit repair edge;
  it must not mutate history or reopen work without provenance;
- graph authority owns nodes, typed edges, criteria, attempts, and readiness;
- the TUI consumes canonical graph records and renders them. It owns no work
  state, scheduling decision, or inferred success.

## Constraints

- Keep `Task + assignee` as the executable work contract.
- Keep one Task assigned to one stable Worker. Use joins for multi-Worker work.
- Do not make Alerts, `team_sync`, terminal activity, or the renderer schedule
  work.
- Preserve Beads as an adapter. Native Beads vocabulary must not define the
  graph-neutral contract.
- Keep the model-facing tool count and token budget small.
- Encode only distinctions needed for safe mechanical composition.
- Preserve exact operation replay, Task versions, raw history, and recovery.
- Use a structured graph projection as source; Graphviz or another renderer is
  derived output.
- Do not push, tag, publish, or change npm registry state.

## Parallel investigations

### Graph control semantics

Distill the smallest graph ontology and state transitions that can represent
waiting, pass/fail review gates, repair loops, attempt history, joins, and
termination. Test the design against the failed Auto Compact workflow and
adversarial permutations. Produce a reviewable design artifact and a bounded
executable prototype or contract tests where they remove ambiguity.

### Human graph projection

Clone and inspect `https://github.com/smarzban/herdr-file-viewer` as reference
evidence. Determine how a Pi Team Bright TUI command can open and maintain a
side pane in the current Herdr tab, then render the canonical Task graph with a
backend-first representation. Build the smallest safe prototype with focused
tests. The pane must not depend on focus, mutate Task state, or retain private
machine coordinates in tracked fixtures.

## Acceptance signals

- The graph design explains the earlier dependency-wait and failed-review
  incidents without special-case states.
- A loop has explicit success, retry, exhaustion, and cancellation semantics.
- Illegal or ambiguous graph transitions refuse deterministically.
- The model surface remains minimal and its token impact is measured.
- A side-pane prototype renders a representative graph from structured Task
  data and follows supported Herdr control semantics.
- Tests anchor graph behavior and renderer input/output boundaries.
- Each investigation records findings, rejected paths, remaining uncertainty,
  and exact source commits.
