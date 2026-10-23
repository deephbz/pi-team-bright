# 0025 — Elapsed time as the cost, fluid delegation, and three request states

Date: 2026-10-23
Status: accepted (owner decision 2026-10-23); guidance, plus one runtime addition (Alert `interrupt`)

## Context

The lead treated Workers as a budget: the skill said more active Workers help
only "within the same budget". It always delegated, even a lone task that needed
the whole picture. It reported Worker-level detail that the owner had not seen
and could not act on.

## Decision

### Cost model

Workers and compute are cheap. Elapsed time and the owner's attention are scarce.
Parallel is the default; serial work needs a named reason. The lead also
speculates on success: when B and C are worthless unless A succeeds, it starts all
three. B and C state their assumption about A and carry no `needs` edge on A. An
integration Task needs all three. If A fails, the lead drops B and C from the
graph, which supersedes their Attempts. Irreversible effects still wait for real
inputs. Hard limits still bind: host capacity, locks, rate limits, the lead's
turn, and the owner's review.

### Fluid delegation

The lead delegates while several Tasks are in flight or more work is visible. It
works directly on a lone high-leverage, high-stakes Task that needs the whole
picture. Team updates arrive as follow-ups, so direct work runs in one-turn
slices, and the lead hands it off as a Task when new work arrives. The lead never
queues a Task behind a busy Worker. Repair never waits for a busy builder. The
lead interrupts the builder when the fix outranks the builder's current work.
Otherwise it gives the repair to a fresh Worker or does it itself, by judgment in
the moment rather than a fixed preference.

### Interrupting Alerts

A leader Alert takes `interrupt` (default false). When true, the recipient's Pi
aborts its current operation so the Alert is presented at once. Only the leader
may set it. An Alert still never changes Task state: the urgent work is a Task in
the graph. The interrupted Worker blocks its current Task with preemption
evidence, claims the urgent Task, and resumes afterward. The runtime refuses a
claim only while another Task is `in_progress`.

### Owner reporting

Every owner request is Delivered, Blocked (with actionable alternatives), or In
progress. Blocked covers a request that rests on a wrong understanding, has a
better alternative, or is stopped by a real blocker. Reports state goals,
constraints, and the changes that moved toward the goal or blocked it. Numbers
are sized against the goal. Every question carries its own context.

### Layer boundary

The general cost model and the audience principle (complete briefs for agents,
short self-contained messages for humans) belong to the owner's Agenciples
principles. PTB owns all delegation guidance and the Task, Worker, and turn
mechanics. PTB restates the premise in one sentence, because it cannot assume
Agenciples is installed.

This refines [0017](0017-delegation-boundary-and-second-opinion.md): the lead may
now execute, not only delegate facts and form opinions.

## Sources

- Procedure: [`skills/pi-team-bright/SKILL.md`](../../skills/pi-team-bright/SKILL.md),
  in the sections on choosing owners, choosing who executes, planning early
  starts, and reporting to the owner.
- Entry-point protocol: [`AGENTS.md`](../../AGENTS.md).
- Speculative drop: `attempt_superseded` with reason `graph_revised` in
  [`graph-control.ts`](../../src/task-authority/graph-control.ts).

## Verification and reversal

Guidance has no unit test. Verify in real Team runs:

1. A speculative branch is dropped after its premise fails.
2. A lead works directly and then hands off.
3. A repair interrupts a busy builder.
4. An owner report uses the three states.

Unverified: whether a superseded Attempt's Worker stops promptly. A Worker that
keeps working blocks its next Task, which works against "never queue".
