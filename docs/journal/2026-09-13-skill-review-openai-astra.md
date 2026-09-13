# Pi Team Bright skill review against OpenAI's Astra guidance

## Scope and evidence

Purpose: assess the packaged skill's selection, context cost, decision boundaries,
and completion guidance. This is a review, not an accepted policy change. It owns
recommendations only; executable contracts and maintained policy retain authority.
Architecture impact: none. No skill, runtime, or current-context changes were made.

- Reviewed: 2026-09-13, at source `d5ed077f1ddc1af2b76aa104e3938a6481c2e20d`.
- Stage: hardening. Package candidate: `0.17.5`.
- Target: [`SKILL.md`](../../skills/pi-team-bright/SKILL.md), 101 lines,
  827 whitespace-separated words. SHA-256:
  `8c094c96d00393738f5c04697c8fe8f4c572c5a2ba34bfb6cdddb52959e01961`.
- External source: Eric Provencher, [Rethinking skills and prompts for GPT-6
  Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra),
  dated September 11, 2026; retrieved successfully on the review date.
- Retrieved HTML SHA-256:
  `9b4c8451bba774021b6f4cfc51b0a974783182fcb03aadcee570f766d9c2aae9`.
- Existing untracked journals and evidence were left untouched.

The article recommends short, precise selection descriptions, conditional reference
loading, fewer rigid recipes, explicit permission boundaries, and clear completion
criteria. Its model-specific performance claims are source claims, not locally
verified facts. Pi's installed skill documentation confirms description-first
selection and conditional body loading; Codex's description-shortening behavior
must not be assumed for Pi.

## Assessment

Keep the coordination policy. Correct contract drift before reducing length.
The skill is already fairly small and avoids a copied parameter reference.
Its Team/Worker/Task lifecycle distinctions encode accepted operator intent,
not merely compensation for a less capable model.

### 1. High priority: distinguish graph retries from legacy Beads recovery

Lines 54–58 give Beads-oriented advice in the normal operating protocol. They
suggest reusing an operation ID with the current exact version after a timeout.
That must not become the graph-native retry rule. The graph controller includes
expected versions in operation fingerprints and checks replay before version
validation ([graph-control.ts](../../src/task-authority/graph-control.ts),
`transition` and `command`).

An in-memory probe confirmed that an identical original claim replays, while the
same operation ID with the newly read version refuses as different semantics.
This is a controller-level result, not an end-to-end timeout reproduction.

Recommendation: keep unknown-outcome caution, but distinguish replay from a new
decision. Replay the original graph command unchanged, including its expected
version. Reconcile state before issuing a new command with a new operation ID.
Move legacy-specific recovery behind a conditional reference if it remains needed.

### 2. Medium priority: explain graph revision consequences, not duplicate fields

Lines 43–45 describe creation and lines 59–60 repeat `needs`. They do not explain
that a later `task_graph_apply` replaces the complete current graph. The live schema
already calls this a complete graph revision; the missing value in the skill is
the consequence for a leader continuing work in a reused Team.

An in-memory probe confirmed that applying only B after A leaves only B in the
current graph. History remains separate. Recommendation: replace repeated field
advice with a brief warning to preserve intended nodes when revising the graph,
and to review changes that can supersede active work. Keep exact parameters in
[`graph-control-schemas.ts`](../../src/task-authority/graph-control-schemas.ts).

### 3. Medium priority: narrow the authority prohibition

Line 91 says, “Never mutate Team authority during normal operation.” Normal Team
lifecycle tools do mutate that authority. The linked rescue procedure makes the
intended restriction clearer: direct authority repair is exceptional.

Suggested wording: “Use Team tools for normal changes. Direct authority repair
requires the authorized rescue procedure.” Keep explicit owner authorization for
rescue and Team shutdown. The article does not justify removing those accepted
ownership boundaries. Premature stopping from this wording is a risk, not an
observed model outcome in this review.

### 4. Lower priority: reduce irrelevant instructions, not necessary policy

The root mixes leader operations, Worker transitions, legacy recovery, and hidden
observation internals. Worker transition instructions also appear in the runtime
bootstrap ([pi-team-session-adapter.ts](../../extensions/pi-team-session-adapter.ts),
line 635). `needs`, automatic dispatch, Alert semantics, and shutdown conditions
repeat within the root.

First consolidate duplicates. Then consider conditional references for Worker
operation and exceptional recovery. Keep the shared authority distinctions and
short normal leader path inline. Hidden branch-persistence mechanics can stay in
the contract source map unless they change the caller's next action. Do not split
this small skill into many files without a measured benefit.

The description is already short, but lists nouns instead of clear use conditions.
Candidate: “Coordinate Pi Team Bright Workers through assigned Tasks. Use when
creating or resuming a Team, delegating work, tracking outcomes, or managing its
lifecycle.” This is a proposal, not a ratified replacement.

## Keep and validate

Keep Task-only delegation, exceptional Alerts, event-driven supervision, reuse
before creation, causal-context continuity, independent verification when useful,
explicit success evidence, and the distinction between finishing work and ending
a Team. These are product contracts and judgment aids, not generic exhortations.

The completion guidance already aligns with the article. Task goals name an
outcome and external success signal. If a rewrite clarifies persistence, keep it
Task-scoped: continue within the assigned goal until evidence supports success,
criteria fail, or an external blocker prevents progress. Do not turn this into
permission for indefinite repair or automatic Team shutdown.

Before accepting a rewrite, compare the current and proposed skill using the same
harness and supported models. Use scenarios for Team reuse, independent review,
complete graph revision, lost mutation receipts, blocked work, and request
completion without shutdown. Inspect accepted tool actions and final Task state;
measure context size and unnecessary calls separately. No model A/B evaluation or
broad test suite ran in this review. Net behavior improvement remains unverified.

## Reproduction anchor

Run this disposable in-memory probe from the package root. It creates no Team,
Worker, terminal, or durable Task records.

```sh
node -r ts-node/register/transpile-only <<'JS'
const assert = require('node:assert/strict');
const { GraphTaskController } = require('./src/task-authority/graph-control');
const c = new GraphTaskController({default:'test/default',capable:'test/capable'});
c.applyGraph({operationId:'initial',tasks:[
  {key:'a',title:'A',goal:'Pass external check.',assignee:'builder'}
]});
const input = {
  taskId:'a',operationId:'claim-a',expectedVersion:c.readTask('a').version,
  transition:'claim',worker:'builder'
};
c.transition(input);
assert.equal(c.transition(input).replayed,true);
assert.throws(
  () => c.transition({...input,expectedVersion:c.readTask('a').version}),
  /different semantics/
);
c.applyGraph({operationId:'replace',expectedGraphVersion:c.currentGraphVersion(),
  tasks:[{key:'b',title:'B',goal:'Pass next check.',assignee:'builder'}]});
assert.deepEqual(c.readTasks().map(t=>t.id),['b']);
JS
```

Observed: original-input replay succeeded; changed-version reuse refused; omitted
A was absent from the replacement graph. No implementation blocker was found.
Owner review and model evaluation remain the next steps before changing policy.
