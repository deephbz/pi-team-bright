---
name: pi-teams
description: Operate PiTeams agent orchestration tools for creating teams, spawning teammates, coordinating tasks, and managing teammate lifecycle.
---

# PiTeams

PiTeams is an orchestration extension for Pi. It owns team membership,
terminal panes/windows, inbox messages, runtime health, and the task-tool
workflow. It does not provide slash commands; every operation below is a Pi
tool. The extension registers exactly 18 tools.

Communication is limited to direct messages and broadcasts among current
members of one Team. Leader-to-leader messaging across Teams and communication
between agents outside a Team are out of scope.

Use one PiTeams version per live team. For an Alpha upgrade, stop the whole
team, run any required out-of-band Task migration, then restart every process
on the same version; don't attempt a rolling mixed-version upgrade.

No Task workspace setup is required for a new Team: `team_create` initializes
the Team's own directory as its Beads authority. `PI_TEAMS_BEADS_WORKSPACE` is
only an optional explicit override for an already initialized authority. Beads
is the only runtime Task authority; don't create or update legacy JSON Task files.

## Normal workflow

1. Call `team_create`.
2. Call `spawn_teammate` for each specialist, or use
   `create_predefined_team` for a saved template.
3. Use `task_create`, `task_update`, and `task_link` for work. Their receipts contain the
   authoritative post-state, so don't immediately follow them with
   `task_read` or `task_list`; query later only when current state is needed.
4. Use `send_message` and `broadcast_message` for substantive transient
   coordination. Avoid ACK-only Messages unless semantic confirmation is
   required; use `read_inbox` only for explicit audit/history inspection.
5. Use `check_teammate` only to diagnose suspected runtime trouble, then
   `teammate_shutdown` for one teammate or `team_shutdown` for the
   whole team.

When a teammate is launched, PiTeams accepts its initial prompt into the inbox
and delivers it as native custom context; don't call `read_inbox` merely to
fetch delivery. A teammate's `check_teammate` health is derived from terminal
liveness, inbox state, startup timing, and runtime heartbeat; it is not Task
status.

Task assignments and changes
addressed to the current exact Pi Session arrive as `pi-teams.task-change`
custom context with an authority-scoped Task ID/version. Act on that payload;
re-read Task authority before a conflicting write. It isn't a Communication
Message, and observing it doesn't acknowledge completion or change Task state.

## Process recovery

A killed Pi process is not a PiTeams shutdown. Resume the same lead session
with `pi -r`; PiTeams matches its durable Pi session file, then refreshes the
lead PID, tmux pane, and native delivery. A teammate's first startup records the
same durable Pi session identity, so it can also be resumed in a new pane with
plain `pi -r`; startup restores its member identity and refreshes the tracked
pane/runtime state. A first startup binds only when it presents the exact
single-use `PI_AGENT_LAUNCH_ID` prepared for that Membership. An older or
incomplete Membership without either an exact Session binding or its original
launch capability fails closed; stop and explicitly respawn it rather than
guessing identity from names.
If one durable lead Session appears in multiple historical team records,
resume fails closed; set `PI_TEAM_NAME` to the intended team and repair the
stale lead-session record instead of relying on directory order. The explicit
name must identify an existing team; an invalid selector never creates one.

## Team and teammate tools

### `team_create`

Required: `team_name`.

Optional: `description`, `default_model`, and `separate_windows` (default
`false`). It creates the team and registers the current session as the lead.
This is a lead-only topology mutation. Its structured receipt reports durable
Team, lead Membership, and Task-authority identity.
`separate_windows` asks the terminal adapter to use OS windows instead of
panes when supported. Omit `default_model` unless the user explicitly requests
an override; omission preserves Pi's configured default.

### `spawn_teammate`

Required: `team_name`, `name`, `prompt`, and `cwd`.

Optional: `model`, `thinking` (`off`, `minimal`, `low`, `medium`, `high`, or
`xhigh`), and `separate_window` (default `false`). Existing teammates with the
same name are stopped and replaced. The tool rejects missing teams, missing
terminal adapters, and unsupported window mode. Omit `model` unless the user
explicitly requests an override. When `name` matches a discovered agent
definition, its `tools` allowlist is passed to Pi's `--tools` launch option.
This is lead-only. The receipt separately reports the durable Membership,
terminal launch, initial Message acceptance, and unobserved runtime/Message
presentation state. It does not wait for startup readiness; use
`check_teammate` only when trouble is suspected.

### `check_teammate`

