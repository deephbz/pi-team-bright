# PiTeams product and scope

Status: maintained current context.

PiTeams turns one Pi session into the lead of a coordinated software team. It
manages team membership, teammate terminal surfaces, transient inboxes, runtime
health, and a shared Task workflow.

## Supported collaboration boundary

PiTeams communication is limited to direct messages and broadcasts among
current members of one Team. The Team lead and teammates can coordinate within
that boundary, and the lead owns Team topology, lifecycle, and template
mutations.

Leader-to-leader messaging across Teams and communication between agents
outside a Team are out of scope. PiTeams does not provide a cross-Team roster,
a general-purpose agent directory, a communication broker, or a generic work
management system.

A Team is also not an assertion that every process with a matching name is a
member. Current Membership and exact Pi Session binding determine who may act
in a Team.

## Product promises

PiTeams provides a small coordination surface that keeps durable authority and
live delivery separate:

- Teams can create, launch, recover, and shut down teammates through supported
  terminal adapters.
- Team members can create and coordinate shared Tasks through one configured
  Beads authority.
- Direct Messages and Task changes reach the exact recipient Session through
  native custom delivery after their owning authority accepts them.
- Runtime health, Task state, inbox state, and terminal state remain distinct
  observations rather than one synthesized status.

Read [the domain model](domain.md) for the terms behind these promises and
[the operating guide](operations.md) to use them. The complete callable surface
is [the reference](../reference.md).

## Non-goals

PiTeams does not make a Task system out of terminal activity, make a Message a
Task transition, infer membership from a pane or process, or treat a delivery
receipt as proof that work began. It also does not support mixed live versions
inside one Team; upgrade a Team as one epoch.

The scope boundary is an accepted commitment in
[decision 0002](../decisions/0002-team-scoped-communication.md).
