# Lead ownership and end-of-message synchronization

## Intent and authorized scope

The owner approved the skill rewrite shown in the light-mode diff review, then
requested two refinements: the single lead must own project direction as well as
coordination, and it must call `team_sync` after messages while Tasks are in flight.
Apply the approved draft and these refinements to the packaged skill. Keep this
change limited to operating guidance and its review artifacts; do not alter runtime,
Task authority, delivery, tool schemas, or lifecycle policy.

Product base: `d5ed077f1ddc1af2b76aa104e3938a6481c2e20d`.
Accepted drafting base: the exact Markdown candidate in
[`2026-09-13-skill-interface-rethink.md`](2026-09-13-skill-interface-rethink.md),
previously rendered by `artifacts/2026-09-13-skill-diff-review/`.
This is a refinement of the same skill-clarity intent. Existing untracked historical
journals remain outside the change. Stage: hardening. Architecture impact: none;
these are operating responsibilities, not new authorities or topology.

## Owner observations

- Leads sometimes act as coordinators only, without owning the user's project
  context, motivation, objective, constraints, approach, and Task decomposition.
- Leads sometimes stop after prose while assigned work remains, leaving routine
  progress unobserved until an Alert or later wake-up.

These are owner-reported incidents. The current source also has a delayed sync
nudge; its presence does not make it a substitute for active supervision.

## Intended operating rule

The one lead carries two responsibilities:

1. Project lead: communicate with the user, understand and preserve intent and
   constraints, choose an approach, decompose work, evaluate outcomes, and explain
   trade-offs. Delegation does not transfer accountability or the user's authority.
2. Coordinator: assign Tasks to suitable Workers, provide context and resources,
   resolve blockers, supervise outcomes, and escalate decisions to the user.

Keep Task graph assignment separate from Alerts and context updates. An Alert can
clarify, but new work and definition changes use `task_graph_apply`; `task_update`
records Task context or transitions.

Define in-flight work as assigned nonterminal Tasks, including waiting or blocked
Tasks. While those remain, user-facing replies and progress notes are interim
messages followed by `team_sync({view:"updates"})` as the last action before yielding.
A mutation receipt does not replace this sync: the call observes other Workers and
waits for subsequent changes rather than rechecking the lead's own write.
Handle returned changes and return to synchronization while work can progress.
A blocker escalation message must also be followed by the required sync call.
Avoid identical empty-call loops when no actor can progress; make the blocker and
next actor explicit instead. Keep explicit owner pause/stop instructions authoritative.

## Verification boundary

Inspect current sync return behavior and injected prompts. Independently review
that the skill has both responsibilities, an actionable message-to-tool ordering
rule, and no conflicting no-sync instruction. Verify Markdown structure and links,
then refresh the light-mode webpage against the owner's approved drafting base.
No broad package suite is justified for these prose-only changes. Do not claim a
model compliance or runtime liveness guarantee from source checks alone.

`team_sync` is a bounded observation/wait call, not a permanent subscription.
`caught_up` and `indeterminate` can return with nonterminal Tasks. The skill can
require the call and appropriate next action; runtime enforcement would be a
separate, explicitly scoped change.

## Delivered result

The approved rewrite and both owner refinements are now applied in
`skills/pi-team-bright/SKILL.md`. `docs/current/README.md` points to the skill's
operating procedure and distinguishes it from runtime enforcement. The change is
uncommitted; no package version or release artifact changed.

The catalog's `team_sync.whenNotToUse` prose now distinguishes rechecking the lead's
own receipt from continued Worker supervision. The actual registered description
uses only `responsibility`, so this is documentation coherence, not a runtime or
schema change. An initial reviewer objection confused those two surfaces; the
independent assessment records the correction.

The approved rewrite exposed brittle prose-matching assertions in
`src/utils/tool-surface.test.ts`. Those assertions were removed rather than adapted
to new wording. Executable registration/schema coverage and structural doc checks
remain. Independent verification ran the focused file once successfully through
the installed repository-level Vitest executable: 1 file, 9 tests passed. A prior
package-local command failed before starting tests because that binary path did
not exist; Task clarification resolved it without installing dependencies.
The independent [receipt](artifacts/2026-09-13-lead-sync-verification.md) records
source hashes, checks, corrections, and the remaining model-compliance uncertainty.

The light-mode review at `http://127.0.0.1:4381/?review=lead-sync` now compares the
owner-approved rewrite against the current working skill. Its generated patch
passed a reverse applicability check against the working file. Browser verification
found two correctly rendered columns, light mode, and no page errors. The webpage
remains read-only; its [source and receipt](artifacts/2026-09-13-skill-diff-review/README.md)
are durable reproduction pointers.

Coordination evidence: Team `pi-team-bright-guidance`, graph revision
`g_7b23283de1406a41`, with `lead-sync-skill`, `verify-lead-sync`,
`align-skill-surface-check`, and `verify-skill-surface-check` all `goal_achieved`.
The Team and reusable Workers remain available for related work. No nonterminal
assigned Tasks or material blockers remain. Architecture impact: none.
