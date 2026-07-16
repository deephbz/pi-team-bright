# Operating PiTeams

Status: maintained current context.

This guide describes the normal Team workflow. Use
[the reference](../reference.md) for every tool parameter and result detail.

## Start a Team

Install the project release with Pi's Git installer using this repository's
release URL and tag. Run Pi in a supported terminal environment before spawning
teammates.

Create a Team, then spawn named teammates. Use an absolute `cwd` so the
teammate's working location is unambiguous; the tool accepts a string and the
terminal adapter performs the launch.

```js
team_create({ team_name: "review" })
spawn_teammate({
  team_name: "review",
  name: "reviewer",
  prompt: "Review the changed files and report concrete findings.",
  cwd: "/absolute/path/to/project"
})
```

A spawn receipt proves durable Membership creation, terminal launch, and
initial Message acceptance separately from runtime readiness. Diagnose a
suspected startup failure with `check_teammate`; do not use it as routine work
progress polling.

Run every live member of a Team on one PiTeams version. To upgrade an Alpha
Team, stop the whole Team, complete any required Task migration outside Pi, and
restart all members on the same version.

## Coordinate Tasks

Create a Task with durable intent, then use `task_update` for its work state,
assignment, design, or notes. The status values are `open`, `in_progress`,
`blocked`, and `closed`. Use `task_list` to find current work and `task_read`
when the complete authority snapshot or a version token is needed.
Mutation receipts already contain the resulting Task identity and version, so
do not immediately read the same Task again.

Simple work can move directly to execution. For complex or high-risk work, put
the review request in Task prose, have the worker add a design and send a
Message naming the exact Task version, then approve with a conditional
`task_update` to `in_progress`. Review is a convention, not a separate Plan
entity or a default mechanical gate.

## Communicate inside the Team

Use `send_message` for one current member and `broadcast_message` for the
current Team roster. Messages are for substantive coordination; avoid
acknowledgement-only traffic unless semantic confirmation is required.

PiTeams communication is limited to direct messages and broadcasts among
current members of one Team. Leader-to-leader messaging across Teams and
communication between agents outside a Team are out of scope.

Accepted Messages arrive through native custom delivery. Use `read_inbox` only
to inspect history or audit a specific inbox, never to fetch normal delivery.

## Recover and shut down safely

A killed Pi process is not a Team shutdown. Resume its exact Pi Session with
`pi -r` to restore the relevant lead or teammate identity. Do not create a
fresh Session to replace an incomplete Membership; either resume its recorded
Session or explicitly respawn it.

Use `teammate_shutdown` for one teammate and `team_shutdown` for a whole Team.
Both fail closed when the terminal surface cannot be safely confirmed stopped.
`report_stale_agent_sessions` identifies old Pi-core session folders for human
review and never deletes them.

## Task authority and migration

New Teams initialize a Team-owned Beads workspace unless an explicit,
already-initialized workspace override is supplied. Historical JSON Task files
are one-way migration evidence, not a fallback runtime backend. Run the
migration command only outside Pi:

```sh
npm run migrate:tasks -- <team-name> <absolute-beads-workspace> [report-path]
```

After shutdown, read the retained Team configuration for `taskWorkspace` and
query that Beads authority directly. The reference documents the migration
checks and post-shutdown queries.

## Templates, hooks, and terminal limits

Use the template listing tools before `create_predefined_team`. Use
`save_team_as_template` with `dry_run: true` before writing reusable
configuration. A closed Task can invoke `.pi/team-hooks/task_closed.sh`; hook
failure is logged and does not reverse the Task transition.

Terminal adapters differ in whether they can open windows or prove that panes
have stopped. Check the terminal section of [the reference](../reference.md)
before relying on a platform-specific lifecycle action.

## Record material changes

Update this page and the other [current-context pages](README.md) when the
maintained contract changes. Record accepted choices in
[decisions](../decisions/) and material observations in
[the journal](../journal/); neither replaces source, tests, or Task authority.
