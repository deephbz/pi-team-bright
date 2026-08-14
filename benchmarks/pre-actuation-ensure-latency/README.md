# Pre-actuation ensure latency benchmark

This disposable benchmark measures the current model-tool path from
`DurableModelToolTeamApplication.ensureWorker` entry through durable
`prepared` event publication. It stops at
`WorkerLaunchBridge.launchPreparedMembership` before its spawn callback.

Run it from the package root:

```sh
bun benchmarks/pre-actuation-ensure-latency/run.ts --samples 7 --load-width 4 --foreign-teams 32
```

The default result is
`docs/journal/artifacts/2026-08-14-pre-actuation-ensure-latency-results.json`.

Each child uses a fresh temporary home, Pi agent directory, project, Team, and
event journal. It calls the current application and bridge source. Bun module
mocks time selected imports but forward every measured operation to the actual
Team, resource, and event implementation. A fake terminal is used only to
prove terminal selection; the boundary rejects before a carrier can spawn.

The runner records three conditions:

- `isolated`: one ensure in one fresh Team;
- `loaded`: concurrent ensures for different Workers in one Team;
- `directory_loaded`: one ensure with unrelated valid Team records in the
  fresh home.

It also samples the current-profile `pi --list-models` helper separately. That
helper has project and profile inputs, so it is not merged into the isolated
source-coupled distributions.

A successful trace proves a current pending-launch Membership, a matching
prepared event, no Pi Session file, no terminal spawn, no pre-boundary Task
reconciliation, and owned aggregate cleanup. It does not prove terminal
actuation, Pi process start, Session binding, Worker readiness, Beads cost, or
full ensure latency.
