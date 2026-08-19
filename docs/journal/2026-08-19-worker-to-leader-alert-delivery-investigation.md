# Worker-to-leader Alert delivery investigation

Date: 2026-08-19
Stage: hardening defect investigation
Status: lifecycle repair implemented, independently reviewed, and verified by aggregate plus real canary
Architecture impact: none for public contracts or deployment; internal Session-delivery lifecycle design changes

## Reported behavior

Leader-to-Worker `alert_send` works. Worker-to-leader `alert_send` appears to
accept and persist the Message, but the leader does not receive its Session
delivery. The operator suspects that leader delivery starts on resume but not
on the initial `team_create` path.

## Evidence inspected so far

Investigation uses published Pi Team Bright `0.17.3` source
`fada68bf65e85bfb105ac03ec1a8d97bec03cff1`.

The Worker tool resolves its exact current Membership and calls
`alertSender.sendAlert` with recipient `team-lead`. Alert authority and storage
are separate from recipient-side Session presentation.

`createPiTeamSessionAdapter` owns one `DirectMessageDelivery` and one
`TaskChangeDelivery` instance for the current Session. Both delivery starters:

- require `teamName`, an eligible Session, and a durable Session file;
- resolve the exact current Membership for `agentName`;
- bind delivery to Membership ID plus Session file;
- start an inbox watcher, a polling fallback, and an immediate scan.

The `session_start` hook starts both deliveries for:

- an admitted or resumed Worker; and
- a lead that resumes an existing Team.

The `modelToolLifecycle.teamCreated` callback changes the current Session into
`team-lead`, stores the Team name and Membership, admits the lead, and starts
only the sync-nudge conductor. It does **not** call
`startDirectMessageDelivery` or `startTaskChangeDelivery`.

This gives a strong code-path explanation for the report: a Team created after
the leader Session has already started has no recipient-side delivery loops.
Worker Alerts can commit to the leader inbox, but no leader watcher or scan is
started until a later resume/reload path. The same gap can affect Task-change
presentation to the initial leader, though leader Task delivery value and
intended semantics still need confirmation.

`DirectMessageDelivery` itself appears symmetric by recipient. Its `start`
method validates the exact binding, installs the inbox watch and interval,
repairs prior Session presentation, and performs an immediate scan. Current
evidence therefore points to lifecycle composition, not Alert acceptance or
the delivery engine.

## Confirmed lifecycle defects

A disposable red registered-extension characterization ran against exact
`0.17.3` source. It started an unbound Session, invoked the real `team_create`
tool, and asserted the two recipient engines. Team creation succeeded, but
`DirectMessageDelivery.start` and `TaskChangeDelivery.start` were each called
zero times. This confirms the reported initial-create gap at the composition
boundary, not only by source inspection.

Systematic transition probes found three related latent defects:

1. A fork can explicitly create a new Team, as the adapter comment intends, but
   `session_start(reason: "fork")` leaves both delivery-eligibility flags false.
   The real `team_create` succeeds while both engines remain stopped.
2. A complete `team_shutdown` deactivates the lead Membership but does not stop
   the leader recipient engines or clear the adapter's Team identity. A red
   create -> reload -> shutdown sequence confirmed no additional engine stop.
3. A complete shutdown leaves the old lead runtime-generation record. Recreating
   the same Team name in the same Session creates a new lead Membership, but
   `teamCreated` cannot admit it because runtime evidence still names the prior
   Membership. The callback ignores that refusal and returns `team_created`.
   A red create -> shutdown -> same-name create sequence confirmed the runtime
   record retained the first Membership ID.

The defects share one cause: Session/Membership binding, recipient delivery,
and Team closure are handled as separate callback fragments rather than one
explicit lifecycle transition. Fixing only the missing start calls would leave
fork creation, full shutdown, and same-name recreation incorrect.

## Repair invariant and test design

The owning invariant is: direct-message and Task-change delivery form one
recipient-delivery pair. The pair is active if and only if this process owns an
exact current Membership/Session binding in an active Team. A binding change
stops the prior pair before replacement. Forked-unbound, refused-admission,
fully stopped Team, and shut-down Session states have no active pair. Explicit
Team creation from a fork establishes a new eligible binding. Partial Team
shutdown retains the leader pair.

