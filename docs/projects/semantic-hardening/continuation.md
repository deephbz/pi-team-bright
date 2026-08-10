# Semantic hardening continuation

Updated: 2026-08-10 after the Membership observation boundary.

## Owner contract

Keep public tools, schemas, exports, persisted records, filenames, ordering,
errors, timing, and default behavior stable. A behavior change needs an owner
decision, evidence, replacement tests, and its own commit. Work only in this
isolated Project worktree. Do not use the original checkout.

The additive read-only Membership observation boundary is complete. Alert and
Trio have proven accepted boundaries. Team and Task retain concrete reverse
dependencies, and Coordination lacks its accepted worker-run observation query,
so the five-target split remains open. Session, process, pane, delivery, locks, files, timers, and
traces remain support mechanisms, not authorities.

## Current source state

Accepted source commit `5950f3b3f17124b9baf38afa48d839dc503d847b`
(`refactor: isolate Membership observation reader`) follows Trio commit
`69c30acf5db23be8f656b2a6821b0ea032ae04cb`. It adds the private
`src/team-authority/membership-observation-reader.ts` as the only Team/runtime
filesystem decoder. Public `src/public/observation.ts` retains the existing
`pi-teams-observation/1` DTO, JSON Schema, package subpath, and projector.

The reader keeps lock-free config/runtime reads, sorted Team order, stored
Membership order, config/runtime/config retry, one total deadline, AbortSignal,
typed diagnoses, mixed-record compatibility, and privacy filtering. The public
module imports only the reader and package metadata. Core source imports of the
public module remain forbidden.

Focused evidence passed 22 tests in the public observation and reader test
files, TypeScript checks, package/export verification, generated-output checks,
static fences, and diff checks. The package probe kept the CommonJS and
TypeScript `@hypercarrier/pi-team-bright/observation` subpath. Generated output
adds the reader closure and removes unreachable observation-only runtime,
paths, lock, and trace closure files. The reader neither creates producer
artifacts nor repairs the separate Beads/Dolt resource-contention risk.

The canonical TypeScript-AST graph is 112 production files and 425 resolved
static import/re-export edges, with zero nontrivial SCC, self-cycle, or runtime
dynamic relative import. The 111-file/426-edge Trio graph is historical.

## Remaining gates

The Membership boundary is complete, but the structural split and Project
completion are not. Keep these gates open:

1. Replace Task direct Team helpers with the Task-owned current-membership
   resolver or an accepted narrow port.
2. Implement and inject the Coordination-owned worker-run observation query,
   then remove concrete Team/runtime/path reads from its observation paths.
3. Classify the Team worker-launch Alert delivery type edge as neutral DTO
   support, or move it behind an accepted Team-owned port.
4. Measure and repair Beads/Dolt hydration and list contention without weakening
   Task-version or snapshot meaning.
5. Stabilize one exact final tree, then run the reserved aggregate, privacy
   scan, and watchdog review. Keep release operations outside this Project.

## Proof limits

The completed structural evidence is deterministic and local. It does not prove
real Pi persistence, external Beads/Dolt contention, cross-process forks,
native watcher delivery, OS scheduling, external writers, terminal pixels, or
model interpretation. The Membership reader reports recorded evidence; it never
asserts OS liveness.
