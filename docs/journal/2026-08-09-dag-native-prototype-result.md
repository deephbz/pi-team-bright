# DAG-native prototype result

Date: 2026-08-09
Branch: `prototype/dag-native`
Baseline: `e55b4f2a9190d700a03d95cb9dee75e5c892ca0a`
Architecture impact: changed inside Task authority and the trio-facing contract;
no new component or process boundary

## Result

The isolated prototype now has a DAG-native vertical slice. The public leader
surface uses one atomic `task_create` request with a request operation ID,
local Task keys, and `task needs prerequisite` dependencies. The normal leader
surface has nine tools and no `task_link`.

The portable Task-authority modules validate keys, references, Workers,
versions, duplicate edges, self-edges, and cycles. They derive readiness,
refuse claims with active blocker IDs, reserve one execution slot per Worker,
and advance different Workers in parallel. A snapshot/recovery reference proves
commit-before-presentation and pending-delivery recovery.

The Beads adapter uses native `bd create --graph`. Graph-operation metadata on
each created node supplies exact replay and key-to-ID recovery. Exact replay
returns before validating an expansion's now-stale original version, so a
successful expansion can replay after its dependent Task version changes.
Changed replay refuses, and native duplicate creation does not occur.

Current durable composition appends creation events after the graph commit and
reconciles ready Task-version deliveries after graph creation, Task updates,
and Worker ensure. Existing Task delivery records act as Worker slot evidence.
A blocked or closed Task releases its slot. Delivery still requires explicit
Worker claim.

## Verification anchors

Focused deterministic evidence passed 38 tests across DAG policy, replay,
registered schemas, projection parity, blocker-aware claim, and current Task
adapter regression coverage. A second 35-test surface and projection slice also
passed.

The stable tree passed `npm test` with 57 files and 442 tests. The exhaustive
lane passed 77 files and 593 tests. Package installation, generated distribution,
agent-surface QA, and the 77-file lane manifest also passed.

Real owned-Beads evidence passed:

- atomic four-Task creation, cycle refusal, exact replay, changed replay
  refusal, and existing-dependent expansion;
- six-Task ready-front delivery across `maker` and `reviewer`;
- active-blocker claim refusal before native mutation;
- automatic successor delivery after close, with no leader scheduling call;
- parallel ready Tasks for different Workers;
- one queued sibling for the same Worker;
- blocked work releasing the Worker slot while the join remains waiting.

The machine receipt is
[`artifacts/2026-08-09-dag-native-prototype-result.json`](artifacts/2026-08-09-dag-native-prototype-result.json).

## Remaining limits

This is a wishful post-refactor prototype, not a release candidate. A crash can
still occur after atomic Beads graph commit but before creation events append.
Exact graph replay recovers Tasks and delivery, but it deliberately avoids
duplicate creation events, so the post-refactor Task authority needs one durable
publication outbox.

The current cutover schema admits stored pre-DAG Task cards without relation and
readiness fields, while all new adapter projections emit them. The port should
make these fields mandatory after stopped-epoch migration evidence exists.

No real interactive Pi multi-Session canary ran in this worktree. Deterministic
Session delivery records and the portable presentation reference cover the
mechanical path, but the post-refactor port still needs one headless Pi canary.
