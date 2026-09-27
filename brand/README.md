# Brand

`brand.js` is the single source for Pi Team Bright's visual identity: colour
and type tokens, product copy, drawing primitives, the mark, and the lockup.
Every visual surface derives from it.

```
brand.js ──► build.mjs ──► assets/   logo, mark, favicon set, banner, social preview, tokens.css
         │             └─► website   (GitHub Pages, built by .github/workflows/pages.yml)
         └─► promo video             (Canvas2D; loads brand.js as a script)
```

The primitives draw through a Canvas2D context. `build.mjs` supplies an SVG
context with the same API and turns text into outlines from `fonts/`, so one
drawing function produces video frames and vector assets alike.

## Rules

- **Colour.** Cool white and concrete ground, ink outlines. Red marks focus
  and the lead; it never marks a normal outcome. Each worker agent gets one
  colour from `color.agents`, in order of appearance. Green marks a proven
  result.
- **Type.** Archivo Black for display, Chakra Petch for technical labels,
  JetBrains Mono for code. All three are vendored under the SIL Open Font
  License (`fonts/OFL-*.txt`).
- **Form.** Thick ink outlines, hard offset shadows, 45° chamfers.
- **Mark.** A red lead wired to its worker agents. The last worker is an
  open slot: a team of any size. The small variant drops the open slot for
  favicon sizes.
- **Copy.** Every claim in `copy.points` names the source file that proves it.
  Change the claim and its anchor together.

## Build

```sh
npm ci --prefix brand
node brand/build.mjs            # regenerate assets/
node brand/build.mjs --check    # CI: fail if assets/ drifts from brand.js
node brand/build.mjs --site _site
```

Edit `brand.js`, then rebuild and commit `assets/` with it. Never edit files
in `assets/` by hand.
