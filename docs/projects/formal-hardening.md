---
purpose: Harden existing Pi Team Bright behavior with bounded formal models and adversarial implementation evidence.
scope: Existing Task, Attempt, Membership, delivery, observation, and test contracts; no new product capability or publication.
status: completed local hardening and verification; unreleased
---

# Formal hardening

## Intent and base

The owner authorized bug fixes, incoherence removal, test cleanup, formal
verification, adversarial tests, and end-to-end delivery. Prefer a small owning
invariant over a symptom patch. Preserve accepted interfaces and identity
boundaries. Do not treat a finite model result as proof of all TypeScript code.

Product base: `0d4389d98cf5044bdd67b07fed82e01c304b6e9c`.
This is an independent hardening change on that exact source. Work takes place
in an isolated child checkout under the attached managed HyperCarrier worktree.
Existing active-checkout edits and live Teams remain untouched.

## Evidence design

1. Model small semantic boundaries in TLA+ and exhaust finite configurations
   with TLC. State bounds, excluded actions, and fairness assumptions.
2. Map model actions to source boundaries and test actual implementation with
   deterministic adversarial traces. A model-to-code mapping is an argument and
   executable evidence, not a machine-checked refinement proof.
3. Make selected faulty model/code variants fail. Preserve minimal production
   regressions for found bugs; do not weaken the oracle to fit implementation.
4. Run a public-tool vertical slice with isolated authority and restart evidence.
   Keep provider/carrier canary evidence separate from deterministic integration.
5. Once all source changes settle, run the full package lane and package checks.

Candidate safety obligations: rejected mutations leave authority unchanged;
success dependencies use accepted Attempt lineage; repair traversal is bounded;
stale Membership/process bindings cannot mutate current work; publication does
not precede authority commit; partial observations do not advance their position.
Exact obligations must be checked against accepted source contracts.

Blocked work may wait indefinitely. Tokens are opaque equality coordinates.
At-least-once delivery does not make external effects exactly once. Budgeted
repair is a safety bound, not an unconditional progress guarantee.

## Ownership and gates

The formal author owns models and their runner, without production edits.
Graph and runtime implementers own disjoint production surfaces.
An independent adversary owns conformance and negative-control tests.
An independent verifier owns test cleanup and end-to-end verification.
Read-only observers assess product scope and systems claims. The primary agent
integrates, resolves findings, and checks the final source and evidence.

Each finding records the broken invariant, minimal trigger, intended behavior,
regression, fix, and evidence. A contract ambiguity remains explicit and does
not authorize a stronger contract. Model faults, code faults, and abstraction
gaps are different findings.

Remove tests only when reviewed behavior is duplicated or a source-shape check
has a stronger behavioral replacement. No deletion by test count, coverage
percentage, or flakiness. Simplify production only when the same contract and
failure behavior remain supported by evidence.

## Completion criteria

- Finite model checks finish; intended negative controls fail for the expected reason.
- Relevant code checks pass; reproduced bugs fail on the base and pass on fixes.
- Independent review finds no unresolved high-impact defect in the changed scope.
- Public-tool/restart evidence and aggregate/package checks are recorded distinctly.
- Remaining limitations and unmodeled contracts are named. No claim of universal
  correctness, complete liveness, or publication follows from this campaign.

## Baseline

Source typecheck passed. The graph control and graph replacement baseline
passed 17 tests across two files. Dependency installation used the child lockfile
with parent workspaces disabled. The checker artifact comes from the official v1.8.0 release URL. Its actual
runtime banner and checksum are recorded in the formal README.

The requested Opus 5.5 consultation uses three rounds of behavior-only prompts.
Automatic review prohibited exporting a source packet, so no repository source
was sent. Local agents bind the resulting method to source. The CLI was updated
in place to 2.1.283 with explicit owner authorization.

## Planning review outcome

Three rounds with `claude-opus-5-5` challenged the method before implementation.
The first draft overclaimed eventual completion, exactly-once effects, token
ordering, and test-volume thresholds. Later rounds removed those claims. The
selected approach uses finite safety models, targeted negative controls,
independent code checks, and a bounded recovery slice. No source review is
attributed to Opus; the local source review remains separate.

Product review adds an operator criterion: each fix must prevent a named visible
failure such as wrong-Worker action, missing Task change, invalid dependency
release, or a false caught-up observation. Check public-tool behavior where the
failure crosses that boundary. Test counts alone do not establish usefulness.

