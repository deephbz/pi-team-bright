# Accepted-start validation correction

The first accepted-start adapter treated `agent: "pi"` as required evidence. A live protocol-17 canary disproved that rule. The server returned `agent_started`, exact name, pane, terminal ID, canonical Pi argv, and `launch_pending: true`, but screen detection was still unknown and omitted `agent`.

The corrected contract separates server managed-start evidence from optional detected kind. Accepted mode requires the exact target, canonical Pi argv, and pending or interactive state. It accepts a missing detected kind. If a detected kind is present, it must be `pi`.

Legacy ready fallback remains stricter. It requires the exact target, canonical Pi argv, `agent: "pi"`, and `interactive_ready: true`.

Tests cover the live pre-detection shape, contradictory kind, malformed argv and target, fallback, and exact-pane cleanup. Architecture impact is none.
