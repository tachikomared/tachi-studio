# Recipe: adding a new app THEME

End-to-end checklist for adding a UI theme to Tachi Studio. Reference themes:
`tachi-opus5` and `tachikoma-red` (palette sheet + structure sheet + a
theme-scoped chrome component each). The whole surface is 7 touchpoints — miss
one and either typecheck fails (good) or the theme silently doesn't persist
(bad).

## Surface (edit ALL of these)

1. `apps/desktop/src/themes/<id>.css` — NEW file. `:root[data-theme="<id>"]`
   block that mirrors EVERY variable of `tachi-dark.css` (bg-base/surface/
   elevated/inset/sidebar, accent family, text family, border family,
   semantic colors with `--destructive: var(--danger)` alias, shadow-hard /
   shadow-hard-lg / shadow-soft, border-width). The shadow color is each
   theme's signature — pick deliberately.
2. `apps/desktop/src/globals.css` — add the `@import './themes/<id>.css';`
   line next to the existing theme imports.
3. `apps/desktop/src/store/theme.store.ts` — extend the `Theme` union AND
   `VALID_THEMES`.
4. `apps/desktop/electron/services/settings-schema.ts` — extend the
   `theme: z.enum([...])` values (otherwise saving the setting fails
   validation and the choice does not persist across restarts).
5. `packages/core/src/settings/types.ts` — extend the mirrored `theme` union.
6. `apps/desktop/src/components/layout/Sidebar.tsx` — add
   `['<label-key>', '<id>']` to the theme-toggle array. NOTE THE GRID: it is
   `repeat(4, 1fr)` and the trailing ⋯ overflow cell currently spans TWO columns
   so six chips + ⋯ fill a 4x2 block exactly. Adding a 7th chip leaves a hole —
   drop the span back to one column when you do (or the grid reads ragged).
7. i18n: add `theme.<label-key>` to `apps/desktop/src/i18n/locales/*/common.json`
   — ALL EIGHT locales (en ru es fr de zh ja ko), properly translated. A
   strict parity test fails the suite if any locale is missing the key.

Optional: theme-scoped decorative React chrome (see `OpusChrome.tsx` /
`TachikomaChrome.tsx` — mounted in `src/app/App.tsx`, renders null unless its
theme is active).

## Success check (run BOTH before declaring done)

```
cd apps/desktop && pnpm typecheck
cd apps/desktop && npx vitest run test/unit/i18nConsistency.test.ts test/unit/i18nDuplicateKeys.test.ts test/unit/settings-schema.test.ts
```

Typecheck catches a missed union member; the i18n suite catches a missed
locale; settings-schema tests catch enum drift.

## Conventions

- Brutalist system: hard-offset shadows, 2px borders, no border-radius,
  JetBrains Mono. A palette theme changes VALUES, never component styles.
- Keep the file header comment in the CSS describing the theme's idea and
  its signature shadow color (see tachi-neon.css / tachikoma-red.css).

## Structure layer — themes may change geometry, not just palette

A theme is not only colors. Direct user feedback: "тема это не просто цвета…
фаски другие, больше углов" — a theme may change the *shape* of the UI
(chamfers, corner cuts, decorations), not merely the palette.

A theme MAY therefore ship a SECOND, optional stylesheet:

```
apps/desktop/src/themes/<id>-structure.css      (imported in globals.css,
                                                 right after <id>.css)
```

Hard rules for a structure sheet (enforced by convention, not the compiler —
follow them or you break the other themes / the app layout):

1. **Scope EVERY rule under `:root[data-theme="<id>"]`.** The sheet is loaded
   for all users; the `data-theme` scope is what keeps it inert unless this
   exact theme is active. An unscoped rule leaks into every theme — never do it.
2. **Element + broad-hook selectors ONLY:** `button`, `input`, `textarea`,
   `select`, `kbd`, `h1`/`h2`, `body`, and existing container hook classes
   (e.g. `.tachi-settings-card`). NEVER a component-specific class — components
   are inline-styled and must stay untouched (editing them is out of scope).
3. **Geometry, not layout.** Use `clip-path`, `filter`, pseudo-element
   decorations, and background texture. Do NOT change size / margin / padding /
   position offsets — a structure theme must never reflow the app or hurt
   legibility. Keep it tasteful.
4. **NEVER `filter: drop-shadow()` an element that may have a transparent
   background.** This one shipped broken in *every* structure theme — see
   "The drop-shadow trick" below for the failure, the required selector, and
   (just as important) what the exclusion must NOT be applied to.
