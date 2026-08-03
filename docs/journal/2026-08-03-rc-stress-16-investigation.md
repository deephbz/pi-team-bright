# rc-stress-16 generic execution-error investigation

Date: 2026-08-03
Team: `rc-stress-16`

## Decision

The reported generic message is an old-version-only renderer artifact. The
Team config records implementation `0.17.0-rc.2`. The rc.2 TUI renderer mapped
every Pi Team tool result with `isError: true` to the same generic semantic-
result line. It discarded the exact `content` and `details` that Pi persisted.

The available Session records contain no Pi Team tool result with `Invalid
semantic result` or `Invalid model projection`. Thus, the reported message did
not identify a semantic-result validator failure.

The rc.3 renderer repair already on `main` preserves copyable raw `content` and
`details`, identifies the tool and error class, and warns the operator to check
sensitive fields before sharing. Its focused test also forbids the old generic
phrase (`src/model-tool-contract/result-projection.test.ts`). No new product
repair is required for this report.

## Evidence and counts

The Team config references one lead and 16 Workers. Sixteen Session files are
still present; the `latency-observer` Session file is absent. The analysis is
therefore exact for the persisted records and does not claim evidence from the
missing file.

Those records contain 539 tool results and 112 error results. Twenty errors came
from other Pi tools. The rc.2 candidate renderer handled the remaining 92 Pi
Team errors:

- 65 `task_update` errors;
- 22 `task_read` errors;
- four `team_sync` errors;
- one `team_shutdown` error.

The first Pi Team error occurred at `2026-08-03T14:01:17.274Z`. A Worker sent
`claim=true` and `status=in_progress` in one `task_update`. The runtime rejected
that compound shape because claim is atomic (`src/utils/tasks.ts`). This pattern
occurred 28 times.

The other 64 errors were Beads timeouts: 55 `show`, eight `update`, and one
`list`. The first occurred at `2026-08-03T14:01:48.119Z`. These were real
Task-authority availability failures, not semantic projection failures.

The Team used embedded Dolt, while Pi Team Bright starts one external `bd`
process per authority command and applies a fixed 10,000 ms timeout
(`src/utils/beads.ts`). An isolated copy reproduced the contention tail: 32
parallel single-Task `show` commands all completed without the product timeout,
but nine took more than 10,000 ms. The measured p50 was 6,928 ms, p95 was
16,843 ms, and maximum was 21,470 ms.

The machine-readable derived result and source-bundle digest are in
`docs/journal/artifacts/2026-08-03-rc-stress-16-analysis.json`. Raw Team and
Session records remain private in place.

## Verification

The focused rc.3 result-projection file passed eight tests. This includes the
raw error report and old-phrase rejection. The durable model-port file passed
six tests. Its new regression proves that failed event consumption does not
advance the persisted hidden watermark, and a later complete read can recover.
The derived JSON parsed successfully, and `git diff --check` passed.

## Scope

The rc.2 run remains useful evidence of compound-claim ergonomics and embedded
Dolt contention. It is not an rc.3 release gate because it loaded the old
extension. A new rc.3 stress run is required before making rc.3 capacity claims.
The owner confirmed that the observed generic messages came from the old
extension.

Architecture impact: **none**. This investigation changes no product authority,
boundary, dependency, data flow, persistence, or deployment contract.
