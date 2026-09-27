# Pi Team Bright promo

Status: final v7 schedule (90.6 s, reading budget 40/40), rendered with the shared brand into `out/pi-team-bright-promo.mp4`. `timeline.js` is the source for scenes, captions, and schedule; the storyline table below preserves the historical v2 plan.
Evidence base: this checkout at `1476140` (package `0.19.0` candidate; npm
`latest` is `0.18.0`).

## Thesis

**One lead. A visible team. Work you can prove.**

The audience runs agents in terminals and has tried parallel agents. They know
the pain: panes scroll, ownership is unclear, and "done" means "the pane went
quiet". The video shows that Pi Team Bright makes delegated work a durable
contract that the runtime schedules and the lead can prove.

## Selling points

Ranked by audience pull. Every claim has an anchor; do not show a claim
without one.

| # | Selling point | Anchor | Screen idea |
|---|---|---|---|
| 1 | **See every Worker.** Each Worker gets a named pane in the lead's tab. The lead keeps a fixed share; a deterministic 2×2 grid holds the Workers. | `src/utils/team-pane-layout.ts` (`leader_share`, `worker_tiling: "grid"`); `src/adapters/herdr-adapter.ts:227`; README "Candid limits" (Herdr and tmux enforce placement; iTerm2, Zellij, cmux, WezTerm, Windows keep their own placement) | Lead 40% left; four panes pop into a 2×2 grid on the right. Config: `{ leader_share: 0.4, worker_tiling: "grid" }` |
| 2 | **Declare the graph; the runtime runs it.** `needs` gives dependencies. `on_goal_failed` gives a bounded repair loop (1–8 traversals). The ready front runs in parallel, one Task per Worker at a time. | README "Mission graph semantics"; `src/task-authority/graph-control.ts`, `ready-dispatch.ts` | Fan-out DAG. Tokens leave graph nodes and land in the matching panes. |
| 3 | **Done means evidence.** A Worker closes a Task with `goal_achieved` or `goal_failed` plus evidence, or blocks it with blocker evidence and a next action. Only `goal_achieved` releases a dependency. | README "Mission graph semantics"; `skills/pi-team-bright/SKILL.md` | Task card close-up: evidence lines. A quiet pane next to it proves nothing. |
| 4 | **The lead waits for changes, not panes.** `team_sync` wakes the lead on Task changes. Auto-sync batches changes by a configurable delay or update count and resumes an idle lead once. | Decision `0016-framework-team-synchronization.md`; settings `auto_sync_delay_seconds`, `auto_sync_update_threshold`; README "The normal flow" | Lead pane idle; Worker events stack into one batch; the lead wakes once. |
| 5 | **Alerts reach one person.** Clarification and attention Alerts go to one named recipient. Only the lead can announce to the whole Team. Alerts never change Task state. | `src/alert-authority/alerts.ts:39-47`; README "The normal flow" | Reviewer → lead: "clarification: which API version?" A small label: "Task state unchanged". |
| 6 | **Watch the graph live.** `/pi-team-graph` opens a read-only pane in the same tab: a DAG view and, with `v`, a timeline of every Attempt with running and blocked segments. | README "Mission graph semantics"; `src/task-graph-view/` | The graph pane opens, then flips to the timeline; a retry shows as a second row. |
| 7 | **The right model for each role.** Named model roles bind a model and thinking level to a Worker at creation. | Decision `0015-model-role-settings.md`; `docs/examples/pi-team-bright.settings.json` | Worker cards flip to show `standard-worker` and `reviewer` roles. |
| 8 | **Built to survive failure.** Graph revisions need the exact current version. Unknown outcomes replay with the same `operation_id`. Attempt, fencing, and publication rules have bounded TLA+ models. | README "Mission graph semantics"; skill "Refusals and recovery"; `formal/GraphAttempt.tla`, `MembershipFence.tla`, `PublicationObservation.tla` | A stale write bounces off a version check; three spec names appear. |

Second-tier candidates: `/ptb doctor` diagnosis, per-Worker tool and prompt
projection, predefined Teams from `teams.yaml`.

## Corrections to the brief

- **Beads is not the current Task store.** The graph-native path stores Tasks in
  an atomically written Team snapshot
  (`src/adapters/durable-graph-task-authority.ts`). `docs/current/README.md:122`
  calls the Beads adapters "the legacy pre-graph path"; line 252 says "Beads is
  not a graph-state mirror." Point 8 replaces the Beads claim. Reverse this only
  if the owner plans to make Beads the graph authority again.
- **Pane crash and respawn is unverified.** No user-facing doc shows a lost
  pane coming back as the same Worker. Keep that shot out until a real run
  proves it.
- Show only Pi Team Bright surfaces.

