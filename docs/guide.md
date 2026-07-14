# PiTeams usage guide

PiTeams is a Pi extension, so the operations in this guide are Pi tools. The
extension registers exactly 20 tools; the complete parameter reference is in
[reference.md](reference.md).

## Getting started

Install the package in Pi:

```sh
pi install git:github.com/deephbz/pi-teams@v0.11.0-hypercarrier.0
```

This guide describes the HyperCarrier fork; `npm:pi-teams` is the separate
upstream package and does not yet provide this release.

Treat each Alpha upgrade as one team-wide epoch. Stop the whole team, change
the installed PiTeams version, run any required out-of-band Task migration,
then restart every process on that same version. Rolling upgrades and mixed
old/new live processes in one team aren't supported.

Before starting Pi, configure one absolute, initialized Beads workspace as the
Task authority for newly created teams:

```sh
mkdir -p /absolute/path/to/task-workspace
cd /absolute/path/to/task-workspace
bd init --non-interactive --skip-agents
export PI_TEAMS_BEADS_WORKSPACE=/absolute/path/to/task-workspace
```

The Pi lead and spawned teammates must inherit that environment. `team_create`
validates the workspace and fails closed when it is missing or unhealthy.

Create a team, then spawn teammates with absolute working directories:

```js
team_create({ team_name: "my-team" })
spawn_teammate({
  team_name: "my-team",
  name: "reviewer",
  prompt: "Review the authentication code and report concrete findings.",
  cwd: "/absolute/path/to/project"
})
```

A team can be created without a terminal adapter, but `spawn_teammate` and
`create_predefined_team` need one. A teammate's initial prompt is accepted into
its transient inbox and delivered as native custom context; no model-issued
`read_inbox` call or synthetic user-message bootstrap is required.

Use `check_teammate` only when diagnosing suspected runtime trouble, not as a
routine progress/completion poll:

```js
check_teammate({ team_name: "my-team", agent_name: "reviewer" })
```

`check_teammate` combines terminal liveness, unread messages, startup timing,
and heartbeat telemetry. It does not inspect whether a task is complete.
Normal progress should arrive through Task changes or substantive Messages.

## Recovering a killed Pi process

A process kill is not a PiTeams shutdown. To resume a lead, start `pi -r` in
its project directory and select the lead's prior Pi session. PiTeams matches
the selected durable session file, updates the lead PID and tmux pane, and
restores native Message and Task delivery.

To resume a tmux teammate whose pane exited, create a new pane in the same
project directory, run `pi -r`, and select that teammate's prior session.
PiTeams recorded the teammate's durable session file at its first startup, so
it restores the teammate identity and refreshes the tracked tmux pane/runtime
record without `PI_TEAM_NAME` or `PI_AGENT_NAME`.

A first startup binds only when it presents the exact single-use
`PI_AGENT_LAUNCH_ID` prepared for that Membership. An older or incomplete
Membership with neither an exact Session binding nor its original launch
capability fails closed; stop and explicitly respawn it. Names and environment
selectors alone never manufacture identity.

If historical records associate the same durable lead Session with multiple
teams, environment-free resume fails closed instead of choosing by directory
order. Set `PI_TEAM_NAME` to the intended current team for that resume, then
review and repair the stale `lead-session.json` record. An explicit
`PI_TEAM_NAME` must name an existing team; a typo fails closed and creates no
replacement team state.

## A task workflow

Create first, then use `task_read` before a conditional update:

```js
const task = task_create({
  team_name: "my-team",
  subject: "Review authentication",
  description: "Inspect authentication handlers for unsafe input."
})

task_list({ team_name: "my-team" })
task_read({ team_name: "my-team", task_id: "<id-from-task_create>" })
task_update({
  team_name: "my-team",
  task_id: "<task-id>",
  owner: "reviewer"
})
```

`task_create` does not accept initial status or owner. Use `task_update` for
those fields. Its status values are `pending`, `planning`, `in_progress`,
`blocked`, `completed`, and `deleted`. Explicit `blocked` work state is
independent of `blocked_by` dependency edges. One call may combine owner with a compatible nonterminal
status because Beads applies both in one command. A single dependency,
progress entry, or pending problem is its own semantic operation; combinations
requiring several commands fail before mutation rather than hide partial
success. The result includes complete post-state and applied operations.
Soft-deleted Tasks are immutable through all Task mutation tools. Completed
Tasks can be reopened only by an explicit `task_update` status transition;
`claim` and `task_submit_plan` never reopen them implicitly.

