# Pi Team Bright semantic hardening and subsystem audit handoff

Date: 2026-08-09
Status: scope and target decomposition agreed interactively; no implementation has started
Lifecycle stage: consolidation and hardening of the existing product contract
Architecture impact of this handoff: **none**
Maintained Project artifact: [`../projects/semantic-hardening/context.md`](../projects/semantic-hardening/context.md)

## Purpose

Improve Pi Team Bright's internal architecture without changing its public
surface and without changing observable behavior by default. First make current
functional and non-functional behavior executable and investigable. Then
refactor toward the agreed subsystem boundaries while the characterization
suite proves equivalence.

A small behavior change is an explicit exception, never an incidental part of a
refactor. It requires evidence that the current behavior is unsafe,
contradictory, misleading, obsolete, or materially worse than a clear
alternative. The owner must accept the new behavior and its compatibility
consequence before implementation.

One Task-first Team should own this work. The exact calling Session leads it
directly; only the watchdog runs as a separate Pi agent. This document supplies
durable context, not an executable assignment. The leader must create assigned
Tasks with explicit outcomes and verification signals before work starts.

## Progress and agreed direction

The interactive review has completed these shaping steps:

- The package's maintained docs, production code, tests, manifests, and
  automation were reviewed as explicit source bundles. A Million Eyes review
  froze 184 files and ran eight bounded lenses. Six submissions validated; one
  terminal lens made no submission, and one reachability submission failed its
  result schema. Reviewer output is discovery evidence, not proof or a silent
  source of product truth.
- The first inventory described eight current implementation areas. Review with
  the owner showed that it promoted delivery mechanics, Worker resource
  projection, and the public Membership projector into peer subsystems.
- The owner accepted the five-part target decomposition below. This is a target
  for refactoring, not a claim that current directories or dependencies already
  implement it.
- The owner confirmed that tests should first characterize current behavior in
  depth, including timing, triggers, delivery, concurrency, recovery, and
  projection behavior. Accepted tests then become the executable specification.
- No production code, public schema, public operation, or behavior has changed.

## Desired outcome

Deliver a small, coherent, and investigable Pi Team Bright whose:

- product requirements and motivations are explicit;
- domain distinctions and authority boundaries are exact;
- public operations and schemas remain stable;
- agent, human/TUI, and machine projections preserve the same underlying truth;
- runtime, timing, trigger, delivery, recovery, concurrency, and compatibility
  behavior is specified;
- subsystem responsibilities and dependency directions match the agreed target;
- current observable behavior has characterization coverage;
- intended and compatibility-required behavior has complete executable
  conformance coverage;
- unintended behavior is changed only through an explicit, evidence-backed
  owner decision;
- internal implementations can be optimized, simplified, moved, or replaced
  without hidden effects elsewhere.

The result is not a larger architecture description or a higher test count. The
result is conceptual integrity with executable proof.

## Central questions

The Team must answer these questions before treating current code as the spec:

1. What operator and agent situations does Pi Team Bright intentionally serve?
2. Which nouns, actions, relations, states, and identities are irreducible?
3. Which authority owns each durable fact and transition?
4. Which behaviors are requirements, design choices, compatibility obligations,
   implementation details, historical accidents, or unresolved questions?
5. Why does each public operation exist, and what invariant does it protect?
6. Which failures must refuse without state change, and which partial outcomes
   are valid semantic results?
7. What must remain reconstructable after restart, stale delivery, concurrent
   mutation, or mixed historical records?
8. Which records are authoritative, and how do agent, human/TUI, and machine
   projections derive from them?
9. Where does the current code couple concepts that should vary independently?
10. What evidence would justify retaining, changing, or removing each surprising
    behavior?

## Required audit stance

Treat the current implementation, documentation, tests, released packages,
runtime records, and observed workflows as separate evidence sources. None is
automatically complete or correct.

Start with black-box characterization of the current released behavior. Preserve
exact receipts for surprising and compatibility-sensitive cases. Then classify
each behavior as:

- intended and required;
- intended but underspecified;
- compatibility obligation;
- implementation detail with no public meaning;
- accidental behavior that should be removed;
- defect;
- unknown pending owner judgment.

Do not call behavior accidental only because it is absent from current prose.
Do not promote behavior into the intended contract only because a test currently
asserts it.