Required: `team_name` and `agent_name`. The concise result includes `alive`,
`unreadCount`, `health` (`dead`, `stalled`, `healthy`, `idle`, or `starting`),
`hasRecentHeartbeat`, and `startupStalled`. Machine details retain raw `runtime`
telemetry for diagnosis; its historical `ready` field means only that some
post-start activity was observed, not agent-loop readiness, progress, or Task
completion. Dead runtime status files are cleaned up.
It is an on-demand diagnostic, not a progress/completion poll.

### `teammate_shutdown`

Required: `team_name` and `agent_name`. It deactivates the current Membership
only after the pane/window is confirmed gone, or an exact Membership-bound
runtime record proves the recorded process already exited. It never kills a PID
from durable state alone. If shutdown cannot be confirmed, escalate the manual
close to the operator and retry; the Membership remains current. The lead is
not removed by this tool.
This lifecycle mutation is lead-only.

### `team_shutdown`

Required: `team_name`. It attempts every teammate independently without global
age-based Pi-session deletion. Only confirmed stops are deactivated; failed
stops and the lead remain current, and the receipt reports failures and stop
evidence. It retains the team configuration, Beads authority, and legacy task
files as migration evidence; task truth is never deleted by shutdown.
Historical teams without Beads authority have no runtime Task store and must
use the explicit migration workflow before Task tools can run.
This lifecycle mutation is lead-only.

### `report_stale_agent_sessions`

Optional: `max_age_hours` (default `24`, finite and non-negative). It reports
old folders under `~/.pi/agent/teams/` as review candidates but deletes none;
age alone isn't sufficient liveness evidence.

## Communication tools

### `send_message`

Required: `team_name`, `recipient`, `content`, and `summary`. It appends one
message to the recipient's transient inbox. The recipient must be in the
team's current roster; if not, escalate to `team-lead` rather than treating an
old inbox as membership evidence. A nonexistent team errors without creating
state. There is no `color` field. The model-visible receipt includes the
accepted stable Message ID.
Avoid ACK-only Messages unless semantic confirmation is required.

### `broadcast_message`

Required: `team_name`, `content`, and `summary`. Optional: `color`. It attempts
one Message for every current member except the sender and returns accepted
recipient/Message-ID pairs plus recipient-specific failures.

### `read_inbox`

Required: `team_name`. Optional: `agent_name` and `unread_only` (default
`true`). Without `agent_name`, the current agent's inbox is read. Reading a
teammate's inbox is an inspection operation; messages remain PiTeams
communication state, not task state. Foreign inspection is non-consuming;
reading one's own inbox may mark returned Messages read.
Normal accepted Messages are delivered as native custom context; never call
`read_inbox` merely to fetch delivery.

## Task tools

### `task_create`

Required: `team_name`, `title`, and `description`. Optional: `design`,
`assignee`, and `idempotency_key`. New Tasks start `open`; it returns the
backend Task ID.
The mutation receipt includes post-state; don't immediately re-read or list it.

### `task_read`

Required: `team_name` and `task_id`. It returns the full task record, including
its backend ID, title, description, design, native notes, assignee, typed
relations, provenance, and the authoritative write token in `version`.
Pass that exact `version` value as `expected_version` on the next Beads
mutation. `task_read` is the shipped name;
there is no `task_get`.

### `task_list`

Required: `team_name`. It returns the team's compact current Task projection. IDs
are not assumed to be numeric: after Beads cutover they are Beads IDs. This
performant projection omits `version`; use `task_read` before a conditional
write.
Don't call this immediately after a mutation merely to confirm its receipt.

### `task_update`

Required: `team_name` and `task_id`. Optional fields are:

- `title`: replace the concise title;
- `description`: replace the durable intention, constraints, or criteria;
- `design`: replace the current low-level execution design;
- `status`: `open`, `in_progress`, `blocked`, or `closed`;
- `assignee`: assignment name, or an empty string to clear it;
- `claim`: atomically claim for the current agent where the backend supports it;
- `append_note`: append native Beads notes without replacing prior prose;
- `expected_version`: optimistic concurrency token;

`blocked` is an explicit writable work state and is independent of graph
relations. Compatible fields use one native Beads update. `claim` is a
standalone safety operation; a `closed` transition may include its final note
in the same authority mutation. The result contains complete
post-state and applied operations. `expected_version` is optional and enforced
when supplied. Every mutation tool's model-visible receipt includes post-state
`id`, `status`, `assignee`, `version`, applied operations, and warnings without
large Task bodies. Don't immediately call
`task_read` or `task_list` merely to confirm that receipt. Beads 1.1.0 has no
true CLI CAS, so a
supplied token is a serialized preflight and an external writer can still race
after the check. `closed` invokes `.pi/team-hooks/task_closed.sh`; hook failures
are logged and do not undo the Task mutation.

### `task_link`