The `task_read` result names the authoritative token `version`; the optional
write parameter is `expected_version`. When supplied, a mismatch fails closed.
`task_list` is a performant projection and omits `version` because the Beads
list representation doesn't contain the complete authority snapshot.

Mutation tools return concise model-visible JSON containing Task `id`,
`status`, `owner`, and new `version`, plus applied operations and delivery
warnings. Continue from that version without immediate read-after-write; use
`task_read` when later activity may have changed it.

For a teammate that must propose work first:

```js
task_submit_plan({
  team_name: "my-team",
  task_id: "<task-id>",
  plan: "Inspect handlers; add focused tests; report findings."
})

task_evaluate_plan({
  team_name: "my-team",
  task_id: "<task-id>",
  action: "approve"
})
```

Approval changes `planning` to `in_progress`. Rejection requires `feedback`
and keeps the task in `planning`; it does not automatically start the task.
Rejection consumes that submitted plan, so revise it and call
`task_submit_plan` again before requesting another evaluation.
Plan state is changed explicitly through the two Task plan tools. If a
teammate must propose work before executing, say so in its prompt or Message;
PiTeams doesn't expose a separate spawn-time plan-mode switch.

Use `claim: true` for an atomic claim where supported. Use `blocked_by` to add
a dependency to the target task. Beads rejects `blocks`, because that form
would mutate a second task without a second version token. `progress` and
`pending_problem` append communicated entries rather than replacing the task
record.

## Communication and shutdown

Direct messages and broadcasts are transient coordination state:

```js
send_message({
  team_name: "my-team",
  recipient: "reviewer",
  content: "Please prioritize the session validation path.",
  summary: "Prioritize session validation"
})

broadcast_message({
  team_name: "my-team",
  content: "The test environment is ready.",
  summary: "Test environment ready"
})
```

`send_message` has no `color` parameter; `broadcast_message` optionally does.
Use `read_inbox` only for explicit audit/history inspection. Normal accepted
Messages arrive as native custom context, so never call it merely to fetch
delivery. Inbox state is separate from task state. Avoid ACK-only
`send_message` calls unless semantic confirmation is required.
Direct send accepts only a recipient in the team's current roster; an old
inbox file does not keep a removed teammate addressable.
Direct-send receipts expose the stable Message ID. Broadcast receipts expose
accepted recipient/Message-ID pairs and per-recipient failures, so partial
fan-out is explicit. Reading another Agent's inbox is non-consuming; only an
Agent's explicit read of its own inbox may mark returned Messages read.

### Direct Message delivery

The recipient adapter assigns or migrates a stable `id` on each inbox record,
coalesces currently unread records into one `pi-teams.direct-message` custom
Message containing every ID and full body, and sends it with
`deliverAs: "steer"` plus `triggerTurn: true`. It does not change Pi's
session-wide steering mode. Pi's `context` hook only stages the exact Message
IDs in process memory. The first assistant `turn_end` whose stop reason is not
`error` or `aborted` appends a successful-turn acknowledgement to the Pi
Session and marks those inbox records read. An error or abort leaves them
pending, so a same-Session restart presents a resume steer; a fork does not
consume the source recipient's pending inbox.

`read_inbox` remains available for explicit inspection. Set
`PI_TEAMS_MESSAGE_POLL_MS` to a positive integer to change the fallback rescan
interval; the default is 30000 milliseconds. Filesystem activity is only a
latency hint, so correctness does not depend on receiving every watch event.
This changes only recipient inbox presentation; Task/Beads behavior is
separate. A broadcast still fans out one inbox record per recipient.

### Task change delivery

Successful Task assignments and later changes surface directly to the exact
assignee Session. The Beads backend remains authoritative. The adapter writes a
separate task-local delivery record keyed by authority instance, native Task
ID, accepted version, change kind, recipient and Session, then emits a
`pi-teams.task-change` custom steer containing the versioned Task payload.
It never creates an inbox Message, and context/runtime observation never
changes Task owner or status.