Preservation is the default for all observable behavior, including undocumented
error results, ordering, timing bounds, triggers, delivery effects, recovery,
files or protocols used by supported consumers, and terminal placement. Exact
text or timing is contractual only when evidence shows reliance or the product
already promises it.

A proposed behavior change requires a reliance check and explicit owner
judgment. Keep the old characterization evidence, state why the replacement is
better, define the compatibility consequence, and replace the old test with a
normative test for the accepted behavior. Do not hide a behavior change inside
renaming, code movement, optimization, or cleanup.

## Agreed target decomposition

Refactor toward five cohesive subsystems. These are semantic and change
boundaries, not required services, processes, directories, or classes.

1. **Team authority and Role realization** owns Team epochs, logical Workers,
   Membership generations, Role assignment, exact Session binding, effective
   Worker/leader runtime configuration, process and terminal carriers, recovery,
   stop/shutdown, and Team compatibility. Keep authoritative Role assignment
   distinct from derived effective model, prompt, tool, trust, and resource
   configuration.
2. **Task authority** owns canonical Task meaning, assignment, state, evidence,
   relations, versions, concurrency, replay, Task compatibility, and Task
   migration. Beads is its current authority adapter, not a peer subsystem.
3. **Alert authority** owns exceptional clarification, attention, announcement,
   targeting, acceptance, fan-out, and the invariant that Alerts never mutate
   Task state. Team Membership authorizes an Alert but does not define its
   meaning.
4. **Coordination observation** owns event projection, snapshots, updates,
   waits, `team_sync`, current-authority hydration, and acknowledged branch
   position. It observes Team, Task, and Alert authorities without replacing
   them.
5. **Trio-facing interface and projections** exposes the same authoritative
   semantic result to three audiences: complete machine records and receipts,
   concise agent/model JSON, and human/TUI views. Audience projections may
   differ in shape but must not differ in meaning.

Exact-Session delivery is not a sixth semantic subsystem. Task-delivery intent,
evidence, compatibility, and recovery remain with Task authority. Alert-
delivery intent and evidence remain with Alert authority. Shared Pi Session
actuation can implement steer, context observation, acknowledgement, retry, and
resume behind a narrow adapter, but it owns no Task, Alert, or Team truth.

Terminal adapters, locks, atomic writes, paths, tracing, diagnostics, hooks,
package automation, and release checks are support mechanisms. Assign each rule
to the subsystem whose invariant it protects. Do not create technical
subsystems from shared implementation patterns alone.

### Strictly additive Membership observation component

`@hypercarrier/pi-team-bright/observation` remains a strict public API and a
machine-facing projection of Team authority. HyperCarrier Timeline uses it to
read privacy-filtered recorded Membership evidence without reading Pi Team
Bright's private storage. It does not report Task meaning, OS liveness, work
progress, prompts, models, terminal content, argv, or environment.

Keep this projector additive and outside the five core subsystems. It may read
stable Team-authority records through a narrow projection boundary. Core Team,
Task, Alert, coordination, and trio-projection behavior must not depend on this
consumer component. Preserve its versioned schema, deadline, abort, privacy,
and mixed-record behavior unless a separate public compatibility decision
changes them.

For each accepted subsystem boundary, make clear:

- the responsibility and motivation;
- the facts and transitions it owns;
- its public and internal contracts;
- what it must not own;
- its dependencies and allowed dependency direction;
- its trust, concurrency, timing, recovery, and compatibility boundary;
- its external verification signals;
- how agent, machine, and human projections trace back to its records.

Refactor one owning boundary at a time. Prefer the smallest moves, extractions,
deletions, and dependency inversions that make these boundaries true. Do not use
the target decomposition as permission for a speculative rewrite.

## Specification standard

Build one normative contract inventory. Give each intended rule a stable
identifier and one authoritative home.

Each rule must state:

- the motivating situation;
- the required behavior;
- preconditions and authority;
- successful and refused outcomes;
- state changes and prohibited state changes;
- concurrency, retry, and recovery meaning when relevant;
- compatibility scope;
- the external signal that verifies the rule.

Once a contract stabilizes, exact schemas and transitions belong in types,
public registrations, implementations, and tests. Documents retain intent,
rationale, compatibility decisions, and pointers. Do not leave a second copy of
an executable specification in prose.

