# 0009 — Initial model-tool journey

Status: accepted for the new-surface end-to-end delivery

The first public journey is:

1. an unbound Session calls `team_create({ name, purpose })`;
2. its exactly bound leader calls `ensure_worker({ name, scope })`; and
3. the leader calls `team_sync({ view: "snapshot" | "updates" })`.

The Team and leader are long-lived. A Worker owns one relatively short-lived,
semantically deep area. Assigned Tasks remain the only executable work
authority. Later leader calls resolve the active Team from exact Session binding
and do not accept a model-visible Team locator.

Model results default to minified, named JSON. The internal result-projection
function is identity-only for the initial delivery. Alternative encodings are
deferred experiments and cannot change tool semantics, extension features, or
domain behavior.

The public schemas preserve stable intent while preliminary executors, ports,
carrier mechanics, persistence choices, and optimization can change behind
them. The candidate source is
[`src/model-tool-contract/catalog.ts`](../../src/model-tool-contract/catalog.ts),
and current intent and reversal conditions remain in the
[model-tool contract Project](../projects/model-invoked-tool-contract.md).

Reconsider this decision only when an end-to-end leader workflow cannot create,
staff, or observe one Team through these calls, or measured evidence shows that
named JSON prevents safe operation at realistic scale.
