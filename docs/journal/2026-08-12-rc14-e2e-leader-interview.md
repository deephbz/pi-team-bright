# rc.14 E2E leader interview

Date: 2026-08-12
Role: isolated exact-source E2E leader and product user

## What failed or was slow?

One operation had an unknown result. The eighth Task create timed out during a
Beads list. The result gave the exact next action, `retry_same_operation`, and
the required operation ID. The identical retry created one Task, so recovery
was safe and clear. This was a Beads authority interaction, not a Worker launch,
Herdr, or `team_sync` failure.

No `team_sync` product call exceeded the 15-second gate. The watchdog measured
16 ms to 5,308 ms across 27 non-overlapping calls. Calls 2 and 6 were the
slowest useful calls at 5,308 ms and 4,932 ms. They returned substantial Worker
or Task changes. No product call felt stuck.

Manual markers made calls 12 and 20 look slow at 16,587.604 ms and 18,739.175
ms. Those markers included Sol reasoning and two bash turns. This was a test-
harness measurement defect, not product latency. The native session message
span was also too coarse for product acceptance.

`e2e-5` stayed in progress after the other probes closed. One attention Alert
caused it to write its preflight and result. No lifecycle tool failed. This can
come from Worker scheduling or model behavior; the evidence does not establish
a product defect.

## Which results were clear or confusing?

The clearest results were typed lifecycle receipts. `worker_ensured`,
`worker_stopped`, `caught_up`, final snapshot, and `team_shutdown` each stated
what changed. The Task-create unknown result was also good because it supplied
a safe, exact retry action.

The confusing result was a `team_sync` update that returned `change_kinds:
["progress"]` for nine Tasks with empty `journal_entries`. It refreshed current
cards but added no decision-relevant evidence. It consumed a turn and looked
like activity without new meaning. This is a product observation-projection
issue.

Some Task close state arrived one call before its result journal event. For
example, the recovery Task was closed while its result event was still pending
projection. The next update delivered event 53. The state was correct, but the
split made the leader spend another turn to prove the acceptance journal. This
is a product usability issue, though not a correctness failure.

A closed Task could retain `current_context: "Work has not started."` when a
Worker did not replace context during close. The result journal still proved
completion. This is primarily Worker mutation hygiene, not a Task-authority
defect, because current context updates are optional by contract.

## Which surfaces wasted turns?

The manual start/tool/end procedure wasted the most turns. It measured model
and harness delay instead of only the tool call. The external watchdog gave the
correct product boundary without changing coordination state.

Repeated caught-up calls were required by the stress protocol, not by normal
product use. The product returned a concise head and epoch each time.

Split close/result delivery and the empty progress refresh each caused an extra
interpretation or sync turn. These are real product opportunities. The
`task_read` batch used before cleanup was useful verification, not wasted work.

## Did `team_sync` feel stuck?

No. It always returned. During active work it delivered Worker-authored events,
and after quiescence it returned `caught_up`. The maximum product duration was
5,308 ms. The long manual markers briefly created a false stuck impression,
but watchdog evidence corrected it.

The maximum observed live descendant Beads list count was one. This made the
repaired serialized read path feel materially safer than the earlier feedback-
storm incident.

## Was exact-source isolation discoverable?

Only partly. The isolated `settings.json` made `packages: []` visible, and the
leader environment showed the isolated Pi directory. The running product did
not expose a loaded-extension source inventory. The native session header also
did not retain the complete launch argv.

Thus, the absence of ambient packages was discoverable, but the positive claim
that one exact worktree `-e` source loaded was not independently discoverable
from the product surface. This is an installation and harness-provenance gap.
It is not evidence that the wrong source loaded.

The earlier duplicate-installation failure did not recur in the isolated run.
That earlier effect belongs to installation discovery, not Herdr. Herdr created,
connected, replaced, and stopped all required carriers in this run.

## What increased or reduced confidence?

Recovery increased confidence most. The first `e2e-1` stopped normally. One
ensure call reused the logical name. The replacement then wrote a second
Terra-medium preflight and verified result. This separated logical Worker
identity from its carrier.

Cleanup also increased confidence. The final snapshot showed no nonterminal
Tasks. Eight exact stop calls succeeded. Reconciliation returned eight stopped
events. Shutdown returned lifecycle `stopped` with no unfinished Task IDs.

The word `created` on replacement ensure reduced confidence slightly because it
did not say `recovered` or identify the carrier generation on the model surface.
The second Task result removed the operational doubt, but the lifecycle receipt
alone was not enough.

The Task-create timeout reduced confidence in Beads responsiveness, but the
idempotent retry result increased confidence in authority recovery. No duplicate
Task appeared.

## Effects by source

Product effects were the empty progress refresh, split close/result projection,
and limited replacement wording. No product latency, lifecycle, recovery, or
cleanup defect appeared.

Test-harness effects were the invalid manual latency boundary and the need to
merge watchdog evidence after the run. Model-thinking effects were the Sol time
inside manual markers and the delayed `e2e-5` response. Beads caused the one
unknown Task-create outcome. Herdr had no observed failure. Installation effects
were limited to provenance discoverability; isolated settings prevented the
prior ambient duplicate.

## Strong opportunities and ranked action

1. **Fix before release:** make the release harness use watchdog
   toolCall-to-toolResult boundaries as the acceptance metric. Keep manual
   markers only as end-to-end interaction evidence. This is high confidence and
   does not require a product contract change.
2. **Ship rc.14 now:** the repaired product path passed eight-Worker model work,
   27 bounded non-overlapping sync calls, safe replacement, exact cleanup, and
   shutdown. No observed product defect blocks this candidate.
3. **Defer:** remove or label empty structural `progress` refreshes in
   `team_sync`. The opportunity is strong, but the run showed no incorrect
   state or cursor movement.
4. **Defer:** make split Task state and narrative-event delivery easier to
   interpret. A projection hint could state that journal evidence can follow a
   structural terminal change.
5. **Defer:** design an extension-source provenance surface outside this rc.14
   contract. It should report loaded source identity without exposing private
   paths in public receipts.
6. **Defer:** improve replacement lifecycle wording or internal QA evidence.
   Do not add carrier details to the public model contract without an ontology
   review.
