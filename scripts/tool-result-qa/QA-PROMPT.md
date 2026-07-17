# PiTeams tool-result QA rubric

You are reviewing projections, not the correctness of the underlying Team or
Task mutation. The supplied `oracle.before` and `oracle.after` are fixture
ground truth. Judge whether one real PiTeams tool execution presents that truth
appropriately to three different audiences. Judge each audience independently:
a polished TUI cannot compensate for incomplete machine evidence, and complete
machine details cannot compensate for insufficient or bloated agent content.

## Evaluation procedure

1. Establish the authoritative transition from `oracle.before`,
   `oracle.after`, `execution`, and the tool arguments. Treat the oracle as
   ground truth, not as a list of facts every projection must repeat.
2. Agent sufficiency: set `sufficient` to `true` only when agent content states
   every fact in `requiredAgentFacts` at enough specificity to make the declared
   `agentNextDecision` without an immediate compensating read. A read or wait
   explicitly named by that next decision is not compensating.
3. Agent excess: judge `excessive` separately. Set it to `true` when agent
   content includes material that does not change the next decision, repeats the
   same fact, exposes opaque implementation detail, or embeds a large body that
   should remain in `details`. A short resource ID or version needed for the
   next action is not excessive merely because it is technical.
4. Machine completeness: set `complete` to `true` only when `details` retains
   every item named in `machineEvidence` plus the identifiers, versions,
   provenance, receipt coordinates, and failure evidence needed to reconstruct
   or investigate the execution. Do not require facts irrelevant to this case.
5. Machine appropriateness: judge `appropriate` separately. It is `false` when
   `details` contains unbounded duplication, secrets, prompt bodies, unnecessary
   absolute runtime paths, rendered human prose instead of structured facts, or
   other data without a machine composition or traceability purpose. Rich,
   bounded structured evidence is not excessive merely because humans should
   not see it by default.
6. Human clarity: set `clear` to `true` only when the compact TUI lets an
   operator answer `humanQuestion` accurately in one scan and exposes the
   immediate warning or next action when one exists. Expanded TUI may carry
   supporting diagnostics but cannot repair a compact view that fails the
   declared question.
7. Human excess: judge `excessive` separately. Set it to `true` when compact TUI
   shows UUIDs, hashes, raw JSON, absolute paths, duplicated facts, or diagnostic
   detail that does not help answer `humanQuestion`. Such data may be appropriate
   in expanded TUI when it supports investigation.
8. Contradictions: compare every projection with the oracle and with the other
   projections. Record any invented state, stale state presented as current,
   incompatible outcome/status/owner/version, or claim of success that conflicts
   with failure evidence. Missing information is not a contradiction.

Apply the audience boundary semantically, not as an exact-phrase checklist:

- A projection satisfies a required fact when it states an equivalent fact at
  decision-making specificity; don't require redundant sentences that merely
  spell out an already-unambiguous implication.
- For a truncated event page, the returned count, explicit truncation, and
  continuation cursor are sufficient. Don't demand an exact remaining-event
  count from cursor arithmetic because filters can make journal distance differ
  from the number of matching unread events.
- A future cursor is not corrected by returning the lower journal head as
  successful progress. The actionable recovery is a fresh snapshot, so don't
  require the compact view to present the lower head as the next usable cursor.
- Bounded authoritative Task post-state in machine `details`, including Task
  description and acceptance criteria, is traceability evidence rather than a
  leaked prompt body. Flag it only when it is duplicated, unbounded, secret, or
  unrelated to the authoritative resource represented by the result.
- A Task ID and relation target ID are semantic operation coordinates, not
  opaque implementation IDs. Showing each once is appropriate in agent and TUI
  projections; repeating the same source/relation/target fact on a second line
  is excess.
- A resource ID shown once in current-state context and once in an actionable
  next action is not redundant: the first identifies the state, while the
  second binds the operation. Flag repetition only when the same ID is repeated
  within one semantic role without adding decision value.
- For an event page, one grouped semantic summary such as `Worker reviewer
  failed x20` is not repeated-event excess. It tells the observer which event
  caused the wake-up while compressing the batch; flag per-event repetition,
  opaque Membership IDs, or grouped detail unrelated to the next decision.
- For an idempotent relation no-op, unchanged graph/version and empty applied
  operations are sufficient. Don't require agent or TUI prose to separately
  state that delivery wasn't attempted unless the declared next decision
  depends on delivery.
- For a rejected relation mutation, `relation not changed` plus the requested
  add/remove operation establishes the edge outcome. Don't demand a second
  sentence restating the full edge unless the result is otherwise ambiguous.
- Arguments rendered under `nextActions` describe a proposed future call, not
  the executed request. A retry's `expected_version` may therefore equal the
  current version without contradicting the stale `requestedVersion` retained
  in evidence.
- For observation tools such as `team_sync`, unchanged `oracle.before` and
  `oracle.after` mean the read itself caused no authority mutation. They don't
  contradict an event saying that state changed after the supplied cursor but
  before the observation; use the event timestamp/reference and hydrated
  current state to judge that temporal claim.
- Don't require result `details` to echo request arguments already present in
  `call.arguments`, such as Alert text. Machine completeness requires the
  accepted Alert identity, Task reference, delivery receipts, event cursor,
  and failures; duplicating the input payload is not reconstruction evidence.

## Evidence discipline

Every item in `missing`, `excess`, `inappropriate`, or `contradictions` must be
concrete. Name the exact absent or displayed fact and the projection where it
belongs or appears. Do not write vague findings such as "too verbose", "missing
context", "could be clearer", or "details are noisy".

The arrays and booleans must agree:

- `sufficient: true` requires `agent.missing: []`; `sufficient: false` requires
  at least one concrete missing fact.
- `agent.excessive: true` requires at least one concrete `agent.excess` item;
  `false` requires an empty array.
- `complete: true` requires `machine.missing: []`; `false` requires at least one
  concrete missing evidence item.
- `appropriate: true` requires `machine.inappropriate: []`; `false` requires at
  least one concrete inappropriate item.
- `clear: true` requires `human.missing: []`; `false` requires at least one
  concrete clarity failure.
- `human.excessive: true` requires at least one concrete `human.excess` item;
  `false` requires an empty array.

A case is satisfied only when agent content is sufficient and not excessive,
machine details are complete and appropriate, compact TUI is clear and not
excessive, and there are no contradictions. This is strict but achievable:
do not invent deficiencies beyond the case's declared decision, evidence, and
operator question.

Do not propose another PiTeams tool or change authoritative behavior. Recommend
only the smallest projection change to `content`, `details`, or `renderResult`
that resolves findings. Use an empty string for a `minimalRevision` field when
that projection needs no change.

Return exactly one JSON object per case:

```json
{
  "caseId": "...",
  "agent": {
    "sufficient": true,
    "excessive": false,
    "missing": [],
    "excess": []
  },
  "machine": {
    "complete": true,
    "appropriate": true,
    "missing": [],
    "inappropriate": []
  },
  "human": {
    "clear": true,
    "excessive": false,
    "missing": [],
    "excess": []
  },
  "contradictions": [],
  "minimalRevision": {
    "agentContent": "",
    "detailsChange": "",
    "tuiCompact": "",
    "tuiExpanded": ""
  }
}
```
