# 0019: Compact identity labels and HUD projection

Date: 2026-10-10
Status: accepted for the assigned implementation.

## Intent

Keep Team identity visible without repeating the Team name and a message clock
in every footer. Labels identify a presentation surface. Exact Session and
Membership binding remain the authority for the identity slot.

## Decision

New Team creation applies the global date-prefix policy once and returns the
canonical name. Resume leaves existing names unchanged. Leader pane labels
and terminal titles use `leader-<team>`; Worker labels use `<worker>`.

A bound Worker Session name is definitional: `<team>/<worker>`. PTB enforces
it on exact-binding sync only when it differs. The equality check prevents a
Session-name event loop. Leader and unbound Session names belong to the human
or Rarebit. PTB does not choose or change them, including names assigned by an
earlier PTB version. Naming a Worker at startup binding prevents Rarebit's
existing auto-title path from running; no Rarebit coupling is required.
Degraded path: a failed naming call does not stop delivery. Until a later sync
succeeds, owner input to that unnamed Worker can still trigger Rarebit
auto-title, and the next successful sync replaces the title. A manual Rarebit
title in a Worker is applied and then replaced the same way. If such Workers
appear in practice, extend Rarebit's automatic policy seam to titles.

On title release, PTB re-emits only the exact current Session name so Pi
restores its native title. This changes no name value or ownership.

PTB publishes the `team.member` identity slot through `pi.events`. The
[inline wire contract](../../src/utils/team-hud.ts) keeps this public package
independent from the optional composer package. Slot values carry semantic
identity without styling. Replay rechecks the exact binding. Session clear
retracts the slot and invalidates pending projection work. Identity has no
age-based expiry because idle time does not invalidate a binding.

The composer announces `tui-footer` presence before installing its footer.
PTB removes its wrapper synchronously during that announcement. PTB makes no
footer writes while the composer owns the surface. The composer clears its
footer before announcing absence; PTB can then restore its role-only fallback.
The [footer projection](../../src/utils/team-footer.ts) and its tests own
this behavior.

## Boundaries and reversal

This adds an in-process presentation flow. It adds no store, authority,
transport, process, or dependency on a composer package. The parent integration
owns its architecture context. Real-Pi composition evidence remains pending.

Revisit the handshake if Pi adds an ownership-aware footer API. Revisit the
transport only when a composer must run in another process. Keep the semantic
slot independent from either change.
