# PTB doctor command

Purpose: start agent-led diagnosis with the packaged repair guide and local
Team metadata. Scope: context injection; Team mutation stays with existing
operations. Base: `c5557ff`; formal hardening now follows the model-role and framework-sync
features at `70bfe4f`.

## Interaction design

1. The operator has a PTB failure and requests diagnosis.
2. The human initiates `/ptb doctor`; help stays side-effect-free.
3. The command owns diagnostic context collection and delivery.
4. Existing Team and Task stores retain authority; no setting is added.
5. The requesting Session and branch own the pending command.
6. One invocation captures its Session, branch, binding, and observation time.
7. The visible custom message records an observation, not a health guarantee.
8. The command handler collects and sends; owner changes invalidate late sends.
9. The model receives the guide and bounded allowlisted metadata on demand.
10. Human history shows the same message; a notification confirms queueing or submission.
11. There is no persistent status, widget, watcher, or background repair.
12. The existing extension entry registers a private command module.
13. Collection is local; partial read failures remain explicit observations.
14. Command tests, packed RPC, and a disposable TUI probe verify the surface.

Other PTB commands keep their current names. Architecture impact: none for
component ownership, storage, or deployment topology.

## Verification before feature integration

The full lane passed 1,085 tests across 152 active files, with four existing
skips. The 13 command tests cover held locks, missing and damaged records,
explicit unbound selection, field allowlists, follow-up delivery, owner changes,
and dispatch failure. Typecheck, test-lane closure, and package verification pass.

The packed extension loaded in Pi 0.87.1 from an unrelated working directory.
RPC reported the packed command's provenance. Help made no model request.
Doctor sent its guide and metadata to a local test provider in one request.
A separate 70-column TUI Session displayed the provider reply. These probes used
isolated state and no live Team or provider credentials. They verify command
interaction; they do not claim that an agent can repair every Team fault.

The change is committed separately from its hardening base. It is not installed
or published. Existing PTB commands retain their names.

## Integration regression

Adversarial command tests reproduced late context submission after tree
navigation or compaction began while the guide was loading. Both pre-events
now invalidate the pending request. Doctor reports sampled Member-entry counts
without deriving Team lifecycle from malformed records. All 16 focused command
tests pass. The integrated campaign owns the wider verification record.
