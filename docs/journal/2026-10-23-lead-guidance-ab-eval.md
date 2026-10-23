# Lead guidance A/B eval (Decision 0025)

Stage: hardening. Architecture impact: none.

## Setup

- Before: PTB `7293673` plus the pre-change Agenciples guidance. After: this
  branch's guidance and Alert `interrupt`, plus the revised Agenciples guidance.
- Real Pi 0.83 Teams on tmux. Claude Opus 5.5 lead (medium thinking), Claude
  Haiku 5.5 Workers. Each run had an isolated home, tmux server, and git workspace.
- Three fixtures, each with a hidden grader: a data-cleaning analysis (125k rows,
  11 questions), an offline research review (53 documents, 10 questions), and an
  R&D speed-up of a slow log pipeline (goal: under 30 s, output unchanged). Each
  had one impossible request, a status question at minute 4, and a correction at
  minute 8 or 9.
- Five valid pairs: data ×2, research ×2, R&D ×1.
- Limit: the API key allowed about two concurrent requests. A local gate queued
  the rest, so parallel work could not shorten elapsed time.

## Results

| | Before | After |
| --- | --- | --- |
| Hidden-grader score | 1.0 in 5/5 | 1.0 in 4/5; 0.5 in R&D |
| Mean Tasks per run | 4.2 | 5.6 |
| Worker output tokens | baseline | about +30% |
| Elapsed time | baseline | 5–20% longer in every pair |

A blind judge (Claude Opus 5.5) scored all 40 owner-facing replies, 1–5:

| Rubric item | Before | After |
| --- | --- | --- |
| Blocked request named, with alternatives | 3.75 | 4.15 (5.0 on final reports) |
| Clear request states | 3.55 | 3.65 |
| Progress framed against goals | 3.25 | 3.35 |
| Low internal detail | 2.50 | 2.55 |
| Self-contained | 3.15 | 3.15 |

## Findings

- Blocked framing improved consistently. The after lead named the blocker and
  offered options; the before lead asked for permission.
- Internal detail stayed high in both arms (commit hashes, file lists,
  verification mechanics). The skill now lists these exclusions explicitly.
- The R&D after run made an unrequested rounding change that altered output for
  79 users. The skill now limits repair and hardening to what the request or a
  failing check requires. With one pair, attribution to the guidance is unproven.
- Not exercised: speculative starts (both arms already overlapped analysis with
  cleaning) and interrupting Alerts (Teams finished before each correction).
  Measuring the speed benefit needs higher API concurrency.