## Onyx mapping

Random Labs' [Onyx post](https://randomlabs.ai/blog/onyx) lists ten runtime
needs for agent orchestration. Onyx answers with a TypeScript program the
agent writes. Pi Team Bright answers with a Task graph the lead declares and
the runtime schedules, with every Worker visible.

| Onyx need | Pi Team Bright | Use in video |
|---|---|---|
| Persistent state | Team snapshot, graph revisions, Attempts | Point 8 |
| Output contract / finish gate | Outcome plus evidence closes a Task | Point 3 |
| Control flow | `needs`, bounded `on_goal_failed` | Point 2 |
| Error semantics | `goal_failed`, `blocked` with next action | Point 3 |
| Resource control | Model roles; one active Task per Worker | Point 7 |
| Isolation | One Session and context per Worker; tool projection | implicit |
| Lifecycle | `ensure_worker`, `worker_stop`, `team_shutdown`, fencing | implicit |
| Visibility | Panes, graph and timeline view, `team_sync` events | Points 1, 6 |
| Durability | Version checks, replay, TLA+ models | Point 8 |
| Checkpoint wakes main agent | Auto-sync wakes the lead | Point 4 |
| Composability, cost budgets | **Gap:** no program composition or spend cap | do not claim |

Do not name Onyx or Slate on screen. Use the mapping as a checklist.

## Historical v2 storyline (60 s, 100 BPM, 25 bars)

The v2 soundtrack extends from 19 bars to 25 bars; the arrangement keeps
its intro → drop → outro shape.

| Bars | Time (s) | Scene | Points |
|---|---|---|---|
| 1–2 | 0–4.8 | **Cold open.** Four agent terminals scroll. "Who owns this?" "Done, or just quiet?" | problem |
| 3 | 4.8–7.2 | **Title.** Pi Team Bright. "One lead. A visible team. Work you can prove." | — |
| 4–6 | 7.2–14.4 | **The team assembles.** The lead pane holds 40% on the left. `ensure_worker` ×4: `api`, `ui`, `reviewer`, `writer` pop into the 2×2 grid, each named. Cards flip to show model roles. | 1, 7 |
| 7–10 | 14.4–24.0 | **Declare the graph.** `task_graph_apply`: `api` ∥ `ui` → `review` → `docs`, plus `review` —on_goal_failed (max 2)→ `api`. Tokens fly from nodes into panes; `api` and `ui` run in parallel. | 2 |
| 11–13 | 24.0–31.2 | **Proof, not quiet.** `review` fails with evidence and routes back to `api`; `api` repairs; `review` passes. `writer` blocks: "release date undecided · next: lead decides". | 2, 3 |
| 14–16 | 31.2–38.4 | **The lead sleeps until it matters.** The lead pane idles. Events stack into one batch; the lead wakes once. `reviewer` sends one clarification Alert to the lead; the label "Task state unchanged" appears. The lead resolves the blocker; `docs` runs. | 4, 5 |
| 17–19 | 38.4–45.6 | **Watch it live.** `/pi-team-graph` opens in the tab: DAG view, then `v` → timeline. The `api` retry shows as a second Attempt row; the blocked span shows on `docs`. | 6 |
| 20–21 | 45.6–50.4 | **Built for failure.** A stale graph write bounces off `expected_graph_version`. Replay uses the same `operation_id`. "Attempts · fencing · publication: model-checked in TLA+." | 8 |
| 22–25 | 50.4–60.0 | **End card.** "The Task is the contract." Recap chips of points 1–8. Install line and repository. | — |

## Owner decisions (2026-09-27)

1. Beads is not mentioned; durability (point 8) replaces it.
2. Constructed proof. Story needs govern layout, not a real herdr capture.
3. Example Team: `builder` (impl + test), `reviewer` (fresh eyes), `ui`,
   `scout` (fast explorer). Graph: `map` → `api` ∥ `ui` → `review` → `notes`,
   with `review` —on_goal_failed (max 2)→ `api`.
4. Length: 60 s.
5. Point 9 (nine verbs) is dropped: low audience interest.

## Owner review of v2 (2026-09-27) → v3

- Removed the "Task is the contract" end scene and the durability scene.
- Diagonal 60° push replaces the numbered wipe; no numbers, no blackout.
- Every caption holds at least 2.3 s; captions sit at the top as headlines.
- Removed the HUD, the `pane_layout` sticker, and small decorative labels.
- Worker order: scout → builder → ui → reviewer, everywhere.
- Lead scene: the lead pane dims while events leave Worker panes; one batch
  wakes it.
- Palette: Mirror's Edge (below). TTS voice-over: undecided.

## Owner review of v3 (2026-09-27) → v4

