# Warm activation prototype plan

Date: 2026-08-14
Status: executing
Stage: exploration inside the Task-first hardening project
Architecture impact: none; this plan authorizes disposable benchmark code only.

## Question

Which process-retention mechanism reduces activation latency without breaking the
current Worker invariants?

The relevant distinctions are a logical Worker, Membership, OS process
generation, Pi Session, terminal pane, resource projection, and Task authority.
A warm carrier can be faster only if it does not let one process generation claim
two Memberships, expose leader tools before an exact Worker binding, retain an
old Worker resource projection, or turn carrier existence into readiness.

## Predicted outcomes

1. A persistent RPC process can replace its Pi Session faster than a new process,
   but `new_session` cannot change process cwd, launch environment, or the
   extension role selected during startup.
2. `AgentSessionRuntime.newSession()` can replace an SDK Session faster than a
   new Node process, but process-scoped extension state can survive. It cannot
   itself change terminal carrier identity.
3. A reserved Herdr pane can make later in-pane command activation fast. It
   cannot safely become a Pi Team Bright Worker without a new process because
   Worker identity, CLI resource projection, and Worker-only tool projection
   are set before the first `session_start` hook.

A result that contradicts one prediction is a decision-reversing signal.

## Experiment graph

The canonical machine-readable graph is
[`benchmarks/warm-activation/plan.json`](../../benchmarks/warm-activation/plan.json).

`launch configuration -> cold process/session -> probe record -> latency sample`

`live process -> session replacement or activation command -> probe record -> warm sample`

`probe records + process exits + tool surfaces -> invariant assessment -> ranked decision`

## Mechanisms and probes

The benchmark will use isolated temporary Pi homes, sessions, project cwd
fixtures, and probe records. It will never create a Team or mutate a production
Team directory.

- **Persistent RPC replacement:** start a local package Pi RPC process, verify
  the first Session, then issue repeated `new_session` calls. Measure process
  start-to-state as cold and request-to-response as warm. Test session identity,
  model/thinking projection, cwd/context marker, extension resource presence,
  current tool surface, direct-RPC cancellation, crash/restart, and shutdown.
- **In-process SDK reuse:** create an `AgentSessionRuntime` with a controlled
  project resource loader, then call `newSession()` repeatedly. Measure initial
  construction and replacement. Test Session replacement, resource and cwd
  projection, closure versus module state, runtime disposal, and retained
  process state.
- **Reserved Herdr carrier:** create a new background pane from this Worker's
  exact pane, start a no-Task probe Pi agent, and invoke a local extension
  command in the live carrier. Measure split/start as cold and command receipt
  as warm. Test that no Team/Membership environment exists, record whether the
  current tool surface contains Task or leader tools, then close only the pane
  created by the probe. The runner records unsupported or unsafe operations as
  results rather than forcing a binding.

The probe records a boolean or a test fixture label for cwd and resources. It
does not persist home paths, credentials, prompts, provider payloads, or Team
contents.

## Verification and interpretation

Each sample has a monotonic start/end timestamp, a mechanism, phase, outcome,
and probe ID. The raw machine result includes every sample, environment versions,
source commit, parameters, process exit data, and cleanup outcome. The derived
result calculates nearest-rank p50 and p95 from successful samples only, while
showing failed or unsupported samples separately.

An activation claim needs both a timing measurement and an invariant probe.
Timing alone is not evidence that a carrier is a Worker. A successful command
inside a reserved pane is evidence only for that command; it is not a
Membership binding, runtime observation, readiness, or Task claim.

The planned decision order is:

1. Prefer no production mechanism if any warm path fails exact role, resource,
   Session, or process-generation isolation.
2. Rank supported prototypes by warm latency only after they pass their stated
   probe limits.
3. Propose a production seam only if the fastest supported path preserves the
   existing one-process-per-Membership and Task-first contracts without an
   implicit role transition.

## Reproduction and cleanup

The committed source bundle will contain the runner, probe extension, plan,
readme, and a redacted result artifact. Raw temporary records remain outside
Git. The runner uses a private temporary directory, sends no model prompt, and
removes child processes and panes it starts. If cleanup cannot prove a child
exit or pane close, it records a failure and stops further destructive actions.
