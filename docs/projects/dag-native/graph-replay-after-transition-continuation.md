# Graph replay after Task transitions continuation

Updated: 2026-08-13
Task: `ptb-graph-native-next-gs9`
Status: in progress; implementation and focused verification complete, commit and real canary pending

## Work contract

At exact accepted tip `5c440223f55edf6c58bd10d70e034b7b6aea0a22`, repair this counterexample:
apply graph operation X, advance a retained Task through claim or another
transition, then byte-identically replay X. Replay must return `replayed: true`
without a retirement conflict. It must not roll back the later authority
sequence or exact current Task versions. Preserve interrupted-retirement repair
and immutable first-write retired-version history. Add focused replay tests,
commit, and rerun an isolated real Worker scenario. Do not push, tag, publish,
use a fallback Session, edit credentials, or mutate the registry.

## Proven owning defect

The `/2` retirement record currently uses one record for two different facts:

1. immutable operation evidence for a graph apply; and
2. the evolving exact-currentness fence after later Task transitions.

`revisionSemantics` includes graph version, graph sequence, authority sequence,
operation ID, and current Task coordinates. `recordGraphRevisionRetirementLocked`
looks up the first history record by operation ID and compares all those fields.
After a Task transition, an exact replay of graph operation X correctly reads
the later current Task cards and later authority sequence from graph authority.
Those evolving coordinates differ from X's first retirement record, so replay
reports an operation conflict even though the graph command is byte-identical.

The graph controller does not roll authority back on replay. Its stored command
receipt returns `replayed: true`; the durable authority wrapper still projects
the current cards and latest authority sequence. The conflict is therefore in
the retirement adapter's mixed identity, not graph command replay.

## Selected repair

Keep two semantic comparisons inside the durable retirement boundary:

- Stable operation identity: graph version, graph revision sequence, and
  operation ID. It validates exact graph-operation replay. First-write retired
  Task coordinates remain immutable history and are not recomputed by replay.
- Monotonic currentness: graph version, graph revision sequence, authority
  sequence, and complete exact current Task ID+version coordinates. It excludes
  operation ID and retired history because either an apply or a transition can
  publish the same currentness fact.

When an exact older operation replays after a later transition, validate its
stable operation identity, then keep the later current fence. When the replay's
projected authority sequence equals the current fence, accept only identical
currentness and return the existing snapshot. Never replace current provenance
or current Task versions with the operation's first-write record.

This keeps the `/2` ontology small: operation receipt/history and current fence
remain distinct meanings even if they share one snapshot container. A schema
change is unnecessary.

## Implementation status

`graphOperationSemantics` now compares only graph version, graph sequence, and
operation ID. `currentnessSemantics` compares graph version, graph sequence,
authority sequence, and complete exact current Task coordinates. Exact older
operation replay validates the stable receipt, then returns the later monotonic
fence unchanged. A newer currentness write creates the current record from the
new candidate, while existing operation history stays immutable.

The new apply -> claim -> exact replay -> result -> exact replay test proves
`replayed: true`, no retirement warning, unchanged later Task cards and authority
sequences, and one first-write removal record. A changed graph version or graph
sequence under the same operation ID still refuses. The 14-case replacement
suite passes. Eight focused compatibility files pass 81 tests, and typecheck
passes. Commit and real Worker evidence remain.

## Required tests

Add a focused reproduction for apply X -> claim -> byte-identical replay X.
Assert `replayed: true`, no retirement warning, unchanged later authority
sequence, unchanged in-progress Task version, and retained first-write history.

Cover at least one later result or context transition as well. Keep the existing
removal replay, interrupted retirement repair, `/1` repair, retained-version
state matrix, staged acknowledgement, delivery, recovery, owner-transition,
and Coordination compatibility checks green.

Then run typecheck and the proportional focused lane. Commit the coherent fix.
Launch an isolated exact-source coordinator through `_codex_with_proxy` with
Terra-medium, repaired non-secret Worker defaults, `packages: []`, and the exact
extension. Require a Worker-authored launch event. Apply X, let the Worker claim
or complete the retained Task, replay X exactly, prove no warning or rollback,
then stop the exact Worker and shut down with no unfinished Tasks.
