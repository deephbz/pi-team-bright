# PiTeams domain

Status: maintained current context.

These terms describe the smallest vocabulary needed to use PiTeams safely.
They are product concepts, not a claim that every implementation detail is a
public entity.

## Team and Membership

A **Team** is one named coordination boundary. It has a current roster, a lead,
and one configured Task authority.

A **Membership** is one generation of a named role inside a Team. It is bound to
one durable Pi Session after first startup. Replacing a teammate creates a new
Membership; an old process, pane, or same-name Session does not inherit the new
Membership.

The **team lead** is the Membership allowed to change Team topology, lifecycle,
and templates. A **teammate** is a current non-lead Membership that retains the
Task and Communication tools.

## Session, runtime, and terminal surface

A **Pi Session** is the durable conversation identity used to bind a current
Membership. Resuming that Session can restore the Membership. A fork is a new
Session and does not inherit mutable Team state.

A **runtime observation** records process liveness, heartbeat, or startup
information. It is not Task progress or proof of model readiness. A **terminal
surface** is a pane or window managed through a supported adapter; it is an
ephemeral location, not Membership identity.

## Task

A **Task** is the only PiTeams work aggregate. After migration or Team
creation, Beads is its sole runtime authority. A Task has title, description,
optional design, status, assignee, append-only notes, typed relations, and an
authority version. The public statuses are `open`, `in_progress`, `blocked`,
and `closed`.

Task intent and review instructions are prose. The Task authority owns durable
state, history, graph validation, and versioned updates. A Task delivery is not
a second Task authority.

## Communication and delivery

A **Message** is a direct, transient coordination record addressed to one
current Membership. A **broadcast** creates one Message per current recipient
in the same Team. Messages are not Tasks and do not change Task state.

A **delivery record** tracks an attempt to make an accepted Message or
assignee-addressed Task change available to the exact recipient Session.
Delivery is at least once until successful-turn acknowledgement. Acceptance,
presentation, observation, and acknowledgement are separate facts.

See [the system model](system.md) for authority and recovery boundaries and
[decision 0002](../decisions/0002-team-scoped-communication.md) for the
Team-scoped communication rule.