Pi's `context` hook only stages the exact custom Task change in process memory.
The first assistant `turn_end` whose stop reason is not `error` or `aborted`
appends a successful-turn acknowledgement and settles its delivery record.
Same-Session process resume recovers pending delivery; a fork or unrelated
fresh Session consumes none of the source Agent's pending changes.
`PI_TEAMS_TASK_POLL_MS` controls local-spool fallback rescans and defaults to
30000 milliseconds; it never causes a periodic Beads list.

Delivery is at-least-once until Pi stages the custom context and completes a
non-error/non-aborted assistant turn. An errored transport leaves the delivery
pending for same-Session restart. If Beads commits
before the separate delivery spool is written, delivery start/restart
reconciles latest owner-addressed state plus durable targeted recovery records.
Successfully acknowledged versions leave exact Session-bound tombstones, so compaction cannot
make the reconciler echo settled work.

Direct external `bd` writes remain authoritative and queryable, but Alpha live
push covers PiTeams-mediated writes only; there is no per-Agent Beads polling.

When one teammate is finished, use:

```js
process_shutdown_approved({ team_name: "my-team", agent_name: "reviewer" })
```

For the whole team:

```js
team_shutdown({ team_name: "my-team" })
```

Whole-team shutdown attempts each teammate independently and deactivates only a
Membership whose terminal surface is confirmed gone, or whose exact
Membership-bound runtime record proves its process already exited. A failed
stop and the lead remain current, and the receipt identifies the failure for
retry. Shutdown never performs global age-based Pi-core session deletion. It
retains the team configuration, Beads authority, and any legacy task files as
migration evidence, so Task data remains queryable after the panes close.
`cleanup_agent_sessions` reports old folders as review candidates but deletes
none because age alone cannot prove that another long-running team or process
is inactive.

## Legacy tasks and Beads cutover

Historical PiTeams versions stored per-task JSON under `~/.pi/tasks/<team>/`
with numeric local IDs. Current runtime code never reads or writes those files
as a Task backend: an unmigrated Team fails closed until the one-time migration
records `taskBackend: "beads"`, an absolute `taskWorkspace`, a stable
opaque `taskAuthorityId`, a versioned `taskAuthorityFingerprint` containing the
non-secret Beads project/database identity, and durable cutover evidence.
The workspace itself must be an initialized Beads 1.1 root: a `.beads` found
only in an ancestor is a different authority and is rejected before any write.

Run migration outside Pi with:

```sh
npm run migrate:tasks -- <team-name> <absolute-beads-workspace> [report-path]
```

The helper inventories and hashes legacy files, imports/reconciles by
`pi_teams_legacy_id`, maps task fields and dependencies, reconciles the result,
and flips authority only after successful reconciliation. Pre-cutover drift
blocks the flip until an explicitly reviewed operator override is recorded.
Interrupted migration can be rerun. After cutover, changed or newly created
legacy files are orphaned old-client writes and are never imported
automatically; mixed old/new writers are not a supported steady state. A
post-cutover rerun must name the exact configured workspace. It reconciles the
persisted legacy-to-Beads mapping and fails closed if the supplied path differs
or that authority workspace is unavailable. It requires the preserved
`taskAuthorityId` and fingerprint, and never silently mints a replacement
identity or rebinds to a different valid database at the same path.

For Beads writes after cutover, `expected_version` is optional and enforced
when supplied. It is a digest of the canonical authority snapshot rather than
Beads' second-resolution timestamp. Beads 1.1.0 does not provide true CLI
compare-and-swap, so this is a serialized preflight rather than a guarantee
against an external race. If Beads is unavailable, malformed,
times out, rejects the task's scope, or reports a conflict, the tool fails and
does not write legacy files.

Beads maps `pending` and `planning` to open issues with PiTeams metadata,
`in_progress` directly, and `completed` to closed. Plans, progress, and
pending problems use namespaced metadata/comments. `deleted` is soft deletion
in Beads, preserving history.

After Beads-cutover shutdown, read the preserved team configuration to obtain
the absolute workspace, then query it directly:

