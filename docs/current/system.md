# PiTeams system

Status: maintained current context.

PiTeams is a Pi extension. Its public surface is 18 Pi tools; it adds no slash
commands. [The reference](../reference.md) is the normative parameter contract.

## Authority boundaries

PiTeams owns Team configuration, Membership generations, terminal lifecycle,
transient Message coordination, runtime observations, and the adapter that
requests native delivery.

Beads owns durable Task records after a Team uses the current Task authority.
PiTeams never falls back to historical JSON Task files at runtime. Pi owns the
durable Session used for Membership binding and is the harness that presents
custom Messages. A terminal adapter owns the operations available for panes and
windows.

These authorities remain separate. A runtime heartbeat is not Task progress; a
Message receipt is not a Task update; a custom delivery payload is not the
owner's durable record.

## Identity, lifecycle, and recovery

A teammate first binds through a single-use launch capability to an exact Pi
Session. Later process recovery resumes that Session, which restores its
Membership and refreshes the terminal/runtime binding. A fresh Session, fork,
stale Membership, or ambiguous lead binding fails closed instead of inheriting
mutable Team state.

Team creation, teammate spawning, shutdown, and template writes are lead-only.
Shutdown deactivates a Membership only after a terminal adapter confirms the
surface is gone or Membership-bound runtime evidence proves the process exited.
Historical Team configuration and Task authority remain inspectable after
shutdown.

## Delivery

Direct Messages and assignee-addressed Task changes are accepted by their own
authorities before PiTeams requests native custom delivery to the exact
recipient Session. Delivery is at least once until a successful assistant turn
acknowledges the presented record. Restart recovery targets the same Session;
forks and unrelated sessions do not consume pending state.

## Pi integration

When the current Pi Session is the exact current Membership of a Team, PiTeams
can prefix the Pi footer with the Team and role. Environment variables, a live
process, or a terminal pane alone are insufficient evidence. Details are in
[the footer compatibility note](../team-footer.md).

Supported terminal adapters and their pane/window limits are maintained in
[the reference](../reference.md#terminal-adapters-and-limitations). An adapter
capability is a request boundary: PiTeams rejects unsupported separate-window
requests and fails closed when it cannot safely prove a shutdown.

## Verification

Run `npm test` after changing the extension. The tests and the source are the
verification signal for this maintained context; a documentation claim alone is
not proof that the implementation still behaves this way.