## Adversarial review standard

Review every accepted contract as if a caller, stale process, partial failure,
or future maintainer will violate its assumptions.

The adversarial review must challenge at least:

- identity and authority confusion;
- invalid role or lifecycle actions;
- stale versions and conflicting writers;
- exact replay and changed replay;
- partial commit, publication, delivery, or observation;
- process death and restart at each durable boundary;
- missing, malformed, oversized, stale, and mixed-version records;
- duplicate, reordered, delayed, or absent events;
- authority unavailability and timeout ambiguity;
- projection disagreement;
- cancellation and interruption;
- external writers and compatibility-sensitive historical data;
- combinations of individually valid operations that produce an invalid whole.

An independent reviewer must try to disprove each subsystem contract. Review
should target public semantics and cross-boundary composition, not only local
implementation style.

## Test and coverage standard

Use tests as the executable account of behavior. Add as many focused tests as
needed to cover every meaningful functional and non-functional rule, but do not
use test count or line coverage as the correctness claim.

Work in two explicit test states:

1. **Characterization tests** record what the released package and exact current
   source do, including surprising or undesirable behavior. They protect the
   refactor baseline but do not declare that behavior desirable forever.
2. **Normative conformance tests** encode behavior accepted as intended or
   compatibility-required. After classification, promote a characterization
   test, retain it as compatibility evidence, or replace it through an explicit
   behavior-change decision.

Maintain a machine-checkable map from each behavior or normative rule to:

- its positive behavior test;
- refusal and no-state-change tests;
- role, lifecycle, state, and meaningful permutation tests;
- trigger and ordering tests;
- timing, timeout, cancellation, and interruption tests;
- delivery, acknowledgement, retry, and duplicate tests;
- restart, recovery, concurrency, and mixed-record tests;
- trio-projection parity and privacy tests;
- one external or runtime anchor when an in-memory test cannot prove the claim.

Prefer deterministic clocks, barriers, injected events, and fault seams over
wall-clock sleeps. Test through published operations for public behavior. Keep
focused internal tests for stable local invariants. Use real process, terminal,
Beads, package, and Pi runtime checks only when an in-memory test cannot expose
the risk.

Permutation testing must cover meaningful semantic dimensions, not generate a
large Cartesian product without an oracle. Pairwise or model-based generation
is useful only when every generated case has a clear expected outcome.

It is valid to break a characterization test deliberately after the owner
accepts better behavior. Preserve the old observation as historical evidence,
change or retire the old test in the same bounded change, and add the normative
test for the replacement. Never weaken a test only to make a refactor pass.

## Behavior-change exception standard

For each behavior proposed for change or removal:

1. preserve the observed behavior, exact source, and test as evidence;
2. identify its owning subsystem, implementation path, and all trio projections;
3. show why preserving it is worse than the proposed replacement;
4. check released-package, historical-record, and external-consumer reliance;
5. state the public-surface and compatibility effect;
6. record the owner decision and reversal evidence;
7. add the replacement's positive, refusal, and no-state-change tests;
8. change or retire the old characterization test deliberately;
9. remove dead behavior and dead compatibility paths together;
10. prove that supported journeys and records still work.

Do not retain ambiguous fallback behavior merely because removal is risky, and
do not remove it merely because a cleaner implementation is available. Make the
tradeoff explicit, then choose preservation, optimization, migration, refusal,
or removal.

## Required artifacts

The Team must leave these durable results:

- a problem artifact stating scope, current evidence, and unresolved decisions;
- a current semantic contract and glossary;
- current and target subsystem responsibility and dependency maps;
- a behavior inventory covering functional and non-functional dimensions;
- a normative rule inventory with stable identifiers;
- a machine-checkable characterization and conformance map;
- adversarial findings with classifications and dispositions;
- compatibility findings and any required migration decisions;
- focused runtime receipts for claims that deterministic tests cannot prove;
- before/after benchmark receipts for accepted optimizations;
- a behavior-change record for each deliberately replaced characterization;
- a final assessment stating what changed, what remains uncertain, and what
  evidence would reverse the accepted design.

Keep raw observations and failed attempts in the journal. Keep only decisions
still in force, current status, blockers, and next steps in the evergreen
context. Update canonical architecture source only when accepted responsibility,
authority, dependency, data flow, persistence, trust, or deployment boundaries
change.