5. **NEVER declare `cursor` — in a palette sheet or a structure sheet.**
   Cursors are app-wide *behaviour*, not theme. Interactive components set their
   cursor inline, and an inline declaration loses to any author `!important` —
   which structure sheets already use (`box-shadow: none !important`). A single
   theme-scoped `cursor` rule therefore silently removes an affordance on that
   theme only, which is impossible to spot in the other four. The drag-resize
   handles are the concrete case: their `col-resize` / `row-resize` cursor is
   owned centrally by `.tachi-resize-handle` in `globals.css` (with
   `!important`), carried by `ResizablePanelEdge` and `SplitHandle`.
   `apps/desktop/test/unit/resizeCursor.test.ts` fails the build if any theme
   sheet declares `cursor`.

### Techniques (see `comic-structure.css` for the reference implementation)

- **Chamfered / corner-cut controls** — `clip-path: polygon(...)` cuts the
  corners (a full octagon, or shave two opposite corners for a bevel).
- **The drop-shadow trick** — a `box-shadow` is painted *outside* the border
  box and is therefore **clipped away by `clip-path`**, leaving a torn corner.
  Reissue the hard offset as `filter: drop-shadow(3px 3px 0 <ink>)` so it hugs
  the clipped shape, and **kill the box-shadow with `box-shadow: none
  !important`** (the `!important` is required to defeat a component's *inline*
  hard-offset shadow, which would otherwise be the thing that gets clipped).

- **HARD RULE — the drop-shadow trick must NEVER target a transparent
  element.** `filter: drop-shadow()` traces an element's **alpha channel**, not
  its border box. On a *solid* button the alpha is the whole rectangle, so you
  get the intended offset plate. On a **ghost / transparent-background** button
  the only opaque pixels are the **text glyphs**, so the filter paints a
  coloured **copy of the text** 3px down-right — the control reads as
  *doubled / struck through*. EVERY structure sheet has shipped this bug once: a
  bare `button:not(:disabled)` hits **22 buttons per screen** — every sidebar
  nav item, RECENT row, theme chip, wallet row and console label in the app.
  Ghost buttons lose nothing by opting out of the SHADOW — they have no visible
  box for it to offset.

  **Selector strategy used here.** Components are inline-styled and rule 2
  forbids component classes, so the only CSS-visible discriminator is the
  inline `background` every button already carries. Exclude by *value*.

- **HARD RULE — and the exclusion applies to the SHADOW ONLY, never to the
  CUT.** This is the other half of the same lesson, and it shipped broken too
  (PATCH-01, 2026-07-26). `clip-path` clips the **border box** and never reads
  the alpha channel, so it is perfectly safe on a ghost control — but the first
  cut of both chassis sheets put `clip-path` and `filter` in ONE ghost-excluded
  rule. Since almost every control in this app IS a ghost, the theme's signature
  shape reached about five buttons and the rest of the UI stayed rectangular.
  The reported symptom was *"the shapes aren't like the mock"* — it read as a
  design failure rather than as a selector bug, which is why it survived review.

  **So write TWO rules.** B1 the cut, for everything; B2 the offset, solid only:

  ```css
  /* B1 · THE CUT — every enabled control, ghosts included. */
  :root[data-theme="<id>"] button:not(:disabled) { clip-path: …; }

  /* B2 · THE OFFSET — solid controls only, for the alpha reason above. */
  :root[data-theme="<id>"] button:not(:disabled):not(
      [style*="background: transparent"],
      [style*="background: none"],
      [style*="background-color: transparent"]
    ) { box-shadow: none !important; filter: drop-shadow(…); }
  ```

  `box-shadow: none !important` belongs in **B2**, not B1: it exists to kill the
  component's inline hard shadow that the clip would tear, and only solid
  controls carry one — while a blanket clear in B1 would also erase the
  `:focus-visible` ring `globals.css` draws as a shadow on ghost chips.

  **Gotcha — do not shorten the exclusion to `[style*=": none"]`.** That
  substring also matches `border-image: none`, which the solid nav tiles carry,
  so it strips the bevel from real buttons. Match the full
  `background…: <value>` pair.

  Verify by counting, not by eyeballing one button — in the running app every
  transparent button must report no `drop-shadow`, and nearly every button
  (ghosts included) must report a `clip-path`:

  ```js
  // the shipped-bug counter — must be 0
  [...document.querySelectorAll('button')].filter(b =>
    getComputedStyle(b).backgroundColor === 'rgba(0, 0, 0, 0)' &&
    getComputedStyle(b).filter.includes('drop-shadow')).length

  // the cut reached the app — must be ≫ 5
  [...document.querySelectorAll('button')].filter(b =>
    getComputedStyle(b).clipPath !== 'none').length
  ```

  `test/unit/structureSheets.test.ts` parses every structure sheet and fails
  both ways: if a `drop-shadow` button rule loses the exclusion, or if the cut
  is trapped back inside it.