- Length is at most 60 s; viewer rhythm wins over filling time (58.8 s).
- The DAG-view scene is dropped. The final review DAG morphs into the timeline
  in place to show one record with two views.
- Cold open resolves to "LET'S ASSEMBLE A TEAM."
- Team scene starts from one full-width Pi pane with a typed request; the pane
  shrinks to 40% and Workers appear per `ensure_worker` call. Captions avoid
  implying a fixed Worker count. On screen, `role:` abbreviates `model_role:`
  so each call fits one line.
- Normal outcomes never use red: the AWAKE stamp and wake flash are neutral.

## Motion system (v6, 2026-09-27)

Sources: owner review of v5; a second opinion from gpt-6-astra via `codex exec`;
game-feel practice (hitstop 50–120 ms, directional shake), match cuts and eye
trace (School of Motion), Material container transform, minimum-jerk cursor
paths. `timeline.js` carries the rules as data; its header states them.

- **One world, one camera.** The team scene through the timeline is one
  workspace. Scenes are camera shots (quintic ease); only the end card pushes.
- **Anchors across changes.** The stamp's TEAM moves into the title; the title's
  PI unfolds into the `PI-AGENT` pane; the tab's panes re-lay out into the
  graph workspace; tickets fly into timeline rows.
- **Source → carrier → contact.** Folded ticket = delivery; evidence slip =
  result; red square = dependency; chip = change for the lead; envelopes =
  batch and Alert. A 4-frame source glow precedes each launch.
- **Soft travel, hard contact.** Typing uses an irregular cadence; Enter
  depresses and submits. Contacts: receipt (2-frame compress, settle) and
  decision (anticipation, 3-frame hitstop, flash frame, shake, music duck) —
  decisions only for the stamp, becoming the lead, the review failure, and the
  final review pass.
- **Focus budget.** Background log scrolling and hatching pause while a
  carrier flies.
- **Lead wait.** "BLOCKING WAIT · team_sync" → "RETURNED · 3 CHANGES"; no
  sleep-and-recheck loop.
- **Flash safety.** Tab switching speeds up to a 5-frame dwell (6/s) for
  about 0.8 s. From v7 only the tab (400×97 px) changes colour; the content
  swaps white on white, so no large saturated area alternates.

## Round v7: reading budget (owner review of v6)

Owner notes: text leaves before it can be read ("3 TESTS FAILING", the team
assembly); the cold-open box does not read as an agent's request; tab
switches are less visible than the box that changes under them. The owner
lifted the 60 s cap.

- **Reading budget (system rule).** Source: Clearcast / BCAP superimposed
  text hold, 0.2 s per word plus 2 s recognition (3 s at 10+ words).
  Captions and new display text follow it. House rules (provisional): a new
  in-picture element 0.2 s/word + 1.0 s; a known pattern 0.2 s/word + 0.6 s.
  `timeline.js` lists every read with its window until the next focal event;
  `node budget.mjs` checks them. v6 failed 11 of 15 captions; v7 passes 40 of
  40 reads.
- **Retime.** Ensure calls 1.2–1.8 s apart (v6: 0.6 s); graph, lead, and
  review beats spaced to their reads. Length 90.6 s (v6: 58.8 s).
- **Cold open.** Each tab is a pi-agent TUI: pi header and key hints, the
  user's request, grey tool lines, the agent's question in a chat bubble with
  the tab's colour strip, an empty input box, and a footer with context %.
  The active tab lifts in its colour and slides to the next tab; the content
  swaps when the tab lands and enters from that side. First visits hold for
  reading (3.0, 1.7, 1.6, 1.6 s); revisits accelerate to the freeze.
- **Cut candidates if 90 s feels long:** the release-notes Task (about 2 s)
  and the Alert beat (about 5 s).

## Style: Nu-Brutalism × VectorHeart

Owner direction; not a hard constraint.

- **Nu-Brutalism:** warm paper ground, 5 px ink outlines, hard offset shadows,
  flat saturated fills, stickers.
- **VectorHeart:** 45° chamfers and diagonal slabs, registration marks,
  barcodes, technical HUD codes, numbered diagonal wipes, one dark scene.
- **Concept:** a Task is a contract ticket (chamfered corner, perforated stub,
  barcode). Evidence stamps it PROVEN. The end card closes the metaphor:
  "The Task is the contract."
- **Colour (Mirror's Edge):** cool white and concrete-grey ground; runner red
  marks focus (lead, tokens, caption shadow). Workers: scout cyan, builder
  orange, ui yellow, reviewer blue. States: goal_achieved green, goal_failed
  ink ticket, blocked grey with hazard hatch.
- **Type:** Archivo Black (display), Chakra Petch (technical labels),
  JetBrains Mono (code).
