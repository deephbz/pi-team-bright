# Last-resort stale Team rescue

Use this procedure only when an exact leader Session cannot use the normal
lifecycle surface:

- `team_create` returns `active_team_exists`; and
- both `team_sync` and `team_shutdown` return `no_active_team`.

This split can occur when an old Team still binds the Session, but the current
Pi Team Bright version fences that Team from normal model-tool operations. A
normal active Team is not a rescue candidate.

## Preconditions

Get explicit owner authorization before changing Team authority. Then prove all
of these conditions:

1. The stale Team config binds the exact current leader Session.
2. The recorded leader runtime generation and terminal pane carry the current
   Pi process.
3. Every current Worker Membership has an exact runtime generation whose PID is
   absent. Only an `ESRCH` process probe proves PID absence.
4. Every recorded Worker terminal target is absent. For Herdr, start with
   `herdr agent list`, then query each exact pane with `herdr pane get`.
5. No evidence suggests that another process or terminal still owns a current
   Membership.

Stop if any identity, process, or terminal evidence is missing or ambiguous.
Ask the owner to fork the Pi Session instead.

## Rescue procedure

1. Preserve the failed tool results that show the incompatible lifecycle split.
2. Read the Team config and runtime records without changing them.
3. Back up `config.json` outside the Team directory with restrictive file
   permissions. Record its SHA-256 digest.
4. Recheck the config digest immediately before mutation. Stop if it changed.
5. Acquire the Team topology lease. Use the package's locked, atomic Team
   mutation functions to deactivate the exact current Memberships with
   `team_shutdown` as the reason. Do not overwrite JSON directly when those
   functions are available.
6. Preserve Beads data, Task records, event journals, deliveries, runtime
   records, Session files, and terminal evidence. They remain historical
   evidence.
7. Write an external rescue receipt with the time, Team name, before and after
   config digests, exact Membership count, and bounded process and pane
   evidence. Do not include prompts, Task text, credentials, or environment
   values.
8. Retry `team_create` from the exact Session. Then require a successful
   `team_sync` snapshot before creating Workers or Tasks.

A successful config write alone is not proof of rescue. The new Team creation
and snapshot are the external verification signals.

## Prohibited shortcuts

- Do not infer process absence from an old heartbeat or missing agent name.
- Do not use terminal focus or close an unrelated pane, tab, or window.
- Do not kill the current leader process.
- Do not delete or rewrite the stale Team directory.
- Do not edit Membership, runtime, Task, event, or Session files individually.
- Do not rescue a Team while any current Worker process or pane can still exist.
- Do not make this procedure an automatic fallback for `team_create`.
