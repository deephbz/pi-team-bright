# Decision 0011: Unified Pi Team Bright TUI message projection

Date: 2026-08-14
Status: accepted

## Decision

Every displayed Pi Team Bright message starts with one bold type line:
`[pi-team-bright.<message-type>]`. Tool types keep underscore names. Custom
message types use `task-change`, `direct-message`, and `sync-nudge`.

One semantic audience projection owns the type, tone, concise lines, structured
JSON detail, and provenance. Pi theme rendering, plain export, ANSI export, and
the terminal review gallery all consume this projection. Collapsed mode shows
only the concise lines. Pi detail mode adds the raw projection JSON.

A tool call renderer owns the header. Its result renderer owns the body and
optional JSON. This division prevents duplicate titles without shared mutable
renderer state. A custom-message renderer owns the complete header and body.
The header uses Pi's bold `customMessageLabel` role. Body text uses
`customMessageText` and the applicable status role.

New Task and direct-message Session entries use `pi-team-bright.*`. Readers
continue to recognize historical displayed, resume, and acknowledgement
entries under `pi-teams.*`. Legacy displayed entries use the current renderer
and current visible label. New writers never emit the old namespace.

The checked-in gallery inventory covers all displayed custom-message types and
each top-level model-result kind for all nine registered tools. It also includes
partial delivery, replay, recovery, malformed payload, execution-error, and
projection-error cases. Tests compare the inventory with the executable model
schemas. The gallery exports plain, ANSI, and structured JSON forms, and its
non-mutating terminal app supports navigation, scrolling, and detail toggle.

## Motivation

Pi's fallback custom renderer showed the custom type and then repeated a second
PiTeams heading from message content. Tools used Pi's default call title and a
different result format. These paths had different names, styles, and detail
rules, so maintainers couldn't review the complete display surface as one
artifact.

A shared pure projection makes the production renderer individually testable.
It also lets maintainers generate all display states without a live Team or
mutating a Session.

## Consequences

Raw semantic tool details remain machine truth. Detail mode shows those raw
details rather than the smaller model projection. Delivery acknowledgement
details remain small; Task and direct-message renderers parse the controlled
JSON already present in their agent-visible content.

The terminal gallery is a review surface, not Team authority. It calls no tool
and writes no coordination state. Schema coverage detects a new result kind
until a visible sample exists.

## Reversal criteria

Revisit the split tool call/result ownership if Pi adds one atomic renderer for
a complete tool transcript entry. Keep the semantic projection and gallery even
if the theme adapter changes.
