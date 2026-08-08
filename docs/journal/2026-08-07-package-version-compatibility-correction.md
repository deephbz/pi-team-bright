# Package-version compatibility correction

Date: 2026-08-07
Stage: hardening
Architecture impact: none

## Problem

Pi Team Bright persists the package release string as `TeamConfig.implementationVersion`. The current extension compares it with its own release string and refuses Team operations when they differ.

This compares build identity, not a persistence contract. Releases from rc.3 through rc.9 changed the string on every package release even when no Team or Beads storage change required migration. A compatible extension can therefore reject an existing Team only because the package changed.

## Correction

Package version must not decide Team compatibility. New Teams will not persist the package release string. Current code will tolerate the historical optional field and will not use it as a capability gate.

A future incompatible persistence change must name its actual schema or capability, define migration behavior, and test both supported and refused records. It must not reuse the npm package version as that coordinate.

Verification must prove that leader and Worker operations accept a historical package value, new Team creation omits it, and no mixed-version refusal remains in executable code or current guidance.

## Result

The durable leader port and direct leader/Worker tool paths now ignore the historical field. New model-tool Team creation passes no package provenance into `TeamConfig`. The parser and optional type remain only to read existing records without mutation.

Focused durable-port tests passed 28 tests. The Beads-backed historical-config test passed four tests and exercised leader Task creation plus Worker Task reads and updates. The fast aggregate lane then passed type-checking, 62 test files, and 503 tests.

One aggregate expectation changed from generic `no_active_team` to the exact `stop_not_confirmed` refusal. The old absent-version fence had hidden the stale-process safety path that the test intended to exercise. The corrected test still proves that no numeric PID is signaled and the Membership remains current.
