# Linux host probes A7 and A9

Stage: hardening. Architecture impact: none. Base: `9c7dd67` (0.24.0-rc.2).

The probes ran the production `probeProcessGeneration`,
`probeProcessGenerations`, `withLock`, and `writeJsonAtomic` modules. The
host was Ubuntu 24.04.4, kernel 6.8.0, x86-64, Node 22.22.2, ext4,
`CLK_TCK` 100, and pid_max 4194304. A9 also ran on macOS APFS. Fixtures:
`sim/fixtures/probes/A7.json` and `A9.json`. Lane:
[`scripts/probes/README.md`](../../scripts/probes/README.md).

## A7: PID reuse changes the Linux birth token

Verdict: holds, 3 of 3 trials.

- Each trial killed a `sleep`, saw `absent`, and forced the same PID back with
  `pidwrap`. Reuse took about 72 seconds.
- The reused PID had the same boot ID and a new `starttime` token. The batch
  path agreed with the single probe.
- The token matched an independent parse of field 22. A comm of
  `a) b (c 1 2` did not shift the field.
- A process owned by root was `found`. `/proc` had no `hidepid` option.

Limits:

- `starttime` has 10 ms resolution. Reuse within one tick needs a full PID
  wrap in 10 ms. This probe cannot reach that case.
- A zombie reads as `found` until its parent reaps it. A Pi process under a
  live shell is reaped at once, so PTB does not depend on this case.
- The macOS helper has no PID-reuse probe.

## A9: Filesystem behavior under process crash

Verdict: holds on Linux ext4 and macOS APFS.

| Check | Linux | macOS |
| --- | --- | --- |
| 16 processes × 200 increments under `withLock` | 3200 of 3200 | 3200 of 3200 |
| Lock held by a SIGKILLed owner | recovered after 30006 ms | recovered after 30000 ms |
| `writeJsonAtomic` under 150 random SIGKILLs: concurrent reads | 11079, no error | 40668, no error |
| Lost commit, regression, or unparsable file | 0 | 0 |
| Journal append (one write, fsync) under 100 SIGKILLs: torn lines | 0 of 311 | 0 of 258 |
| Orphan `.tmp` files after the kills | 96 | 69 |

Limits: no host crash, power loss, or fsync durability test. The journal check
mirrors the `appendTeamEvent` write path; it does not call that function.

## Finding: orphan temp files

Fact: `writeJsonAtomic` leaves its temp file when the process dies between
open and rename. No PTB code removes these files. Runtime readers select
`.json` names, so a temp file never becomes authority. One exception: the
manual stopped-epoch delivery migration
(`src/utils/task-delivery-migration.ts` `collectFiles`) reads every file in
`task-delivery/`. A leftover temp file makes it fail closed with
"not valid JSON" and the file name. Inference: a Team directory gains one small
file per such crash. Severity: low. No release change.

## Not covered

A full Linux Team with real Pi and Herdr has not run. Real scale is a separate
item.
