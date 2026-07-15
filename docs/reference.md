# PiTeams tool reference

PiTeams registers exactly 18 Pi tools. The names and schemas below are the
public tool surface; examples are Pi tool calls, not shell commands.

The runtime contract assumes one PiTeams version per live team. Upgrade by
stopping the whole team, completing any required out-of-band migration, and
restarting the whole team; mixed-version rolling operation isn't supported.

## Team lifecycle

### `team_create`

Creates a team and registers the current session as its lead.

Required: `team_name`.

Optional: `description`, `default_model`, and `separate_windows` (default
`false`). `default_model` is inherited by spawned teammates when supplied;
omit it to keep Pi's configured default. `separate_windows` requests OS
windows instead of panes and is rejected when the selected adapter does not
support windows.

```js
team_create({ team_name: "audit", description: "Security review" })
```

Creating a team does not itself spawn a teammate or require a terminal adapter.
A teammate cannot call this lead-only topology mutation. The receipt identifies
the durable Team, current lead Membership, and Task authority.
A terminal adapter is required by the spawn tools. By default, creation
initializes the Team's own `~/.pi/teams/<team>` directory as its Beads authority
and records its exact identity. `PI_TEAMS_BEADS_WORKSPACE` is an optional
explicit override for an absolute, already initialized authority; creation
validates an override and fails closed when it is unhealthy.

### `spawn_teammate`

Starts a teammate in a pane or OS window and adds it to the roster.

Required: `team_name`, `name`, `prompt`, `cwd`.

Optional: `model`, `thinking` (`off`, `minimal`, `low`, `medium`, `high`, or
`xhigh`), and `separate_window` (default `false`). Omit `model` unless an
explicit override is requested.
`cwd` must be absolute. A discovered agent definition with the same name can
supply a Pi tool allowlist to the launched process. Spawning a name already in
the roster stops and replaces that teammate.

The initial `prompt` is written to the teammate's inbox and delivered as native
custom context with its stable Message ID. No synthetic user message or
model-issued `read_inbox` call is part of delivery.
This is lead-only. The structured receipt keeps four facts separate: durable
Membership persistence, terminal launch, Message-authority acceptance, and
runtime/presentation observation. The first three can succeed while the latter
two remain `not_observed`; the call never waits for agent runtime readiness.

### `check_teammate`

Inspects one roster member.

Required: `team_name` and `agent_name`.

The concise result includes `alive`, `unreadCount`, `health`,
`hasRecentHeartbeat`, and `startupStalled`. Machine details retain raw runtime
telemetry for diagnosis. Its historical `ready` field only records observed
post-start activity and must not be read as agent-loop readiness, progress, or
Task completion. Health is
terminal/process and inbox telemetry, not task status. The normal labels are
`dead`, `stalled`, `healthy`, `idle`, and `starting`. A dead member's runtime
status file is removed. A tmux teammate's first startup records its Pi session
file. When that session resumes with `pi -r`, startup restores the teammate
identity and replaces the stale tracked pane ID before this health check runs,
without requiring team environment variables.
This is an on-demand runtime diagnostic, not a routine progress/completion
poll. Normal coordination should be driven by Task changes and substantive
Messages.

### `teammate_shutdown`

Shuts down one teammate, removes its runtime status, and removes it from the
current-roster projection while retaining its historical Membership record.

Required: `team_name` and `agent_name`. The lead cannot be removed with this
tool. PiTeams deactivates the Membership only after the adapter confirms its
pane/window is gone, or an exact Membership-bound runtime record proves the
recorded process already exited. It never kills a PID from durable state alone.
If neither proof is available, the call fails and the Membership stays current.
This lifecycle mutation is lead-only.

### `team_shutdown`

Stops all teammates without performing global age-based Pi-session cleanup.

Required: `team_name`.

Shutdown attempts every current teammate independently. It marks a Membership
inactive only when terminal/process stop is confirmed; failed stops and the
lead remain current so the lead can inspect and retry. Historical member/Session
records, TeamConfig, Beads authority, and migration evidence are retained. The
response reports stop evidence, per-recipient failures, deactivated members,
stale/orphan terminal bindings, and retained Task authority.
This lifecycle mutation is lead-only.

### `report_stale_agent_sessions`

Reports age-qualified folders under `~/.pi/agent/teams/` for operator review.
Age isn't liveness evidence, so this Alpha tool deletes nothing; its receipt
returns `candidates`, `cleaned: 0`, and the safety reason. Optional:
`max_age_hours` (default `24`), which must be finite and non-negative.

## Communication

### `send_message`