```sh
bd --directory <taskWorkspace> --json list --label pi-teams:<team-name> --all --no-pager --limit 0
bd --directory <taskWorkspace> show <beads-id> --long --include-comments --include-dependents
bd --directory <taskWorkspace> graph --dot <beads-id> > task.dot
bd --directory <taskWorkspace> graph --html <beads-id> > task.html
```

`--all` retains closed history in the list. `bd graph --all` is an open-work
view, so graph a specific ID when closed dependencies matter.

## Completion hook

The supported hook is `.pi/team-hooks/task_completed.sh`, relative to the
current Pi process working directory. When a task is completed, PiTeams passes
the task record as JSON in the hook's first argument and sets `PI_TEAM` to the
team name.

`BeadsTaskStore` invokes this hook when an open Task transitions to closed
through completion. Hook errors are logged and do not reverse the Task
mutation, so the hook is notification/automation rather than a transactional
quality gate.

```sh
#!/bin/sh
# .pi/team-hooks/task_completed.sh
printf 'completed: %s\n' "$1" >> .pi/completions.log
```

## Templates

Templates are discovered from global and project files:

- global teams: `~/.pi/teams.yaml` (with the historical
  `~/.pi/agent/teams.yaml` fallback);
- project teams: `.pi/teams.yaml`;
- global agents: `~/.pi/agent/agents/*.md` or `SKILL.md` directories;
- project agents: `.pi/agents/*.md` or `SKILL.md` directories.

Use the listing tools before creating a template-based team:

```js
list_predefined_teams()
list_predefined_agents()
create_predefined_team({
  team_name: "review-team",
  predefined_team: "security-review",
  cwd: "/absolute/path/to/project"
})
```

`create_predefined_team` attempts every agent and returns per-agent results;
one missing or failed definition does not necessarily prevent other agents
from being attempted. Agent definitions can provide prompts, models, thinking
levels, and Pi tool allowlists.

To reuse a runtime team:

```js
list_runtime_teams()
save_team_as_template({
  team_name: "my-team",
  template_name: "security-review",
  scope: "project"
})
```

Saving requires at least one spawned teammate. `scope: "user"` (the default)
writes under `~/.pi`; `scope: "project"` writes project-local definitions.

## Terminal adapters

The adapter registry checks `tmux`, Zellij, cmux, iTerm2, WezTerm, then
Windows Terminal. All can provide panes. Only cmux, iTerm2, WezTerm, and
Windows Terminal report separate OS-window support, so window flags can fail
on tmux or Zellij.

- **tmux:** requires `TMUX`; pane kill and liveness are supported; no OS
  windows.
- **Zellij:** requires `ZELLIJ` outside tmux; panes use `--close-on-exit`, but a
  synthetic pane ID cannot confirm explicit shutdown. The tool fails closed and
  keeps Membership current until the process is closed manually.
- **cmux:** requires `CMUX_SOCKET_PATH` or `CMUX_WORKSPACE_ID` outside tmux and
  Zellij; it manages surfaces and OS windows through the `cmux` CLI.
- **iTerm2:** requires macOS iTerm2 outside tmux and Zellij; AppleScript manages
  panes and windows.
- **WezTerm:** requires `WEZTERM_PANE` and a working `wezterm` CLI outside tmux
  and Zellij; it can kill panes and closes a spawned window by killing its
  panes.
- **Windows Terminal:** requires Windows, `wt` at spawn time, and PowerShell.
  Pane/window IDs are synthetic; direct terminal kill and reliable liveness
  queries are unavailable. Shutdown fails closed and keeps Membership current
  until manual process closure. PiTeams never kills a PID from durable state
  alone; exact Membership-bound runtime evidence can only prove that the
  recorded process already exited. `check_teammate` liveness remains advisory.

Run Pi in the terminal environment you intend to manage. If no adapter is
detected, use task and messaging tools without spawning, or configure a
supported adapter before spawning.

## The 20 registered tools

`team_create`, `spawn_teammate`, `send_message`,
`broadcast_message`, `read_inbox`, `task_create`, `task_submit_plan`,
`task_evaluate_plan`, `task_list`, `task_update`, `team_shutdown`,
`cleanup_agent_sessions`, `task_read`, `check_teammate`,
`process_shutdown_approved`, `list_predefined_teams`, `list_predefined_agents`,
`create_predefined_team`, `save_team_as_template`, and `list_runtime_teams`.