Required: `team_name`, `task_id`, `relation`, `target_id`, and `action`.
`relation` is `blocked_by`, `parent`, or `related`; `action` is `add` or
`remove`. Optional: `expected_version`.

`blocked_by` and `parent` are directed and cycle-checked; `related` is
bidirectional. Adding a second parent fails instead of silently reparenting.

Simple Tasks may enter execution directly. Only when the assigner judges work
complex should the worker supplement `design` and send a Message referencing
the Task ID/version. Approval is an exact-version `task_update` to
`in_progress`; rejection appends feedback while the Task remains `open`.
Review is a collaboration convention, not a universal mechanical gate.

## Predefined/template tools

### `list_predefined_teams`

No parameters. Lists team templates discovered from global/project
`teams.yaml` files and reports whether each referenced agent definition exists.

### `list_predefined_agents`

No parameters. Lists discovered agent definitions and their `name`,
`description`, `tools`, `model`, and `thinking` fields.

### `create_predefined_team`

Required: `team_name`, `predefined_team`, and `cwd`. Optional:
`default_model` and `separate_windows` (default `false`). It creates the team
and attempts to spawn every agent in the template, returning per-agent
`spawned`, `skipped`, or `error` results. Omit `default_model` unless the user
explicitly requests an override. Each definition's `tools` allowlist is passed
to Pi's `--tools` launch option. This topology mutation is lead-only.

### `save_team_as_template`

Required: `team_name` and `template_name`. Optional: `description`, `scope`
(`user` or `project`, default `user`), and `dry_run` (default `false`). It writes agent definition files and a
`teams.yaml` template, requires at least one spawned teammate, and only accepts
the Team currently bound to this exact Pi Session. Historical Team configs
aren't an agent-facing catalog. This mutation is lead-only. With `dry_run`, it
returns every exact output path, action, and content with `written: false` and
makes no directories or files.

## Task authority and migration

Teams without `taskBackend: "beads"` have no runtime Task authority. Historical
per-task JSON files under `~/.pi/tasks/<team>/` are migration input only. A
migrated team records `taskBackend: "beads"`, an absolute `taskWorkspace`, a
stable opaque `taskAuthorityId`, a versioned external authority fingerprint,
and a cutover record in its team config. Beads is the
sole runtime Task authority: if `bd` is unavailable, malformed, times out,
rejects a scope, or reports a conflict, the tool fails with an actionable error
and never writes the legacy files.

Run the migration helper with:

```sh
npm run migrate:tasks -- <team-name> <absolute-beads-workspace> [report-path]
```

The helper inventories numeric legacy task files into an immutable, hashed
inventory; imports or reconciles by `pi_teams_legacy_id`; maps IDs, statuses,
owners, plans, dependencies, progress metadata, and closure; reconciles before
and after values; then records prepared/active cutover events and flips the
team config only after reconciliation succeeds. Re-running an interrupted
migration is idempotent and serialized per team/workspace with a durable lock.
Pre-cutover drift in legacy files blocks authority change until a persisted,
inventory-bound operator override is reviewed. After cutover, changed or newly created legacy files
are reported as orphaned old-client writes and are never imported
automatically. Mixed old/new task writers are not supported steady state.

Those old field names describe the one-way migration input, not the current
agent-facing API. The current Task model maps native title, description,
design, notes, assignee, and `open`/`in_progress`/`blocked`/`closed` directly;
relations are `blocked_by`, `parent`, and `related`. Unsupported native status
values fail explicitly rather than being silently projected. Beads IDs remain
Task IDs. PiTeams still owns membership, panes, process lifecycle, and
transient inboxes.

### Post-shutdown Beads inspection

After a Beads-cutover `team_shutdown`, use the retained absolute
`taskWorkspace` from the preserved team config as the query root. Include
`--all` to retain closed task history:

```sh
bd --directory <taskWorkspace> --json list --label pi-teams:<team-name> --all --no-pager --limit 0
bd --directory <taskWorkspace> show <beads-id> --long --include-comments --include-dependents
bd --directory <taskWorkspace> graph --dot <beads-id> > task.dot
bd --directory <taskWorkspace> graph --html <beads-id> > task.html
```

`bd graph --all` is an open-work view, so visualize a specific task when its
closed dependencies must appear. The Beads workspace is the task authority;
the retained PiTeams config provides the workspace and cutover provenance.

## Nonexistent APIs

Do not call or teach `team_delete`, `read_config`, `force_kill_teammate`, or
`task_get`. They are not registered tools. Configuration is inspected through
the runtime behavior above, individual teammate shutdown uses
`teammate_shutdown`, whole-team cleanup uses `team_shutdown`, and
individual task reads use `task_read`.