Writes one transient inbox Message with an authority-local stable `id`. The
model-visible receipt and `details.messageId` both expose that ID.

The recipient must exist in the team's current `config.json` roster at send
time. If it does not, the tool returns an error directing the sender to the
team leader and appends no inbox record; a historical inbox file is not
membership evidence. A nonexistent `team_name` also returns a clear error and
creates no team or inbox state.

Required: `team_name`, `recipient`, `content`, and `summary`. There is no
`color` parameter on direct messages.

### `broadcast_message`

Attempts one transient Message per current team member except the sender. Its
model-visible receipt lists accepted `{recipient, messageId}` records and
recipient-specific failures; partial delivery is never reported as all sent.

Required: `team_name`, `content`, and `summary`. Optional: `color`.

### `read_inbox`

Reads an agent inbox.

Required: `team_name`. Optional: `agent_name` and `unread_only` (default
`true`). Omitting `agent_name` reads the current agent's inbox. Reading an
inbox is communication-state inspection; it does not claim or update a task.
Inspecting another Agent's inbox is non-consuming; explicitly reading one's
own inbox may mark the returned Messages read.
For a teammate reading its own inbox, PiTeams records post-start activity and
updates heartbeat telemetry; this is not a runtime-readiness assertion.

Unread direct Messages are coalesced into a
`pi-teams.direct-message` custom Message with full bodies and stable IDs. The
adapter uses `triggerTurn: true` and `deliverAs: "steer"` without changing the
session-wide steering mode. A `context` event only stages exact Message IDs;
PiTeams marks them read after the first assistant `turn_end` whose stop reason
is not `error` or `aborted`. `PI_TEAMS_MESSAGE_POLL_MS` controls the
fallback rescan interval, whose default is `30000`; filesystem watch events are
hints. `read_inbox` remains available for explicit inspection. Broadcast
fan-out still creates one accepted recipient inbox record per current member.
Use `read_inbox` only for audit/history; never call it to fetch normal
delivery. Avoid ACK-only `send_message` calls unless semantic confirmation is
required.

Task delivery writes Task-local delivery evidence and emits
`pi-teams.task-change` after an authoritative mutation addressed to an exact
Session. It is at-least-once until successful-turn acknowledgement. Delivery start/restart
reconciles missing spool intent; periodic scans inspect only the local spool
and never list Beads per Agent. `PI_TEAMS_TASK_POLL_MS` controls that local
fallback scan and defaults to `30000`.
An ambiguous prepared assignee-transition intent remains durable and is rechecked
instead of being aged out: without a matching Beads operation marker, elapsed
time cannot prove that an interrupted authority write will never commit. This
preserves at-least-once recovery but can leave a retained record requiring
operator inspection; Alpha deliberately has no lossy quarantine timeout.
The custom payload is a versioned snapshot, not Task authority; no inbox record
is created, and runtime/delivery acknowledgements never mutate Task state. Same-
Session resume recovers pending delivery, while fork/fresh-Session inheritance
is denied.

Alpha push semantics cover PiTeams-mediated Task writes. Direct external `bd`
writes remain authoritative and immediately queryable through `task_read` and
`task_list`, but they do not produce live push; PiTeams intentionally avoids
per-Agent Beads polling.

## Tasks

### `task_create`

Creates a Task in the team's configured Beads Task authority.

Required: `team_name`, `title`, and `description`.

Optional: `design`, `assignee`, and `idempotency_key`. New Tasks start `open`;
Beads creates title, description, design, and assignee in one authority write.
The returned `id` is the backend Task ID.
The receipt contains post-state, so don't immediately `task_read` or
`task_list` the same result.

```js
task_create({
  team_name: "audit",
  title: "Review authentication",
  description: "Check the authentication handlers for unsafe input."
})
```

### `task_read`

Reads one complete task record.

Required: `team_name` and `task_id`. The record can include its Beads ID,
title, description, design, native notes, assignee, typed relations, provenance,
and the exact backend version token in `version`. Use the ID returned by
`task_create` or `task_list`. For a subsequent Beads mutation, pass this
`task_read` `version` value as `expected_version`.
Use this on demand, not merely to reconfirm a mutation receipt.

### `task_list`

Lists the team's current compact Task projection.

Required: `team_name`. Runtime Task IDs are Beads IDs. Historical numeric JSON
IDs are accepted only by the explicit migration tool. This performant
projection deliberately omits `version`; call `task_read` for the
authoritative token before a conditional write.

### `task_update`

Performs one semantic Task update. Compatible content, assignee, work-state,
and note changes use one native Beads update. Atomic claim is deliberately
standalone; closing may include its explanatory note in the same authority
mutation. The result includes complete
post-state plus an explicit applied-operation list.
That receipt is sufficient confirmation; don't immediately re-read or list
the same Task.