Tests must use orthogonal layers rather than repeat engine behavior:

1. A fast lifecycle transition matrix covers unbound initial create, fork
   create, lead resume/reload, Worker first bind/resume/reload, admission
   refusal, complete and partial Team shutdown, Session shutdown, prior active
   delivery, and replacement binding.
2. A paired-actuator matrix covers both starts succeeding, direct start
   failure, and Task start failure. A failed activation must leave no half-live
   pair.
3. Existing engine suites continue to own exact-Membership fencing, immediate
   scan, watch/poll fallback, replay, context staging, replacement, and
   successful-turn acknowledgement. Adapter tests must not duplicate these.
4. A registered-extension vertical test invokes the real `team_create` callback
   and proves initial leader activation. A real Pi Team canary then proves a
   Worker-authored Alert is accepted, persisted, and presented in the leader's
   exact Session.
5. A shutdown/recreation sequence proves full closure stops delivery, clears
   adapter identity, ends the old lead runtime generation, and admits a new
   Membership for the same Team name. Partial shutdown proves the opposite
   transition.

A small internal recipient-delivery lifecycle module should own the pair with a
minimal `activate`, `deactivate`, `observeContext`, and successful-turn commit
surface. The Pi Session adapter should map lifecycle events to that module and
retain Pi hook, identity-discovery, admission, footer, and terminal concerns.
No public tool or storage schema needs to change.

## Historical cause and subsystem-boundary assessment

The defect predates the 2026-08-10 semantic-hardening subsystem split. Before
model-tool cutover, the legacy `team_create` executor explicitly admitted the
lead, set adapter identity, started both recipient engines, and refreshed the
footer. Commit `7ccad1d` (`feat: revamp Pi Team tool projections`, 2026-08-03)
introduced the model-tool `teamCreated` lifecycle callback. That callback
admitted and bound the lead but did not carry forward either delivery start.
The accepted first model-tool journey tested `team_create -> ensure_worker ->
team_sync`; its real Pi canary had no live Worker carrier and did not exercise a
Worker-to-leader Alert. The migration therefore preserved Team creation while
losing recipient activation.

The later subsystem work did not create this bug. It intentionally preserved
observed behavior while improving ownership and dependency direction:

- `57c8e02` moved admission, exact Membership leases, runtime generation, and
  Session binding into `TeamSessionLifecycleService`.
- `1686ac1` characterized resumed Worker delivery, resumed lead delivery,
  refusal, Session shutdown, title timing, and generic callback ordering.
- `ab7f591` extracted the mutable Pi hook and identity boundary into
  `pi-team-session-adapter.ts` without changing its choreography.
- `e9f8dad` isolated Alert acceptance, inbox delivery, exact-Membership
  presentation, and publication behind Alert-owned ports.
- `6f1d0f5` closed Pi Session Team-query and Task-delivery Membership seams.

The accepted audit explicitly left hook order, delivery starts, footer, and
nudge actuation in the Pi Session adapter. It also recorded that the private
`teamCreated` path proved wiring only, not hook execution. The characterization
suite covered resumed states but omitted the unbound -> created state. Generic
callback tests used a mock callback, so they proved commit/callback order and
failure mapping without proving the real callback's effects.

This was a blind spot for four reasons:

1. The subsystem split optimized semantic authority and static dependency
   direction. It did not model the cross-subsystem runtime transition graph.
2. Delivery meaning was well isolated, but delivery *lifecycle ownership* was
   unnamed. Two nullable engines and two eligibility booleans remained callback
   fragments in the adapter.
3. The refactor was behavior-preserving. Its outside-in tests sampled known
   paths instead of traversing all role, Session-origin, admission, and Team
   lifecycle combinations.
4. The initial model-tool journey and canaries ended at Team observation. They
   did not include a live Worker-to-leader Alert, full shutdown followed by
   reuse, or Team creation from a fork.

The five-subsystem split remains sound. Recipient activation is not a sixth
authority and should not move into Alert or Task authority. The needed refactor
is local to the integration seam: name the paired recipient-delivery lifecycle
inside Pi Session adaptation, then let Team authority end the exact lead runtime
generation on successful full shutdown. This makes lifecycle composition
explicit without reopening the subsystem architecture.