- **Press interplay without repeating a long selector** — when the hover/active
  states only retune the shadow offset, drive it through a custom property so
  the ghost-exclusion selector is written **once**:

  ```css
  /* base rule (ghost-excluded) */ filter: drop-shadow(
      var(--x-offset, 3px) var(--x-offset, 3px) 0 <ink>);
  :root[data-theme="<id>"] button:not(:disabled):hover  { --x-offset: 4px; }
  :root[data-theme="<id>"] button:not(:disabled):active { --x-offset: 0px; }
  ```

  Setting the variable on a ghost button is inert — it never applies the filter.
- **Press interplay** — globals.css owns the hover/active `transform`; the
  structure sheet only grows/collapses the `filter` drop-shadow on
  `:hover`/`:active` so the cel shadow behaves like the box-shadow it replaced.
  Transform still applies — verify the button still nudges + lands on press.
- **Halftone dot texture** — a tiled `radial-gradient` dot grid on `body`
  (`background-image` + `background-size`), and optionally a denser fill on
  button `:hover`. Pure CSS, static → inherently `prefers-reduced-motion`-safe.
- **Corner-tick brackets** — `::before`/`::after` L-shaped borders at a
  heading's top-left / bottom-right corners (the `[ bracketed ]` look).
  `position: relative` on the heading is layout-neutral; keep the ticks
  `pointer-events: none` and only a few px outset so they never collide.
- **Stepped input notch + heavy focus ring** — single-line `input`/`select`
  stay rectangular (a `clip-path` here would clip the text caret at the edge) —
  give them a thick border + inset "double-rule" line instead; reserve the
  `clip-path` stepped notch for `textarea` (roomy padding, no caret risk). Make
  the focus ring an **inset** `box-shadow` (thick ink) so `clip-path` can't
  shear it off, and set `outline: none` to drop the thin accent outline.

- **Decorative art chrome** (a theme may also mount a component, e.g.
  `OpusChrome.tsx` / `TachikomaChrome.tsx`) — four lessons paid for in shipped
  defects. The first two come from the retired `tachi-crab` claw chrome; the art
  itself survives in `src/assets/crab/` as the OPUS-5 engraving mask, and its
  shape contract is still pinned by `test/unit/structureSheets.test.ts`:
  - **Anchor art by the edge that must stay put.** A strip sized
    `height: …; width: auto` has a rendered width that moves with the window;
    anchoring by a negative margin let the overlap drift and bury the sidebar.
    Pin the *inner* edge instead (`left: <grip>` + `translate(-100%)`) and the
    overlap is exactly `<grip>` at every size.
  - **Fade the inner edge — then remember it fades.** Art cropped out of a
    larger image ends in a **hard vertical cut through opaque pixels**, which
    paints as a seam slicing down the artwork; ramping the alpha there dissolves
    it. But two ramped edges ABUTTING each other read as a hairline slit, which
    is exactly what the OPUS-5 engraving's two mirrored halves did on the
    midline. Overlap them a few px so the ramps sum instead of meet.
  - **Never hide the chrome on a narrow window.** The crab claws hid below
    1180px and took the plate gutter with them, so at the owner's ~1068px daily
    width the theme had no signature at all. A frame must RESTAGE inward — see
    `tachikomaChrome.helpers.ts`, whose whole reason for existing is this rule.
  - **If your frame mounts its own window keys, hide the TitleBar's.** Both are
    live and wired to the same `window.tachi.window` IPC, so leaving both up puts
    two identical clusters ~50px apart. Do it from the STRUCTURE SHEET, scoped:
    `:root[data-theme="<id>"] [data-titlebar-controls] { display: none; }`.

Structure sheets are optional and additive: `tachikoma-red-structure.css` and
`tachi-opus5-structure.css` are the full instrument treatment (armour cuts, LED
ladders, hazard frames, scoped recess colours); `comic-structure.css` is the
other full treatment (octagon buttons, halftone paper, bracketed headings,
notched textareas, chamfered cards). Remember to add the `@import` line in
globals.css.