Required: `team_name` and `task_id`.

Supported inputs are:

- `title`: replace the concise Task title;
- `description`: replace the durable intention, constraints, or criteria;
- `design`: replace the current low-level execution design;
- `status`: `open`, `in_progress`, `blocked`, or `closed`;
- `assignee`: assignment name, or an empty string to clear it;
- `claim`: atomically claim for the current agent where supported;
- `append_note`: append prose to the native Beads notes without replacing prior text;
- `expected_version`: optional optimistic concurrency token from `task_read`.

When `expected_version` is supplied, a mismatch fails closed; PiTeams carries
the canonical returned version for the operation. That version covers every
reviewable field and relation, including multiline notes. `blocked` is an
explicit writable work state and is independent of graph relations.

Beads 1.1.0 has no true CLI compare-and-swap, so a supplied token is a
serialized preflight and another
writer can still race after the check. A failed Beads command, timeout,
malformed response, scope failure, or conflict fails the tool; PiTeams never
falls back to legacy files.

Closing invokes the configured hook. See [Hooks](#closed-task-hook).

Every Task mutation tool returns concise model-visible JSON with post-state
`id`, `status`, `assignee`, and `version`, plus `appliedOperations` and
`warnings`. Large descriptions, design, notes, relations, and backend evidence
stay in structured `details` rather than the concise mutation content.

### `task_link`

Adds or removes one typed Task relation with graph and optimistic-version
validation.

Required: `team_name`, `task_id`, `relation`, `target_id`, and `action`.
`relation` is `blocked_by`, `parent`, or `related`; `action` is `add` or
`remove`. Optional: `expected_version`.

`blocked_by` and `parent` are directed and cycle-checked. `related` is
bidirectional and may form cycles. A Task has at most one parent; adding a
different parent fails rather than silently replacing the existing relation.
Remove the old parent explicitly before adding another.

Review is not a separate tool or entity. For complex work, the assigner asks
the worker to supplement `design`; the worker sends a Message referencing the
Task ID/version; approval is an exact-version `task_update` to `in_progress`;
rejection appends feedback while status remains `open`. Simple Tasks may skip
review and move directly to execution.

## Team templates

### `list_predefined_teams`

Takes no parameters. Lists templates discovered from global and project
`teams.yaml` files and reports whether referenced agent definitions exist.
Global definitions are read from `~/.pi/teams.yaml`, with the historical
`~/.pi/agent/teams.yaml` location also supported; project definitions are in
`.pi/teams.yaml`.

### `list_predefined_agents`

Takes no parameters. Lists discovered agent definitions and their `name`,
`description`, `tools`, `model`, and `thinking` fields. Global definitions
come from `~/.pi/agent/agents/`; project definitions come from `.pi/agents/`.

### `create_predefined_team`

Creates a team from a discovered template and attempts to spawn all of its
agents, returning per-agent `spawned`, `skipped`, or `error` results.

Required: `team_name`, `predefined_team`, and `cwd`.

Optional: `default_model` and `separate_windows` (default `false`). Agent
settings and tool allowlists from each definition are used when launching.
This topology mutation is lead-only.

### `save_team_as_template`

Saves a runtime team with at least one spawned teammate as reusable agent
files plus a `teams.yaml` entry. The caller must be the Team's current exact
Session binding; persisted historical Team configs aren't exposed as a tool
catalog.

Required: `team_name` and `template_name`. Optional: `description`, `scope`
(`user` or `project`, default `user`), and `dry_run` (default `false`). User
scope writes under `~/.pi`; project scope writes under the current project.
This mutation is lead-only. `dry_run: true` performs no writes and returns the
exact planned artifact paths, create/update actions, contents, and
`written: false`; a normal call returns the same artifact shape with
`written: true`.

Topology, lifecycle, and template mutation tools return a small shared
`receipt` envelope: `accepted`, `operation`, resource identity, durable
`postState`, `warnings`, and an optional `nextAction`. Runtime or delivery
readiness is never inferred from a durable write.

## Closed-Task hook

The supported hook is `.pi/team-hooks/task_closed.sh`, resolved relative to
the current Pi process working directory. When a close write invokes it,
the task record is passed as a JSON string in the first argument and `PI_TEAM`
is set to the team name.

`BeadsTaskStore` invokes the hook when a Task transitions to closed through
`task_update`. Hook failure is logged and does not undo the Task mutation. A hook
is not a transactional quality gate.

## Task authority and Beads cutover

A team without `taskBackend: "beads"` has no runtime Task store. Historical
JSON files under `~/.pi/tasks/<team>/` are migration input only, and every Task
tool fails closed with this explicit operator command:

```sh
npm run migrate:tasks -- <team-name> <absolute-beads-workspace> [report-path]
```

The workspace must be absolute and contain an initialized Beads repository.
It must contain its own Beads 1.1 `.beads/metadata.json`, and `bd where` must
resolve to that exact root; ancestor repository discovery is rejected. PiTeams
persists the non-secret backend, database, Dolt database name, and Beads
project ID as a versioned fingerprint, then compares it before later reads or
writes so an in-place database replacement also fails closed.
The migration inventories and hashes legacy files, imports or reconciles by
`pi_teams_legacy_id`, maps superseded statuses, owners, plans, dependencies and metadata,
reconciles before and after values, and only then records the cutover. An
interrupted migration can be rerun safely. Pre-cutover drift blocks authority
change until reviewed; an operator override is explicit and persisted.
After cutover, a rerun must name the exact configured workspace. It reports the
actual persisted legacy-to-Beads mapping and fails closed if the path differs,
the authority workspace is unavailable, `taskAuthorityId` or its external
fingerprint is missing/mismatched, or a migrated mapping is missing.

After cutover the team config records `taskBackend: "beads"`, the absolute
`taskWorkspace`, and cutover evidence. Beads is the sole writable authority.
Changed or newly created legacy files are reported as orphaned old-client
writes and are never imported automatically. Mixed legacy/Beads writers are
not a supported steady state. Beads IDs remain the task IDs; do not translate
them back to local numbers.

That paragraph describes legacy migration only. The current public Task model
maps title, description, native design/notes, assignee, and the four statuses
`open`, `in_progress`, `blocked`, and `closed` directly. Relations are the
typed `blocked_by`, `parent`, and `related` edges. A native Beads status outside
that vocabulary fails explicitly instead of being silently projected. PiTeams
continues to own membership, panes, processes, and transient inboxes.

After `team_shutdown` on a Beads-cutover team, use the retained absolute
`taskWorkspace` from the preserved team config:

```sh
bd --directory <taskWorkspace> --json list --label pi-teams:<team-name> --all --no-pager --limit 0
bd --directory <taskWorkspace> show <beads-id> --long --include-comments --include-dependents
bd --directory <taskWorkspace> graph --dot <beads-id> > task.dot
bd --directory <taskWorkspace> graph --html <beads-id> > task.html
```

Include `--all` when listing closed history. `bd graph --all` is an open-work
view; visualize a specific ID when closed dependencies must appear.

## Terminal adapters and limitations

The registry selects the first detected adapter in this order: `tmux`,
`zellij`, `cmux`, `iTerm2`, `WezTerm`, then `Windows`. A missing adapter makes
spawning unavailable. Pane support is available through all six adapters.
Separate OS windows are supported by `cmux`, iTerm2, WezTerm, and Windows
Terminal; `tmux` and Zellij support panes only.

- **tmux** requires `TMUX` and supports pane split/kill/liveness, but never OS
  windows.
- **Zellij** requires `ZELLIJ` outside tmux. It uses `--close-on-exit`, but its
  synthetic pane ID cannot prove an explicit stop. Shutdown therefore fails
  closed and keeps the Membership current until the process is closed manually;
  health remains advisory.
- **cmux** is selected by `CMUX_SOCKET_PATH` or `CMUX_WORKSPACE_ID` outside
  tmux/Zellij. It manages surfaces and can create/close windows through the
  `cmux` CLI.
- **iTerm2** requires macOS iTerm2 (`TERM_PROGRAM=iTerm.app`) outside
  tmux/Zellij. Pane and window operations use AppleScript.
- **WezTerm** requires `WEZTERM_PANE` and a working `wezterm` CLI outside
  tmux/Zellij. It supports panes and separate windows; window shutdown is
  implemented by killing the window's panes.
- **Windows Terminal** is selected on Windows outside tmux, Zellij, and
  WezTerm. It requires `wt` at spawn time and PowerShell for commands. Its
  pane/window IDs are synthetic: the adapter has no direct pane/window kill or
  reliable liveness query, and tab titles are limited. Shutdown fails closed
  and keeps the Membership current until the process is closed manually.
  PiTeams never kills a PID from durable state alone; after manual closure, an
  exact Membership-bound runtime record can prove the recorded process exited.

The `separate_window` and `separate_windows` flags therefore express a request,
not a portable guarantee. PiTeams rejects the request when the selected
adapter reports no window capability.
