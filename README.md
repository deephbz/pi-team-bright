# pi-teams

PiTeams turns a Pi session into the lead of a coordinated software team. It
manages Team Membership, Worker terminal surfaces, exact-Session delivery,
event-driven coordination, and a shared Task workflow. The extension registers ten Pi tools and
adds no slash commands.

Tasks plus exact assignees are the work protocol. Typed Alerts are limited to
exceptional clarification, attention, and lead announcements among current
members of one Team; they never assign, advance, or complete work.

| iTerm2 | tmux | Zellij |
| :---: | :---: | :---: |
| <a href="https://raw.githubusercontent.com/deephbz/pi-teams/main/iTerm2.png"><img src="https://raw.githubusercontent.com/deephbz/pi-teams/main/iTerm2.png" width="300" alt="PiTeams in iTerm2"></a> | <a href="https://raw.githubusercontent.com/deephbz/pi-teams/main/tmux.png"><img src="https://raw.githubusercontent.com/deephbz/pi-teams/main/tmux.png" width="300" alt="PiTeams in tmux"></a> | <a href="https://raw.githubusercontent.com/deephbz/pi-teams/main/zellij.png"><img src="https://raw.githubusercontent.com/deephbz/pi-teams/main/zellij.png" width="300" alt="PiTeams in Zellij"></a> |

## Install

Install a release of this repository with Pi's Git installer, using the
repository release URL and tag that your Team will run. Keep every live member
of a Team on the same PiTeams version; upgrade a Team as one stopped-and-restarted
epoch rather than a rolling deployment.

## Quick start

Create a Team, ensure a Worker with an absolute working directory, and assign
one goal-driven Task:

```js
team_create({ team_name: "my-team" })
worker_ensure({
  team_name: "my-team",
  name: "security-reviewer",
  profile: "Security reviewer who reports concrete authentication findings.",
  cwd: "/absolute/path/to/project"
})
task_create({
  team_name: "my-team",
  title: "Review authentication",
  description: "Inspect authentication handlers for unsafe input.",
  acceptance_criteria: "List every inspected handler and provide a reproducer or explicit clean result.",
  assignee: "security-reviewer"
})
```

A Worker receipt separates durable Membership creation, terminal launch, and
runtime observation without implying readiness. A Task mutation receipt
contains its resulting authority version. Use `team_sync` to block on Team and
Task events rather than polling runtime state or terminal output.

## Documentation

Start with the maintained [evergreen context](docs/current/README.md) for the
declared lifecycle stage, decisions still in force, current status,
constraints, and next steps. The [contract source map](docs/reference.md)
routes to executable schemas, types, implementations, and tests instead of
duplicating them in prose. [Decisions](docs/decisions/) preserve durable
rationale; the [journal](docs/journal/) preserves dated plans, observations,
and evidence.

## Core behavior

- New Teams initialize a Team-owned Beads workspace unless an explicit,
  already-initialized workspace override is supplied. Beads is the sole runtime
  Task authority; historical JSON Task files require explicit one-way
  migration.
- Assignee-addressed Task changes and typed Alerts are delivered to the exact
  recipient Pi Session after their owning authority accepts them. Delivery
  acknowledgement never means work completion; the Task remains authoritative.
- Team topology and lifecycle writes are lead-only. Workers can read and update
  Tasks, send Alerts, and block on `team_sync` events.
- Worker and Team shutdown fail closed unless the terminal surface or
  Membership-bound exit evidence confirms the stop.

### External Task projections

Task state remains directly queryable from the Team's Beads authority, so an
external service can build dashboards, reports, or alerts without adding to
the PiTeams agent-facing tool surface. Read `taskWorkspace` from the Team's
`config.json`, then use Beads' machine-readable CLI output:

```sh
bd --directory /path/from-taskWorkspace list --json
```

External views are recomputable projections; Beads remains the Task authority.

## License

[MIT](LICENSE)
