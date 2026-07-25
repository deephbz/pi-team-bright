# Bind a Team to one direct terminal carrier

Status: accepted

Date: 2026-07-25

Kind: lifecycle / terminal-backend contract

## Context

A Team already persisted one terminal backend and backend-qualified targets, but a
Pi process could inherit the outer backend's identity while actually running in
an inner terminal multiplexer. This made a Herdr-targeted Team appear valid
while its worker processes were owned by independent tmux servers. The durable
Team target, runtime carrier, and later lifecycle operations could then disagree.

The agent's intent is to ensure a Worker. Choosing a terminal manager, creating
its pane, and establishing its process carrier are extension responsibilities.
They are not agent parameters or a user-operated fallback procedure.

## Decision

- A Team epoch binds one terminal backend and every current Membership target is
  qualified by that backend.
- A Worker must be directly carried by that backend. A nested terminal carrier
  is not a valid implementation detail of a Worker launch.
- Adapters may distinguish a visible surface from direct-carrier evidence. When
  an adapter can observe nesting, it must report it; startup refuses the
  Membership rather than accepting inherited outer identity.
- A launcher-originated nested Worker self-terminates after refusal. A resumed
  operator Session stays open but remains unbound.
- Worker creation, predefined-Team creation, resume, compensation, and stop
  continue to resolve their terminal through the Team epoch rather than through
  caller-supplied terminal parameters or ambient fallback dispatch.

## Consequences

A Herdr Team cannot use a nested tmux process as an isolation layer. Existing
mixed-carrier epochs must be stopped and recreated. The exact executable
contract is `TerminalAdapter.isDirectCarrier`, `currentTerminalForTeam`,
`placeSessionTerminal`, `admitTeamSession`, and their contract tests.
