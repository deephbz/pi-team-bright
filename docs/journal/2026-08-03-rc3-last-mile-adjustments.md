# Pi Team Bright rc.3 last-mile adjustments

Date: 2026-08-03

The owner added three final instructions before publication:

1. Raise the model-tool Task `goal` maximum from 160 to 1,000 TypeBox
   string-length units.
2. Keep successful human tool results concise and semantic, but show execution
   or result-projection failures as a clear, copyable raw `content` and
   `details` report. Do not replace the source failure with a generic missing-
   semantic-result message.
3. Keep work in this repository solo by default. Product and systems observers
   are optional unless the owner or an assigned Task explicitly requests them.

The goal limit is one Task-card contract across create input, raw Task cards,
and model Task-card projections. Boundary tests cover 160, 161, 1,000, and
1,001 units. The error renderer identifies the tool and error class, preserves
raw result data, and tells the operator to review sensitive fields before
sharing. Successful rendering remains allowlisted and compact.

Verification after these adjustments:

- focused catalog and result-projection lane: 2 files and 18 tests passed;
- TypeScript typecheck passed;
- generated contract HTML refreshed;
- agent-surface QA passed after the goal-schema change;
- tool-result QA passed after the error-renderer change and refreshed
  `artifacts/tool-result-qa/latest.json`;
- test-lane closure passed with 69 files: 51 fast and 18 exhaustive;
- packed observation package probe and generated-dist comparison passed;
- `git diff --check` passed.

The earlier exact-tree aggregate evidence no longer covers these last focused
changes. Do not repeat it locally. The required GitHub Actions dry-run and OIDC
publish workflow will run `test:full` on the final commit.

Architecture impact: **changed** at the existing public Task schema and human
result-projection contracts. No component, authority, dependency, data flow,
store, trust boundary, process boundary, or deployment topology changed. Keep
the Structurizr DSL unchanged.
