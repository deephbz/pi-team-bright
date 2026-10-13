# Decision 0023: Recover received Alerts through the team_sync snapshot

Date: 2026-10-13
Status: accepted (owner request 2026-10-13; bound chosen by the lead under the owner's delegation)
Architecture impact: **none**. The model-facing snapshot result gains one field. Storage, authority and data flow do not change.

## Context

HyperCarrier Decision 0030 (item 6) makes a compacted lead recover Team state
from its own summary plus `team_sync`. Decision 0020 already makes the lead
request a snapshot after compaction. A snapshot restores Workers and Tasks.
It did not restore received Alerts: the snapshot result had no Alert field,
and `updates.alerts` was always empty. A clarification that a Worker sent
before compaction was lost unless the summary kept it.

Each accepted Alert has two records:

- The recipient inbox record. It names the exact recipient Membership and the
  sender, and it stores the rendered Alert envelope and a summary.
- The Team journal `alert` event. It names the recipient only as a name or `*`.
  It has no recipient Membership or epoch. It cannot show which recipients of a
  broadcast accepted it. `sendAlert` appends it after the inbox write, so a
  failed append leaves an accepted inbox record with no event.

The owner asked for a model-facing read that reuses the inbox storage, adds no
new store and nothing specific to compaction, and keeps the 0.24 scope rule:
low coupling, and no large complexity for rare cases.

## Decision

1. The `team_sync` snapshot result gains `alerts` and `alerts_omitted`.
   `alerts` lists the Alerts that the caller's exact current Membership
   received, newest first. The source is the caller's inbox. A non-consuming
   Alert-authority query reads it, so recovery never marks an Alert read,
   starts a delivery or changes a Task.
2. Each row gives `alert_id`, `from`, `kind`, optional `task_id` and
   `task_version`, `received_at` and `text`. `task_version` is the version the
   sender named; it is history, not current Task state.
3. Bound: the newest 10 Alerts. Each `text` is a preview of at most 2000
   Unicode code points. A cut row sets `truncated: true` and `text_length`.
   `alerts_omitted` counts older received Alerts that the bound left out.
4. The view is "recent", not "open". PTB records no resolved state for an
   Alert, and `read` means delivered, not acted on. The field description says
   this, so a lead does not treat the list as a to-do queue.
5. `updates.alerts` stays empty. Direct delivery presents new Alerts as
   messages. An Alert can arrive both in a snapshot and by a pending direct
   delivery after compaction; the shared `alert_id` identifies the duplicate.
6. The human sees the bound. The collapsed snapshot line names the Alert count
   and the omitted count. The expanded view shows one line per Alert.
7. Preview-only recovery: no read path returns the full text of a cut Alert or
   an omitted Alert. If the cut part matters, the lead asks the sender.
8. An inbox decode failure leaves Workers and Tasks available in the snapshot;
   the result reports `alerts_unavailable` with the read error.

## Consequences

- A compacted lead recovers recent clarifications and attention requests with
  one call it already makes.
- The worst case adds about 20,000 characters of Alert text to one snapshot.
- Inbox records from before exact Membership addressing do not appear.
- The rendered envelope format becomes an input that the Alert authority
  parses. The parser stays inside the Alert authority, next to the code that
  renders the envelope.

## Evidence that would reverse this

- A lead loses a decisive instruction that was past the 2000-point cut or
  older than the newest 10. Then add a bounded exact read by `alert_id`.
- Snapshot size measurably hurts lead context in real Teams. Then lower the
  bound.
- PTB gains a resolved state for Alerts. Then filter to unresolved Alerts.

## Sources

- HyperCarrier Decision 0030 item 6 (owner, 2026-10-13).
- Product and systems observer shaping reviews, 2026-10-13. The systems review
  showed that the journal cannot prove exact-Membership receipt. The product
  review asked for a visible bound and the Task version.
