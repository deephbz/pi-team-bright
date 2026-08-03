# Pi Team Bright agent entry point

Pi Team Bright is in **hardening** for its Task-first coordination surface. Start from
the maintained [evergreen context](docs/current/README.md); consult the
[journal](docs/journal/) only for historical rationale or evidence.

## Work protocol

- Product and systems observers are optional. Do not create them for routine or
  major changes unless the owner or an assigned Task explicitly requests them.
- An assigned Task is the only executable work contract. Put goals,
  constraints, review requests, and acceptance criteria in Task prose.
- Reuse stable Workers. Memberships, Pi Sessions, processes, and terminal
  surfaces are replaceable carriers, not work identity.
- Observe normal progress through cursor-based `team_sync`; don't sleep, poll
  runtime state, inspect panes, or read an inbox as a work loop.
- Use typed Alerts only for exceptional clarification, attention, or
  announcements. They never mutate Task state.
- Workers start accepted Tasks, self-verify, then close with evidence or block
  with blocker evidence and a next action.
- Team topology and lifecycle mutations are lead-only. Stop Workers only after
  nonterminal assigned Tasks are resolved; reconcile before Team shutdown.

The executable tool schemas shown by Pi are authoritative. The
[Pi Team Bright skill](skills/pi-team-bright/SKILL.md) contains the concise operating
procedure; the [contract source map](docs/reference.md) routes to schemas,
types, implementations, and tests.

## Documentation mutation semantics

- `docs/current/README.md` is curated working context: stage, decisions still
  in force, current status, constraints, blockers, and next steps. Remove
  solved or superseded material from it.
- `docs/decisions/` preserves durable rationale and explicit supersession.
- `docs/journal/` is append-only historical evidence: attempts, observations,
  measurements, screenshots, and result artifacts.
- After an interface stabilizes, its exact spec belongs in types, public
  schemas, implementations, and tests. Docs keep intent and pointers rather
  than a second parameter or state-machine copy.

Run tests proportional to the changed component. During implementation, use
the smallest deterministic check that detects the change's unique risk. Do not
rerun broad or full suites for small iterations. Run the broad package/release
lane once, only after all implementation Tasks close and the exact final tree
is stable. If it fails, isolate the failure and rerun only that focused class
until the fix is complete; the final verifier then runs the aggregate lane once.
Behavioral claims require an executable or runtime anchor; a doc alone is not
proof.
