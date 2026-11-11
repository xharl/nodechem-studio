# Appearance

NodeChem Studio ships three themes. They are complete palettes, not a tint over one
another: each one answers the same token contract, so anything that reads a colour
reads the active theme.

| Theme | Look | When to use it |
|---|---|---|
| **Current** | The dark blue-grey the app has always used | Default; matches the published screenshots |
| **Graphite** | Near-black, warm orange accent, neutral block kinds | Long sessions, projectors, OLED |
| **Paper** | Light stock, dark ink, serif display face | Printing figures, screen sharing, reading a report |

Switch with **⋯ → Theme** in the top bar. The choice is stored in
`localStorage['ncs.theme']` and applied by `public/theme-boot.js` *before* the
stylesheet loads, so the window never shows a flash of the wrong theme — including
the light theme, which would otherwise flash a dark canvas on launch. **Match system**
follows the OS: dark maps to Graphite, light maps to Paper.

Switching does not reload the window. The renderer swaps `data-theme` on `<html>`;
the main process only repaints the native window background, tells Electron's
`nativeTheme` which way the chrome should shade, and records the choice in
`preferences.json` so the next launch paints the right colour before the renderer
exists.

## What a theme may change

Colour, font family, radius and shadow — the `--surface-*`, `--border-*`, `--text-*`, `--action*`,
`--focus-ring`, `--state-*`, `--kind-*`, `--font-*`, `--radius-*` and `--shadow-*` tokens. **Not
type size**: one fixed scale (11 / 12 / 13 / 15 / 18 / 22 px) applies to every theme, so a theme
cannot shrink text below the 11 px floor that `test/theme.test.js` enforces.

Outcome and block type are separate tokens. A block's left rail and status dot take
`--state-*` (passed, review, ready, blocked, idle); its icon and eyebrow take
`--kind-*` (calc, condition, loop, merge, output, note). Graphite and Paper render
every kind in one neutral, because the label already says what the block is; Current
keeps the original hues.

## Fonts

IBM Plex Sans, Serif and Mono ship with the app (Latin subset, woff2, SIL Open Font
License 1.1 — the notice is `src/renderer/fonts/OFL.txt`). Nothing is fetched at
runtime.

## If you are changing the palette

`styles.css`, `index.html` and the renderer carry **no colour literals** — a test fails if one
appears. Colours live in `src/renderer/themes/{current,graphite,paper}.css`, which
the generator `scripts/build-themes.mjs` writes from the legacy palette plus the
hand-written contract block. Edit the contract in that script, re-run it, and the
three files stay in step; `test/theme.test.js` checks that they define the same key
set and that the contrast floors still hold. `themes/legacy.css` is the
compatibility alias layer — the `--tone-*` names the stylesheet still references,
each resolving to a theme token — not a fourth theme.

The one exception is `src/renderer/structureViewer.js`, which carries the CPK element
colours (carbon grey, oxygen red, …). Those are chemistry conventions rather than
theme colours, and no theme may recolour an atom.

## Next

[Running a real Gaussian job →](engines.md)
