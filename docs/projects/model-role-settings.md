# Model-role settings implementation

Date: 2026-09-26
Status: implemented and verified; unreleased
Base: `0d4389d98cf5044bdd67b07fed82e01c304b6e9c`
Branch: `codex/model-role-settings`

## Accepted scope

The owner approved one model-role map, one default reference, one packaged
example, and non-fatal Pi startup diagnostics. The owner requested parallel
GPT-6-Sol implementation with independent verification. Product and systems
observers reviewed the design and final implementation separately.

[Decision 0015](../decisions/0015-model-role-settings.md) owns the accepted
selection and continuity contract. The [canonical example](../examples/pi-team-bright.settings.json)
owns copyable configuration. The [settings parser](../../src/utils/model-role-settings.ts)
owns validation. README owns upgrade instructions. This record owns completion
evidence and limits.

A model role selects execution settings. It does not define Worker scope, Task
responsibility, prompts, tools, skills, or leader/Worker authority. The qualified
term follows the owner's decision. The observers had preferred model profile to
avoid overlap with behavioral Role; qualification preserves that distinction.

## Delivered behavior

- `model_roles` maps names to `model`, `thinking`, and `use`.
  `default_model_role` references one name. `ensure_worker.model_role`, discovery,
  and Worker summaries use the same vocabulary.
- Exact model lookup splits the qualified reference at the first slash.
  Remaining slashes belong to the model ID. Pi validates supported thinking
  levels, including `max`. Launch uses separate model and thinking arguments.
- A new Worker captures one resolved binding before carrier creation. Explicit
  selection works without a default. An omitted or invalid selection fails
  before Worker creation. No raw Team, Worker, or native-Pi fallback remains.
- Reuse and retry preserve stored creation evidence. Same-Session recovery
  preserves Pi's recorded model and human changes. Legacy raw Team defaults
  block new Workers; they do not block existing Worker recovery.
- Trusted project roles replace whole global entries. Invalid entries cannot
  expose shadowed global values. Unknown project trust uses global resources.
- Pi startup uses the native warning notification and theme warning color, with
  the affected setting and installed example path. Repair and reload stop new
  warnings. Headless output stays bounded and preserves the protocol. Diagnostics never add messages to
  model context or call a provider.
- The npm package contains one canonical example. The complete example belongs
  in global settings. README identifies the supported project override subset.

Historical persisted profile fields and recorded release receipts remain intact.
They describe old creation evidence and are not a second settings authority.

## Verification

The first full run passed 1,048 tests and found four failures. Two older Worker
fixtures lacked the new required configuration and catalog. One assertion used
stale lifecycle wording. The compact tool-description budget caught an oversized
description. All four were repaired without relaxing the selection contract or
size budget; their focused checks pass.

Independent verification passed 20 tests across settings, runtime, and boundary
fixtures. It includes a legacy Team with a pinned Worker and no active Membership.
`python3 scripts/verify-model-role-startup.py` passed against isolated real Pi TUI
and RPC processes. The warning was visible, Pi remained alive, RPC output stayed
valid JSONL, and conversation message count stayed zero.

`npm run verify:package` passes. The packed package installs, exposes its public
observation API and TypeScript declarations, and contains the canonical example
with bytes equal to source. The superseded example is absent. Generated
declarations match the staged files. Typecheck passes.

The final full run passes: **149 files passed, 2 skipped; 1,052 tests passed,
4 skipped**. It used `vitest.full.config.ts` with the QA output directed to a
temporary artifact. Both independent observers found no material issue in the
final source review. Diff whitespace checks pass.
Test-lane closure reports 151 files: 128 fast and 23 exhaustive.

## Limits and architecture

No provider request, production Team launch, live settings migration, npm
publication, or parent gitlink adoption was performed. These checks establish
selection, startup, recovery, and package behavior. They do not establish an
authenticated model-generation canary.

Architecture impact: **changed** inside Pi Team Bright's public configuration
and Worker-selection contract. HyperCarrier component responsibilities and
topology remain unchanged. Its diagram keeps Pi Team Bright opaque, so this
change requires no parent diagram edit. The candidate remains unreleased.

Native warning presentation was verified with actual Pi 0.83 TUI and RPC
processes. The TUI used the theme's yellow warning color; RPC emitted a warning
notification and retained zero model-history messages. Reload shows current
settings issues again through Pi's standard framework notification path.
