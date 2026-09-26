# 0015 — One model-role catalog for Worker creation

Date: 2026-09-26
Status: accepted; implemented and verified; unreleased

## Decision

A named model role owns a qualified `provider/model-id` reference, requested
thinking level, and usage guidance. `model_roles` is the single configuration
map. `default_model_role` is one reference into that map. Worker creation uses
`model_role`; explicit and omitted selection resolve through the same contract.
Worker scope, Task goals, and leader/Worker authority remain separate concepts.

The combined model reference removes duplicated provider/model spelling while
preserving exact provider identity. Later slashes belong to the model ID.
Internal parsed bindings are derived creation evidence. Settings edits cannot
change an existing Worker's binding. Pi Session history owns continued runtime
selection, including a human override.

## Invalid configuration and upgrade

Invalid configuration produces a human-only startup warning and a specific
refusal when an operation depends on it. Startup continues. A failed explicit
selection or broken default never chooses another model. Trusted-project entries
replace complete global entries; invalid overrides cannot expose old global
values. Independent valid roles remain usable.

This is a breaking replacement for Decision 0014's profile names and raw-model
fallbacks. New Worker creation has no Team-default, Worker-default, or native-Pi
fallback. Existing records and Session logs remain intact. Legacy Teams with raw
defaults receive a transition refusal for new Workers. Finish live Teams under
the original version, then create new Teams with the new settings.

One packaged example at `docs/examples/pi-team-bright.settings.json` owns the
copyable setup journey. README, warnings, and tool guidance link to it. The
executable settings validator owns schema validity. The example does not define
another runtime policy.

## Reversal and verification

Revisit this boundary if real work requires model roles to own Worker behavior,
or requires model changes within one retained Worker context. Neither need is
established by a model alias or a Task label.

Verify default/explicit equivalence, trusted override failures, absence and
invalidity, obsolete-key guidance, exact model lookup, supported thinking,
historical reuse, human-override recovery, warning isolation and reload repair,
and example availability in an installed package. Verification results belong
in the implementation result record.
