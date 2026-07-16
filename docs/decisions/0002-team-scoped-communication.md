# Keep communication inside one Team

Status: accepted

Date: 2026-07-16

Kind: product scope

## Context

PiTeams exposes direct Messages and broadcasts through a Team-scoped tool
surface. The implementation authorizes the caller against the requested Team,
resolves direct recipients from that Team's current roster, and enumerates that
same roster for broadcasts. The product boundary must state this behavior
rather than implying a broader agent-messaging system.

## Decision

PiTeams communication is limited to direct messages and broadcasts among
current members of one Team.

Leader-to-leader messaging across Teams and communication between agents
outside a Team are out of scope. PiTeams does not provide a cross-Team roster,
agent directory, routing layer, or universal communication channel.

## Consequences

A caller must coordinate cross-Team or no-Team communication through another
system. PiTeams retains a small, enforceable roster boundary and does not
invent membership or contact identity outside the current Team.

## Reversal conditions

Revisit only when a concrete collaboration workflow requires communication
beyond one Team and supplies a durable identity, authorization, delivery, and
failure contract that can be implemented without weakening current Membership
binding.

## Evidence

- [Product scope](../current/product.md)
- [Operating workflow](../current/operations.md#communicate-inside-the-team)
- [`sendPlainMessage`](../../src/utils/messaging.ts)
- [`broadcastMessage`](../../src/utils/messaging.ts)
- [Tool reference](../reference.md#communication)
