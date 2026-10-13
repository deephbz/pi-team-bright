# Decision 0022: Keep PTB open to multiplexer and agent-harness migration

Date: 2026-10-13
Status: accepted (owner ratified 2026-10-13)
Architecture impact: **none** now. This decision constrains future changes.

## Context

PTB holds two kinds of knowledge. The distinction follows David Deutsch's
account of knowledge and explanation in *The Fabric of Reality*.

1. **Intrinsic knowledge** is PTB's core value. It is new and self-contained:
   teamwork, Task authority, message delivery, and the topology of a lead over
   its Workers. It is the fundamental ontology: what exists in the system,
   what each thing is, how the things collaborate, how users use them, what
   value they give, and which parts are process and which are code or
   framework.
2. **External-dependent knowledge** is constrained by external components:
   their capabilities and API shapes. Examples are terminal multiplexers, the
   Pi agent and its extension API, and macOS or Linux process and liveness
   queries. This knowledge says how to connect the internal ontology to that
   external material.

In Deutsch's terms, intrinsic knowledge must be a hard-to-vary explanation:
no part of it can change without loss of what it explains. Adapter knowledge
is parochial. It is true only for one dependency and one version, and it
changes when that dependency changes.

PTB runs on one multiplexer (Herdr) and one agent harness (Pi). Both will
change. The owner expects a likely move from Herdr to Superlogical Rex, and
from the current Pi agent to a durable Pi setup. The migration path is not
known yet. This decision does not design it.

The rc.1 defects confirm the split. Each came from external-dependent
knowledge that was wrong or in the wrong place: the Herdr `done` agent status,
and the Herdr error envelope on stderr. The intrinsic ontology did not change
to fix either one.

## Decision

The split between the generic layer and adapters is the split between
intrinsic and external-dependent knowledge. Migration replaces adapters and
keeps the ontology.

1. **Migration is expected.** Multiplexers and agent harnesses are
   external-dependent knowledge, so they are replaceable dependencies. No PTB
   contract may assume that Herdr or the current Pi agent is permanent.
2. **Generic layer first.** The generic layer holds the intrinsic knowledge:
   Team, Task, Membership, carrier liveness and delivery semantics. It uses no
   Herdr or Pi types. An adapter maps one multiplexer or one harness to these
   semantics.
3. **Adapters own external facts.** External-dependent knowledge stays in its
   adapter. Only the adapter for a dependency parses that dependency's output
   formats, status names, errors and timing. Core modules consume normalized
   facts. An unknown or unparsed fact becomes `unknown` with its evidence. It
   never authorizes an action.
4. **Low coupling over completeness.** A hard-to-vary ontology stays small,
   and each subsystem keeps a narrow interface and one owner. A fix goes to the
   smallest owning invariant. The goal for a stable release is to fix most or
   all defects in most scenarios. PTB does not spend ten times the complexity
   or time for a one-percent gain. Rare cases fail safe (`unknown`, attention,
   `ask_human`) instead of getting special handling in the ontology.
5. **Fakes follow adapters.** A simulator fake copies parochial knowledge, so
   each fake cites a probe of the real dependency. A new dependency or
   dependency version needs new probes before its adapter is trusted.

## Consequences

- A new multiplexer or harness needs a new adapter, its probes and its fake.
  The generic layer and the Team store do not change for that reason alone.
- A review rejects a change that leaks a Herdr or Pi type, status name or
  error format into the generic layer.
- A change to the generic layer needs a reason from the ontology, not from one
  dependency.
- Some rare scenarios stay unhandled. They fail safe and are recorded as known
  limits.

## Evidence that would reverse it

- The owner commits PTB to one multiplexer and one harness for good.
- A migration shows that the adapter boundary costs more than a direct rewrite.
