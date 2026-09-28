# 0017 — One lead, a fact/opinion delegation boundary, and an opt-in second opinion

Date: 2026-09-28
Status: accepted; guidance only, no runtime change; unreleased

## Context

The lead carries two responsibilities: project lead (intent, decomposition,
evaluation, user communication) and coordinator (assignment, context, blockers,
supervision). Two failure modes appeared in real use:

- The lead delegated understanding. A Worker searched git history, messages,
  and data artifacts, interpreted them, and wrote the report; the lead relayed
  the report without reading the sources.
- Reviewers shared the builder's framing. A review Task that carried the
  implementation history produced a review of the process, not of the
  deliverable as its audience would see it.

## Decision

### Keep one lead

The project-lead and coordinator responsibilities stay in one lead. Both need
the same project understanding: task splitting, clarification, and blocker
decisions depend on it. Mechanical coordination belongs in the runtime, as
Decisions [0010](0010-dag-native-task-creation.md) and
[0016](0016-framework-team-synchronization.md) established: the runtime selects
and delivers ready Tasks, advances success and repair routes, and keeps one wait
open. Revisit only if measured lead turns show operations work that needs no
project understanding and cannot move into the runtime.

### Workers establish facts; the lead forms opinions

The lead delegates bounded work whose result can be checked: searching history,
messages, data artifacts, and schemas; locating relevant sources; schema and
contract checks; lint and type fixes; CI monitoring; experiments. A fact-finding
Task delivers located sources with pointers and verified facts, at high
precision and high recall, with observation separated from interpretation.

The lead does not delegate understanding. It reads the located sources, forms
the whole picture, and writes the final report. When the material is too large,
it reads the parts that decide the outcome, checks the Worker's interpretation
against them, and marks unchecked interpretation provisional.

### Second opinion: opt-in, collaborative, from a reading bundle

The lead reviews deliverables itself by default. The user requests a second
opinion for high-stakes work. `second-opinion` is the packaged example model
role name; it is configuration, and the runtime attaches no behavior to it.

- Independent judgment. A review Task asks for a verdict and ranked findings
  with a concrete simpler alternative for each, never for confirmation. The
  lead answers disagreement with reasons and escalates unresolved disagreement
  to the user.
- Reading bundle. Task prose gives the goal in the user's terms, the audience,
  deliberate constraints, and direct pointers to the deliverable and the sources
  needed to judge it. It leaves out the implementation history and earlier
  Attempts. Pointers cut the second opinion's search turns; the omitted
  narrative keeps its perspective fresh.
- Findings, not fixes. Repair stays with the builder through a bounded failure
  route.
- One second-opinion Worker per Team. The lead creates another only when the
  user asks for a cold read of one deliverable, and stops it after that Task.

This changes one sentence of Decision [0014](0014-worker-model-profiles.md):
"A separate persistent reviewer supplies the frontier perspective" becomes
opt-in at the user's request. Fixed Worker model bindings are unchanged.

## Sources

- Agent procedure: [`skills/pi-team-bright/SKILL.md`](../../skills/pi-team-bright/SKILL.md)
  sections "Lead: delegate facts, keep opinions", "Lead: work with a second
  opinion", and the Worker rules for fact-finding and second-opinion Tasks.
- Entry-point protocol: [`AGENTS.md`](../../AGENTS.md).
- Example role: [`docs/examples/pi-team-bright.settings.json`](../examples/pi-team-bright.settings.json).

## Verification and reversal

Guidance has no unit test. Verify in real Team runs: one where a Worker locates
context and the lead reads the located sources before reporting; one where a
second opinion judges a diff from a reading bundle and the builder repairs
through a failure route. Record both in the journal.

Revisit the delegation boundary if lead context pressure persists after Workers
locate sources with high precision. Revisit the opt-in default if routine work
shows accidental complexity that the lead's own review misses.
