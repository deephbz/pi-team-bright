# Decision 0022: Keep PTB open to multiplexer and agent-harness migration

Date: 2026-10-13
Status: proposed (the owner ratifies)
Architecture impact: **none** now. This decision constrains future changes.

## Context

PTB runs on one terminal multiplexer (Herdr) and one agent harness (Pi). Both
will change. The owner expects a likely move from Herdr to Superlogical Rex,
and from the current Pi agent to a durable Pi setup. The migration path is not
known yet. This decision does not design it.

PTB also depends on external state that it does not control: multiplexer
panes, harness processes and Sessions, and the user's environment. The rc.1
defects came from adapter assumptions about that state: the Herdr `done` agent
status, and the Herdr error envelope on stderr.

## Decision

1. **Migration is expected.** The multiplexer and the agent harness are
   replaceable dependencies. No PTB contract may assume that Herdr or the
   current Pi agent is permanent.
2. **Generic layer first.** Team, Task, Membership, carrier liveness and
   delivery semantics do not use Herdr or Pi types. An adapter maps one
   multiplexer or one harness to these semantics.
3. **Adapters own external facts.** Only the adapter for a dependency parses
   its output formats, status names, errors and timing. Core modules consume
   normalized facts. An unknown or unparsed fact becomes `unknown` with its
   evidence. It never authorizes an action.
4. **Low coupling over completeness.** Each subsystem keeps a narrow interface
   and one owner. A fix goes to the smallest owning invariant. The goal for a
   stable release is to fix most or all defects in most scenarios. PTB does not
   spend ten times the complexity or time for a one-percent gain. Rare cases
   fail safe (`unknown`, attention, `ask_human`) instead of getting special
   handling.
5. **Fakes follow adapters.** Each simulator fake cites a probe of the real
   dependency. A new dependency or dependency version needs new probes before
   its adapter is trusted.

## Consequences

- A new multiplexer or harness needs a new adapter, its probes and its fake.
  The generic layer and the Team store do not change for that reason alone.
- A review rejects a change that leaks a Herdr or Pi type, status name or
  error format into the generic layer.
- Some rare scenarios stay unhandled. They fail safe and are recorded as known
  limits.

## Evidence that would reverse it

- The owner commits PTB to one multiplexer and one harness for good.
- A migration shows that the adapter boundary costs more than a direct rewrite.