## Non-goals

This work must not:

- add a major new product capability;
- change public operation names, parameter schemas, result schemas, package
  exports, or the observation protocol as part of the refactor;
- change observable behavior without an explicit behavior-change exception;
- turn current directories into architecture by renaming them;
- create persistence, recovery, compatibility, delivery, terminal, locking, or
  adapter subsystems from shared technical mechanisms;
- merge Task and Alert authority because both can reach a Pi Session;
- make the additive Membership projector a dependency of core coordination;
- add generic framework machinery without a demonstrated invariant;
- treat code coverage, snapshot volume, or test count as product correctness;
- duplicate executable schemas or state machines in documentation;
- run a speculative whole-system rewrite.

Internal implementations may be optimized, simplified, deleted, moved, or
replaced. They must preserve public results, state transitions, ordering,
triggers, delivery meaning, recovery, security, and compatibility unless a
behavior-change exception says otherwise. A performance optimization must show
a measured improvement and no material regression on other accepted qualities.

## Recommended next steps

1. **Freeze the baseline.** Record the exact released package, source revision,
   supported Pi/Node/Beads versions, public tool catalog, package exports,
   observation schema, settings, and terminal backends under test.
2. **Build the behavior inventory.** For each of the five subsystems, enumerate
   operations by actor Role, pre-state, trigger, timing, successful/refused/
   partial outcome, state change or prohibited change, projection, delivery,
   recovery, compatibility, and external verification signal.
3. **Characterize outside-in first.** Add tests through published Pi tools,
   package exports, commands, and runtime hooks before increasing internal unit
   coverage. Compare the released package with the exact working tree for
   compatibility-sensitive journeys.
4. **Create deterministic fault seams.** Control clocks, event publication,
   Task-authority responses, Session presentation, successful-turn
   acknowledgement, process death, terminal stop evidence, and restart. Use
   real runtime receipts only for risks that these seams cannot prove.
5. **Classify every characterization.** Mark it intended,
   compatibility-required, implementation-only, unintended, defective, or
   unresolved. Do this before using it as a permanent refactor gate.
6. **Draw current and target dependencies.** Identify cycles and misplaced
   ownership. Define narrow ports only where two real implementations vary or
   where a fault boundary needs deterministic control.
7. **Refactor one seam at a time.** Start with dependency direction and authority
   isolation, not directory names. Keep the characterization suite green after
   each move. Run only focused tests during each iteration.
8. **Optimize behind stable contracts.** Measure Task amplification, lock wait,
   event-to-observation latency, trigger-to-presentation latency, restart cost,
   and trio-projection size. Keep optimizations only when the relevant behavior
   and benchmark anchors pass together.
9. **Separate intentional behavior changes.** Give each exception its own Task,
   evidence, owner decision, compatibility assessment, and test replacement.
   Do not combine it with a structural refactor.
10. **Verify the exact final tree.** After all implementation Tasks close, run
    focused real-runtime anchors, package verification, and one aggregate release
    lane. Then update the evergreen context and architecture source only if
    accepted depicted responsibilities or dependencies changed.

## Completion criteria

The audit and refactor are complete only when:

1. the owner can explain the five subsystems without implementation names;
2. source dependencies implement the accepted ownership and direction;
3. every current public and compatibility-sensitive behavior has an explicit
   classification and characterization test or external anchor;
4. every accepted normative rule maps to executable evidence;
5. meaningful timing, trigger, delivery, adversarial, and permutation cases
   pass against the same contract;
6. agent, machine, human/TUI, and runtime projections cannot silently disagree;
7. every changed characterization has an explicit behavior decision and
   replacement test;
8. restart, concurrency, partial-failure, and historical-record behavior is
   proven where applicable;
9. the public tool and package surfaces remain unchanged;
10. the additive Membership observation API remains strict and core-independent;
11. the final exact source tree passes proportional focused checks and one
    aggregate release lane;
12. the evergreen context and canonical architecture source match the accepted
    result, with remaining uncertainty and reversal evidence stated plainly.

A clean decomposition with incomplete behavioral coverage does not satisfy this
handoff. A large test suite without classification and external verification
also does not satisfy it.
