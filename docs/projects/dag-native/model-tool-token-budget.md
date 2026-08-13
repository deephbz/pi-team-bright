# DAG model-tool token budget

Updated: 2026-08-12
Stage: shaping before a breaking model-tool revision
Status: superseded by the implemented cross-surface [context budget](../model-tool-context-budget.md)

## Decision direction

This shaping record preserves the DAG-specific alternatives and measurements.
The cross-surface artifact owns the accepted contract and current evidence.

Make the common `task_create` call shallow:

```ts
task_create({
  operation_id,
  tasks: [{
    key,
    title,
    goal,
    assignee,
    needs?: string[]
  }]
})
```

Each `needs` value is a request-local prerequisite Task key. One Task remains the
one-node case. The tool still creates all Tasks and edges atomically, validates
Workers, detects cycles, and replays by `operation_id`.

Do not expose existing-Task graph expansion in this first contract. Its nested
reference unions cause most schema cost, while no canary or stress test required
that feature. Keep the authority capability below the model boundary until an
operator case proves that it belongs in the frequent create verb.

Do not merge unrelated tools only to reduce the tool count. Stable verbs help the
model. Complex parameter grammar causes the measured cost.

## Snapshot evidence

System Prompt Audit exported the exact isolated Pi 0.83.0 session with Pi's four
built-in tools and the DAG branch's nine active tools. The ignored local snapshot
has SHA-256
`28d4d6729ba67f21f65873cdac751dd56cb3f190afbc497ae2ca710b05c1a57d`.
The local JSON export can contain machine paths and must not ship.

Counts below serialize only the provider-relevant
`{name, description, parameters}` fields. Token counts use `o200k_base` as a
stable estimate. A provider can add framing, so these aren't wire-billing claims.

- Pi's four built-ins: 2,711 compact characters and 584 estimated tokens.
- Pi Team Bright's nine tools: 7,571 characters and 1,703 estimated tokens.
- Current `task_create`: 2,040 characters and 500 estimated tokens.
- Current `task_create` parameters alone: 1,888 characters and 476 tokens.
- Current `task_create` uses 29% of the Team tool token budget. It costs 86% as
  much as all four Pi built-ins together.

The owner's approximate 1,000-token observation remains plausible for pretty or
provider-expanded serialization. The reproducible compact estimate is 500
before provider framing.

## Why Pi's tools are easier

Pi uses a shallow object for each verb. It uses arrays for natural repeated
records. It puts short operational meaning in descriptions. It keeps parsers and
correctness rules behind the tool.

Current DAG creation instead repeats nested object unions:

```text
BEFORE
operation_id
 tasks[]
   key, title, goal, assignee
 dependencies[]
   task
     { key } | { task_id, expected_version }
   needs[]
     { key } | { task_id }

AFTER
operation_id
 tasks[]
   key, title, goal, assignee
   needs[]?                 # request-local prerequisite keys
```

The old descriptions use only 99 characters. Removing descriptions cannot solve
the problem. Repeated `type`, `properties`, `required`, `additionalProperties`,
limits, patterns, and union arms cause the cost.

## Measured alternatives

The proposed local embedded form costs 1,145 compact characters and 277
estimated tokens. It removes 45% of the current tool-definition tokens. A
four-node chain call falls from 146 to 110 estimated tokens, a 25% reduction.

Keeping an `extend[]` record with scalar tagged references costs about 401 tool
Definition tokens. It saves only 20% and introduces a reference mini-language.
Splitting local and existing reference arrays costs about 427 tokens. It saves
only 15% and gives the model more fields to coordinate.

Dependency tuples cost about 300 tokens, but their positional meaning is less
clear. A separate dependency map costs about 338 tokens and separates edges from
Task intent. Short field renames save little and increase the learning cost.

## Preserved and deferred semantics

The smaller public shape preserves:

- one atomic graph mutation;
- one caller operation identity and exact replay semantics;
- one stable Worker assignee per Task;
- local-key validation, duplicate-edge checks, cycle refusal, and no partial
  writes;
- direct Beads graph translation;
- mechanical ready-front delivery.

It defers adding prerequisites to an existing Task within `task_create`. This is
a public-surface reduction, not an authority limitation. If real traces prove the
need, shape one explicit, infrequent mutation without adding unions to the common
create path.

## Result pointer

The accepted vertical slice and its current verification evidence live in the
[cross-surface context budget](../model-tool-context-budget.md).
