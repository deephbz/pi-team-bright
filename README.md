# pi-teams

PiTeams turns a Pi session into the lead of a coordinated software team. It
manages Team Membership, teammate terminal surfaces, transient inboxes, runtime
health, and a shared Task workflow. The extension registers 18 Pi tools and
adds no slash commands.

PiTeams communication is limited to direct messages and broadcasts among
current members of one Team. Leader-to-leader messaging across Teams and
communication between agents outside a Team are out of scope.

| iTerm2 | tmux | Zellij |
| :---: | :---: | :---: |
| <a href="iTerm2.png"><img src="iTerm2.png" width="300" alt="PiTeams in iTerm2"></a> | <a href="tmux.png"><img src="tmux.png" width="300" alt="PiTeams in tmux"></a> | <a href="zellij.png"><img src="zellij.png" width="300" alt="PiTeams in Zellij"></a> |

## Install

Install a release of this repository with Pi's Git installer, using the
repository release URL and tag that your Team will run. Keep every live member
of a Team on the same PiTeams version; upgrade a Team as one stopped-and-restarted
epoch rather than a rolling deployment.

## Quick start

Create a Team, launch a teammate with an absolute working directory, and assign
one Task:

```js
team_create({ team_name: "my-team" })
spawn_teammate({
  team_name: "my-team",
  name: "security-reviewer",
  prompt: "Review authentication code and report concrete findings.",
  cwd: "/absolute/path/to/project"
})
task_create({
  team_name: "my-team",
  title: "Review authentication",
  description: "Inspect authentication handlers for unsafe input.",
  assignee: "security-reviewer"
})
```

A spawn receipt separates durable Membership creation, terminal launch, initial
Message acceptance, and runtime observation. A Task mutation receipt contains
its resulting authority version, so read again only when current state is
actually needed.

## Documentation

Start with the maintained [current context](docs/current/README.md):

- [Product and scope](docs/current/product.md) states the supported boundary
  and non-goals.
- [Domain](docs/current/domain.md) defines Team, Membership, Session, Task,
  Message, and delivery terms.
- [System](docs/current/system.md) records authority, lifecycle, delivery, and
  terminal boundaries.
- [Operations](docs/current/operations.md) explains normal use, recovery,
  migration, templates, hooks, and shutdown.

[The tool reference](docs/reference.md) is the complete public parameter
contract. [Decisions](docs/decisions/) preserve accepted product choices, while
the [journal](docs/journal/) records dated evidence and changes.

## Core behavior

- New Teams initialize a Team-owned Beads workspace unless an explicit,
  already-initialized workspace override is supplied. Beads is the sole runtime
  Task authority; historical JSON Task files require explicit one-way
  migration.
- Direct Messages and assignee-addressed Task changes are delivered to the
  exact recipient Pi Session after their owning authority accepts them. They
  are separate records and remain at least once until successful-turn
  acknowledgement.
- Team topology, lifecycle, and template writes are lead-only. Teammates keep
  the Task and Communication tools.
- `check_teammate` diagnoses runtime health; it does not prove Task completion
  or model readiness. Shutdown fails closed unless the terminal surface or
  Membership-bound exit evidence confirms the stop.

## License

[MIT](LICENSE)