## Accepted operating policy

The owner confirmed that successful full Team shutdown immediately unbinds all
Session delivery and adapter identity. Teams are normally long-lived and align
with a project or durable coordination boundary. Workers can be reusable for a
standing semantic area or ephemeral for bounded work. Operators must not create
or shut down a Team for each Task. The concise operating rule is now in
`skills/pi-team-bright/SKILL.md`.

## Implemented repair

One internal `RecipientDeliveryLifecycle` now owns the direct-Message and
Task-change engines as a pair. Initial Team creation, explicit creation from a
fork, lead resume, and Worker binding activate it. Admission refusal, Session
shutdown, and successful full Team shutdown deactivate it. Partial shutdown
retains it. Replacement and failed activation compensate the prior or partial
pair before another binding can become active.

Team shutdown now reads its unfinished-Task snapshot before any carrier or
Membership mutation. Successful full shutdown deletes only the exact lead
runtime generation, restores it if Membership deactivation fails, and refuses
to deactivate around malformed or foreign runtime evidence. The adapter clears
its Team identity, footer, nudge monitor, and recipient pair only after the
service returns full success.

The systematic traversal also found a pre-existing asynchronous stop race in
`DirectMessageDelivery`. Its generation fence now covers binding validation,
acknowledgement recovery, inbox scans, stop, and restart. An old read cannot send
a Message, block a new scan, or clear the new generation's scan promise.

The final test design keeps separate axes: the small pair state machine owns
transition and compensation tests; engine suites own watch, poll, scan, replay,
acknowledgement, and generation races; registered-extension tests own Pi hook
mapping; Team lifecycle tests own runtime cleanup and mutation ordering. Test
harnesses now emit the real `session_start` event before successful
`team_create`, rather than depending on an impossible context-free callback.

Independent product, systems, and test reviews accepted the final lifecycle and
focused deterministic evidence. The exact candidate then passed `test:full`,
the 144-file lane-closure check, and package verification.

A fresh process loaded the exact candidate extension and created a disposable
Team with one Worker. The Worker accepted Alert receipt
`alert_bef8ce11-2fdc-4434-b286-ad3ac2a271c5`; durable inbox record
`message_b16550f6-1c02-4466-8f04-c4fb64083d96` retained the canary Message. The
newly created leader Session presented the exact content
`CANARY-V0174-1318`, not only a Worker report. The Worker Task reached
`goal_achieved`, the Worker stopped, and full Team shutdown returned success
with zero unfinished Tasks. This supplies the missing vertical proof from Alert
acceptance through durable storage to exact leader Session presentation.

## Coordination preflight evidence

Before the authorized repair Team was created, the required Node proxy-environment
check verified that `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` were each set.
No proxy values are recorded.

## Coordination blocker evidence

Short stable Worker names were retried without changing Herdr or the launch
contract. Each prepared Membership was compensated because Herdr rejected the
Team-qualified agent name with `agent_name_not_found` and reported that it no
longer owned the target terminal. The failed names were
`recipient-delivery-lifecycle-m`, `recipient-delivery-lifecycle-t`,
`recipient-delivery-lifecycle-i`, `recipient-delivery-lifecycle-p`,
`recipient-delivery-lifecycle-s`, and `recipient-delivery-lifecycle-q`.
No Worker-authored Task event was observed, so the existing unstarted Task graph
was intentionally left unchanged and no production work began.

## Coordination shutdown result

The blocked Team shut down successfully. No current Workers were stopped; its
unfinished Tasks were retained.

## Release coordination state

Pi Team Bright `0.17.3`, HyperCarrier composition commit
`b399eeb7eb9d772737f64b804af1eb110bf5960c`, and HyperCarrier Alpha public
commit `6b2d4fda5d03cc5d59f26d14e26fedaef2f79443` were already published before
the operator requested deferral. Do not undo or rewrite them without an
explicit decision.

Pi Team Bright receipt PR #13 is recorded on current `main` as `7a2c158` before
the `0.17.4` candidate was prepared. HyperCarrier receipt PR #24 remains separate from this package
repair. The local `0.17.4` candidate must still pass its aggregate, real canary,
single-commit PR, hosted publication, and downstream HyperCarrier adoption.