Implementation assignments: `formal_spec` owns formal models/runner;
`graph_hardening` owns graph state; `runtime_hardening` owns runtime/publication;
`formal_adversary` owns independent executable adversarial checks. Separate
product and systems observers review scope and claims. An independent verifier audited
test quality and the public-tool recovery slice.

## Regression lane

`npm run verify:formal` runs the opt-in model lane with a caller-supplied pinned
TLC jar. CI runs the same checker and negative controls in a separate job and
retains logs. The runner verifies the artifact checksum before execution.
Default local unit tests require no Java or download. This lane guards the
model; independent code and integration tests guard its implementation mapping.

## Integrated findings

The change preserves valid prerequisite keys, checks selected persisted graph
integrity rules, validates replay receipts against their committed prefix, and
keeps exact operation coordinates separate from the current graph projection.
Runtime writes hold the exact Membership lease and clear prior process-generation
state. Current replay repairs a missing Task event. Delivery checks committed
graph authority when the derived retirement fence is stale or absent. Corrupt
storage reports authority unavailable; invalid commands retain their refusal.

The test cleanup removes four exact duplicate source assertions and an obsolete
release-wording dependency. The exhaustive runner removes seven retired selectors
and rejects targeted runs with zero passing tests. Three finite
models and independent adversarial tests cover the selected invariants. A
process-recovery test uses actual registered tools and durable state. A snapshot
written by the unchanged base controller reopens with an identical trace and
replay result under the new reader.

Product and systems review found no unresolved high-impact issue after repairs.
The overlap test preserved a late historical event and verified that current
Task observation did not regress. No strict raw-event ordering guarantee was
introduced. Architecture impact: **none**. Existing authorities, public tools,
storage boundaries, and deployment topology remain in place.

Evidence details:

- [Formal bounds and results](../../formal/README.md)
- [Graph integrity and compatibility](../journal/2026-09-26-formal-graph-hardening.md)
- [Runtime, replay, and delivery](../journal/2026-09-26-formal-runtime-hardening.md)
- [Independent adversarial traces](../journal/2026-09-26-formal-adversary.md)
- [Public-tool recovery and test cleanup](../journal/2026-09-26-formal-e2e.md)

The models do not prove TypeScript refinement or unbounded liveness. Delivery
currentness is a check against one atomic snapshot; graph commit can race after
that check. Task CAS still rejects stale mutation. Event repair is at least once,
and it does not backfill every superseded historical event. This campaign does
not provide a live model-provider or terminal-carrier canary and does not publish
or install a release.

## Final verification

Local verification completed on 2026-09-26 with Node 22.22.1.

| Gate | Result |
| --- | --- |
| Exhaustive coverage | 1,072 tests passed across 151 active files. Four existing assertions remain skipped: one opt-in benchmark, two canary-data checks, and one historical Beads marker. The inventory contains 153 files. |
| Typecheck and test-lane closure | Passed. The inventory has 129 fast files and 24 exhaustive-only files. |
| Public package | Packed observation import probe passed; generated dist matches tracked files. |
| Formal lane | Three complete finite searches: 36, 24, and 6,267 distinct states. Nine fault variants failed their intended invariants; three false reachability probes produced witnesses. |
| Runner negative control | A real skipped-only selector was refused after Vitest exited successfully. The active inventory selector passed. |
| Independent review | Product and systems concerns were resolved. Valid base-created persisted state remained readable. |

Exhaustive evidence spans a full run and a continuation. The full run passed
132 files and skipped two opt-in files before an inherited stale prose assertion
failed. After that test-only repair, the remaining 18 files passed. Inspection
then found seven retired scenario selectors that executed no tests. The runner
was repaired and its 14 tests, the nine source-pointer tests, and the active
inventory were rerun. Hash comparison confirmed that production source and
previously passing tests did not change during this continuation. Retired
skipped-only invocations are excluded from the passing count.

The local evidence bundle retains `final-full-pass.log`,
`final-full-continuation.log`, `final-runner-check.log`,
`final-runner-negative.log`, `final-package-verified.log`, and
`final-verification.json`. The last file records the per-file results and final
changed-source hashes. Formal logs are retained separately by the formal runner.
CI configuration was updated; no remote CI execution is claimed.

The optional removal of dormant legacy test helpers was not performed. Automatic
approval review rejected the proposed delete-and-recreate edit as broad coverage
removal. The historical test file remains intact. This does not affect the
corrected active runner or the registered graph recovery test.
