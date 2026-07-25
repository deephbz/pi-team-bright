# 0006 — Membership observation protocol

Status: accepted

PiTeams publishes `pi-teams-observation/1` as the read-only package subpath
`pi-teams/observation`. Its executable contract is
[`src/public/observation.ts`](../../src/public/observation.ts): canonical
TypeScript, JSON Schema, and `readObservationSnapshot` are the sole API spec.

The projection reports recorded Membership evidence, not OS liveness. It hides
producer file layout and excludes Task, message, prompt/profile, model,
terminal-content, argv, environment, usage, and Rarebit data. Consumers must
independently verify processes, terminal occupancy, and Session resolution.

Lead startup writes the same Membership-bound runtime evidence as teammates at
`runtime/team-lead.json`; `lead-session.json` remains private compatibility
evidence only. Producers atomically replace runtime records, while the public
projector neither writes nor joins producer locks: it samples config before and
after runtime evidence, retries one changed Team generation, and obeys one
total deadline plus AbortSignal. The accepted protocol plan is retained as
historical evidence outside this stable interface specification.
