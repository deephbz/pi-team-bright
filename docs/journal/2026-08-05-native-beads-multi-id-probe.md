# Native Beads multi-ID probe

Date: 2026-08-05
Status: completed isolated diagnostic; not a production change or a capacity claim.

Machine-readable evidence is
[`2026-08-05-native-beads-multi-id-probe.json`](artifacts/2026-08-05-native-beads-multi-id-probe.json).

## Scope and provenance

A fresh disposable Pi agent ran the native experiment through Herdr after an
initial `herdr agent list`, `agent get`, and `agent read --source
recent-unwrapped` check. `HERDR_ENV=1` was set. The agent used the owned
`@beads/bd@1.1.0` executable. It reported Beads build `8e4e59d39f34`, Node
`v25.6.0`, and Darwin arm64. The source report recorded Pi Team Bright
`0.17.0-rc.5` at `27a532d1c9c9696afe3790c081028aae8af77d76`.

All records lived in a new disposable authority with isolated HOME and XDG
paths. Fixture writes used `--sandbox`; every query used `--readonly`. The
agent did not call Pi Team Bright tools during the native probe and did not
access a live Team authority. It removed that authority after measurement.

A second fresh Herdr Pi agent loaded the explicit current rc.5 source extension
in another disposable authority. That source tree had concurrent uncommitted
implementation changes, so its trace proves command shape only. It does not
prove a release performance result. The second authority was also removed after
collection.

## Exact native commands and outcomes

Fixture setup, all with exit status 0:

```sh
bd --sandbox init --non-interactive --skip-hooks --skip-agents --prefix probe
bd --sandbox create --id probe-open --title 'Open metadata record' --type task --priority 2 --metadata '{"team":"alpha","rank":7,"nested":{"flag":true}}' --silent
bd --sandbox create --id probe-related --title 'Related open record' --type task --priority 1 --silent
bd --sandbox create --id probe-closed --title 'Closed metadata record' --type task --priority 3 --metadata '{"team":"archive","rank":9}' --silent
bd --sandbox create --id probe-plain --title 'Plain open record' --type task --priority 4 --silent
bd --sandbox dep add probe-related probe-open --type blocks
bd --sandbox close probe-closed --reason 'probe fixture'
```

The query matrix was:

```sh
bd --readonly show probe-plain probe-related probe-open --json
bd --readonly show probe-open probe-missing probe-related --json
bd --readonly show probe-missing --json
bd --readonly show probe-open probe-open probe-related --json
bd --readonly show probe-open probe-closed --json
bd --readonly show probe-open probe-related --include-dependents --json
bd --readonly list --id probe-plain,probe-related,probe-open --json --limit 0
bd --readonly list --id probe-open,probe-missing,probe-related --json --limit 0
bd --readonly list --id probe-missing --json --limit 0
bd --readonly list --id probe-open,probe-open,probe-related --json --limit 0
bd --readonly list --id probe-open,probe-closed --json --limit 0
bd --readonly list --all --id probe-open,probe-closed --json --limit 0
bd --readonly list --all --has-metadata-key team --json --sort id --limit 0
bd --readonly list --all --metadata-field team=alpha --json --sort id --limit 0
bd --readonly list --all --id probe-open,probe-related --json --sort id --limit 0
```

`show` with found IDs exited 0, preserved positional order, preserved duplicate
IDs, and included closed records. A mixed missing request also exited 0: it
returned found records and named the missing ID on stderr. A missing-only show
exited 1 and emitted a JSON error object, not an array. It included detailed
dependency targets; reverse detail required `--include-dependents`.

`list --id` instead returned priority order, silently omitted missing IDs,
deduplicated IDs, and omitted closed records without `--all`. Its relation data
was compact edges, not target issue records. Both metadata filters exited 0.
Nested and numeric metadata kept their JSON types.

## Read timings

The agent discarded payloads, performed one warm-up, then used seven
round-robin warm trials. One show had a 343 ms median (339–519 ms). One
three-ID show had a 792 ms median (762–1,280 ms). One three-ID `list --all`
had a 301 ms median (290–415 ms). Three separate shows had a 1,044 ms median
(1,034–1,537 ms).

This supports one multi-ID show when detailed semantics are required. It does
not support replacing detailed hydration with `list`: missing, duplicate,
closed, order, and relation semantics differ.

## Small Team-sync probe

The second agent initialized only its disposable authority, created one Team,
created three unassigned fixture Tasks in a batch, then called snapshot
`team_sync` twice. The payload-free trace shows this exact native chain per
snapshot:

1. one Team-scoped `list`;
2. one multi-ID `show` for the three candidates.

The first nested command trace took 394 ms plus 905 ms. The second took 329 ms
plus 884 ms. Thus the native chain was 1,299 ms then 1,213 ms, with two native
CLI calls in each snapshot and no single-ID candidate reads. The agent's
manual outer wall readings were 5,538.87 ms and 8,782.15 ms, but they include
Pi tool-response overhead. The current trace lacks a parent operation ID, so
those values are not a Team-sync benchmark.

## Implementation consequence

Keep `list` for scoped candidate selection and one multi-ID `show` for detailed
hydration. A caller that batches `show` must still reconcile the returned IDs:
missing inputs do not create an error when at least one ID exists, and
duplicates remain duplicates. Do not infer that `list --id` is an equivalent
exact-read API. The next representative measurement needs outer-operation
correlation before it can attribute full `team_sync` latency.
