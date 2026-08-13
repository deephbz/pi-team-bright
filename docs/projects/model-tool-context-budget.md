# Model-tool context budget

Updated: 2026-08-12
Stage: hardening a breaking model-facing contract
Status: implemented and verified locally on `feature/dag-native-rc13`

## Problem

Pi sends every active tool definition to the model. These definitions consume
input context on each uncached request. The schema must remain clear enough for a
model to select and call tools correctly, but it must not expose backend grammar
or repeat prose that does not change a model decision.

This audit compares the published semantic-hardening source `53367e4`, DAG source
`24ec804`, and the optimized working surface. System Prompt Audit captured each
historical extension in an isolated Pi 0.83.0 Session with no discovered skills,
prompts, themes, extensions, or context files. The stable comparison serializes
registered tool definitions as compact JSON and estimates tokens with
`o200k_base`; provider framing is excluded.

## Evidence

| Surface | Tools | Tool tokens | Skill tokens |
|---|---:|---:|---:|
| Published RC13 `53367e4` | 10 | 1,597 | 802 |
| DAG baseline `24ec804` | 9 | 1,716 | 899 |
| Optimized working surface | 9 | 1,191 | 902 |

The optimized surface is 525 tokens smaller than the DAG baseline, a 31%
reduction. It is 406 tokens smaller than RC13 despite adding atomic DAG creation.

The main changes are:

- `task_create`: 505 to 300 tokens by embedding local prerequisite keys in each
  Task instead of exposing nested new/existing reference unions;
- `alert_send`: 328 to 152 tokens by using scalar `to` with runtime fanout
  validation instead of a nested target union;
- the other seven tools: 883 to 739 tokens by giving each tool one
  pairwise-discriminative description and removing repeated root-schema prose.

Historical snapshot integrity:

- `53367e4`: `8000c8071313522b4bbb56b1e23536c75060e0d1835d53f4d316d83cc64e471d`;
- `24ec804`: `78a5f5673e852295da664268569149ed075f433978e9078d49a5efe9727cff61`.

The snapshots are disposable local evidence under temporary worktrees. They can
contain local paths and do not ship. The final isolated System Prompt Audit
export has content SHA-256
`483bef8a47ca9a9b17c3be5a6b95f926abc7301879ea47f2f1e4a917078c5894`.

## General principle

Optimize the model's complete decision path, not the shortest schema.

```text
choose the tool -> form a valid call -> receive the next needed facts
```

Allocate information once, at the decision phase that needs it:

1. The tool name states the stable domain verb and noun.
2. The tool description states its effect and distinguishes its nearest tool.
3. A field description exists only when its name and type do not explain its
   format, coordinate system, or non-obvious role.
4. The schema encodes cheap structural distinctions needed for safe composition.
5. Runtime authority enforces atomicity, authorization, graph validity,
   optimistic concurrency, cross-field rules, and replay.
6. The skill owns cross-tool protocol and recovery procedure.
7. The model result returns dynamic facts needed for the next safe decision.
8. Raw details, TUI projections, generated review, and traces retain complete
   evidence without spending provider-definition tokens.

A concise form of the rule is:

> Use a shallow, regular common grammar; spend words on tool selection and
> unfamiliar coordinates; keep safety in authority; return decision-complete,
> non-echoing receipts.

Token reduction is rejected when it adds positional tuples, abbreviated field
names, tagged-string mini-languages, overlapping verbs, or an extra repair turn.

## External review

OpenAI's function-calling guide says definitions count as billed input tokens.
It recommends clear names and parameter descriptions, an intuitive interface,
invalid-state prevention, fewer initially loaded functions, and moving known or
chained work into code. It also notes examples can hurt reasoning-model
performance. Source:
<https://developers.openai.com/api/docs/guides/function-calling>.

OpenAI's tool-search guide confirms that deferred individual functions still
show their names and descriptions, while parameter schemas create most deferred
savings. It recommends clear, short namespace descriptions. Pi does not yet use
this provider-specific feature. Source:
<https://developers.openai.com/api/docs/guides/tools-tool-search>.

Anthropic recommends detailed descriptions, fewer clear tools, meaningful names,
high-signal results, and evaluation against real tasks. Its example guidance also
states that examples add prompt tokens. Source:
<https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools>.

Anthropic's engineering guidance says tools are contracts between deterministic
systems and nondeterministic agents. It recommends evaluations that measure task
success, tool calls, tokens, and errors, plus response shaping that returns only
relevant next-step context. Source:
<https://www.anthropic.com/engineering/writing-tools-for-agents>.

These sources differ on description length. The reconciled rule is not “short”
or “detailed.” A description must be complete for tool selection, while field
and skill guidance own call construction and workflow. Repeated facts add cost
without adding clarity.

Oracle independently recommended keeping DAG semantics but replacing the nested
grammar, using pairwise-discriminative descriptions, preserving runtime safety,
and delaying aggressive result reduction until workflow evaluation proves it.
Its first review is external advisory evidence, not contract authority.

## Accepted contract

```ts
task_create({
  operation_id,
  tasks: [{ key, title, goal, assignee, needs?: string[] }]
})

alert_send({
  to: WorkerName | "*",
  kind: "clarification" | "attention" | "announcement",
  text,
  task_id?,
  task_version?
})
```

`tasks[].needs` contains request-local prerequisite keys. Existing-Task graph
expansion is removed from the frequent model verb. Internal Task authority keeps
its proven graph capability.

For Alerts, `*` accepts only `announcement`. Worker names accept only
`clarification` or `attention`. `task_version` requires `task_id`. Runtime refuses
invalid combinations before authority mutation.

## Deferred result work

The first release keeps current model result projections. Result changes can
cause extra reads, stale decisions, or poor post-compaction orientation even when
the individual response is smaller.

Later ablations can evaluate:

- removing transport `head` and `epoch_id` from model-facing `caught_up`;
- returning only key-to-ID/version coordinates from successful DAG creation;
- removing redundant batch correlation fields from found Task reads;
- using compact incremental Task summaries while keeping complete snapshots and
  `task_read` cards.

Each candidate must reduce full-workflow tokens without reducing task success,
safety, replay correctness, or recovery quality.

## Governance

`scripts/model-tool-context-budget.test.ts` sets compact-character budgets for
each registered provider definition. Compact characters are stable across local
environments; tokenizer estimates remain reported evidence. The test also blocks
nested unions from re-entering `task_create` and `alert_send`, checks active tool
identity, and detects repeated root/tool descriptions.

The generated review, executable schemas, examples, skill, and provider snapshot
must change in one vertical slice. A later CI slice should derive compact call
signatures from schemas instead of maintaining hard-coded renderer strings.

## Verification result

The final tree passed the complete exhaustive lane, including real Beads graph,
replay, delivery, recovery, alert, stale-write, and tool-result behavior. Package
build and generated-output checks passed. The agent-surface snapshot, per-tool
context budgets, test-lane manifest, generated model-tool review, and diff checks
also passed.

During aggregate verification, two old test adapters still assumed the replaced
surface. One dropped `tasks[].needs`, and one searched for the old Alert `target`
field. Both now verify the current public contract. A concurrent claim test also
assumed a conflict read always observes the winner's final status. It now checks
the actual invariant: one claim commits, one stale write is refused, and both
observed versions advance beyond the create revision. No runtime weakening was
needed.
