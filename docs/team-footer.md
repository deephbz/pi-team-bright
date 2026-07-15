# Team identity in the Pi footer

When the current Pi Session is the exact current Membership of a Team, PiTeams prefixes Pi's
built-in footer with the Team and role:

```text
[research-team · reviewer] ~/repo (feature-branch)
```

The label is a projection of the persisted Session/Membership binding. `PI_TEAM_NAME`,
`PI_AGENT_NAME`, a live process, or a tmux pane is not sufficient evidence, so standalone,
forked, stale, inactive, and otherwise unbound Sessions retain Pi's ordinary footer without a
Team label.

Pi 0.80 exposes a whole-footer replacement API but no footer decorator API. PiTeams therefore
wraps Pi's public `FooterComponent`, delegates all built-in rendering, and changes only its first
rendered line. Git branch updates and extension statuses such as TPS remain owned by Pi's footer
provider; PiTeams does not publish its identity through the separate extension-status line.

Only one custom footer can be installed in Pi at a time. Another extension may intentionally
replace the PiTeams wrapper, and PiTeams restores the built-in footer whenever the Session is no
longer exactly bound.

Pi currently does not expose the built-in footer's live auto-compaction toggle to custom footer
wrappers. The reused `FooterComponent` therefore keeps its default auto-compaction indicator if
that setting is changed after installation; this is a Pi API limitation, not a Task or Membership
state claim.
