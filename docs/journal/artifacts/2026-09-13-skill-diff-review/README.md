# Skill rewrite review webpage

Purpose: show the current Pi Team Bright skill against the rewrite the owner
approved, without writing the skill from the review webpage. This is a task-specific read-only
review artifact, not a product feature, editor, or approval authority.
Architecture impact: none. Stage: disposable review tooling.

The approved drafting base is the Markdown candidate preserved in
`docs/journal/2026-09-13-skill-interface-rethink.md`. Current instructions now live
in `skills/pi-team-bright/SKILL.md`. `generate.py` compares those two sources and
records the original Git base as provenance. It creates derived JSON and a patch
relative to the approved draft; the light-mode page renders them with `@pierre/diffs`.
Generated files and dependencies are disposable and ignored by Git.

The implementation follows the Pierre `diffs` skill and its vanilla recipe,
retrieved from `pierrecomputer/pierre` at
`e08d0236b4bbc7cf5f532d9ddf761f1a351b7c34`, under `skills/diffs/`.
The exact installed renderer and bundler versions are in `package-lock.json`.

From this directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run serve
```

Open `http://127.0.0.1:4381`. The server binds only to loopback and serves only
`dist/`. There is no write endpoint, external analytics, or approval button.
Layout and context controls only change presentation. Send review feedback in chat.
