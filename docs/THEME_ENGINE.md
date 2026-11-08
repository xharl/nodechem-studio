# Theming engine — specification

**Status:** implemented (`src/renderer/themes/`, `public/theme-boot.js`, `test/theme.test.js`). Kept as the design record.
**Scope:** `src/renderer/**`, `index.html`, `public/`, `electron/main.js`, `electron/preload.cjs`.
**Outcome:** one token contract, three themes (`current`, `graphite`, `paper`), switchable at runtime, with the contrast and legibility floors enforced by tests instead of by discipline.

---

## 1. Why this is needed

The current renderer has a single flat token block and ~200 colours that bypass it. Themes cannot be layered on top of that, and the two identity proposals cannot be shipped as alternatives without a contract underneath.

| Evidence (2026-11-07 audit) | Number |
|---|---|
| `src/renderer/styles.css` | 1,343 lines |
| Colour literals in that file | 290 occurrences, **213 distinct** |
| … of which inside `:root` (`styles.css:1`) | 21 |
| … of which outside it | 269 occurrences, **202 distinct** |
| `font-size` declarations | 99, of which **50 below 10 px**, 16 distinct sizes |
| Colour literals in `index.html` | 10 |
| Inline `style=""` attributes in `app.js` | 17 |
| Window background hard-coded | `electron/main.js:108` → `#07090d` |
| Stylesheet links in `index.html` | 1 (`index.html:7`), no theme attribute |

Two structural defects matter more than the raw counts:

1. **State and kind share one variable.** `styles.css:335–381` sets `--state` for outcomes (`passed`, `ready`, `blocked`, `review`) *and* for block types (`.node.condition` → amber, `.loop` → violet, `.merge` → blue, `.output` → teal, `.note` → grey). Nine `var(--state)` consumers cannot tell "this calculation failed" from "this block is a condition". No theme can express "state is a dot, kind is a label" while that holds.
2. **The shell has its own palette.** The Electron window paints `#07090d` before the renderer loads (`main.js:108`). A light theme would flash black on every launch.

---

## 2. Goals / non-goals

**Goals**

- Three themes answering one contract: `current` (today's look, pixel-compatible), `graphite` (proposal A), `paper` (proposal B).
- Runtime switch without reload; persisted; no flash of the wrong theme on launch.
- A theme may change colour, type family, radius and elevation. **It may not change layout, spacing or the DOM.**
- Contrast and type-size floors are machine-checked per theme, so a future theme cannot ship unreadable.
- Fonts bundled; zero network at runtime (existing `docs.test.js` guard stays green).

**Non-goals**

- User-authored themes or theme files loaded from disk.
- Per-project themes, per-window themes, high-contrast/forced-colours mode (a later theme can satisfy the contract, but is out of scope here).
- Redesigning components. PR 1 changes no pixels in `current`; component work is PR 2.

---

## 3. Architecture

```
themes/current.css   themes/graphite.css   themes/paper.css     ← answer the contract
            └──────────────┬──────────────────────┘
                    token contract (45 names)
                           │
        styles.css: components consume var(--token) only
                           │
   <html data-theme="graphite">   ← set by theme-boot.js before first paint
                           │
      electron/main.js: backgroundColor + nativeTheme via IPC
```

Three rules make the thing hold:

1. **Components never see a literal.** A colour, shadow or font stack may only appear in `src/renderer/themes/*.css`. Everything else uses `var(--…)`. CI enforces it.
2. **Every theme answers every token.** A missing key is a build failure, not a fallback.
3. **`data-theme` is the only switch.** No JavaScript writes colours; it writes one attribute. CSS does the rest, which keeps the transition instant and testable.

---

## 4. Token contract

45 names in 10 groups. Names are semantic (what it means), never visual (what it looks like), so `paper` and `graphite` can answer the same question with opposite values.

| Group | Tokens | Used for |
|---|---|---|
| Surface (5) | `--surface-canvas`, `--surface-panel`, `--surface-raised`, `--surface-well`, `--surface-scrim` | page, panels, cards/popovers, inputs & route blocks, modal backdrop |
| Border (2) | `--border-subtle`, `--border-strong` | 1 px hairlines, interactive outlines |
| Text (4) | `--text-primary`, `--text-secondary`, `--text-tertiary`, `--text-inverse` | body/titles, labels & metadata, disabled & hints, text on action |
| Action (5) | `--action`, `--action-hover`, `--action-press`, `--action-tint`, `--focus-ring` | primary button, selection, focus, active tab |
| State (5 + 5) | `--state-passed`, `--state-review`, `--state-ready`, `--state-blocked`, `--state-idle` (+ `-tint` each) | outcome of the calculation; dot, rail, pill |
| Kind (6) | `--kind-calc`, `--kind-condition`, `--kind-loop`, `--kind-merge`, `--kind-output`, `--kind-note` | block type. `graphite`/`paper` map all six to one neutral; `current` keeps today's five hues |
| Type (3) | `--font-display`, `--font-ui`, `--font-mono` | titles, interface, numbers/routes |
| Radius (3) | `--radius-sm`, `--radius-md`, `--radius-lg` | 4–6, 8–10, 12–14 px equivalents |
| Elevation (3) | `--shadow-raised`, `--shadow-panel`, `--shadow-popover` | card, panel, modal |
| Grid + motion (4) | `--canvas-grid-image`, `--canvas-grid-size`, `--motion-fast`, `--motion-ease` | canvas texture; transitions |

**Type size is not a theme token.** The scale is fixed for all themes — 11 / 12 / 13 / 15 / 18 / 22 px, floor 11 — so the "50 declarations below 10 px" defect cannot return through a theme. Themes swap families and weights only.

**State text vs state mark.** All `--state-*` values must reach **4.5:1** against the surface they sit on, even where today's UI only draws a 3 px rail. One value is therefore corrected: legacy `--state-blocked` moves `#64748b` → `#76859e` (3.98 → 5.06 on `--surface-panel`), because the contract treats a state colour as a text colour.

---

## 5. State vs kind — the split that makes all three themes possible

| Selector today | Meaning | New token |
|---|---|---|
| `.node.state-passed` | outcome | `--state-passed` |
| `.node.state-review` | outcome | `--state-review` |
| `.node.state-ready` | outcome | `--state-ready` |
| `.node.state-blocked` | outcome | `--state-blocked` |
| `.node.condition` | block type | `--kind-condition` |
| `.node.loop` | block type | `--kind-loop` |
| `.node.merge` | block type | `--kind-merge` |
| `.node.output` | block type | `--kind-output` |
| `.node.note` | block type | `--kind-note` |
| `.status-pill.passed/ready/blocked/review` | outcome, second encoding | `--state-*` + `--state-*-tint` |

Component contract after the split:

- **Rail and dot** take `--state-*`. Never a kind colour.
- **Eyebrow/icon** takes `--kind-*`; in `graphite` and `paper` that resolves to one neutral, so type is read from the label, not the hue.
- **Pills** take `--state-*` for text and mark, `--state-*-tint` for background, `--border-subtle` for the outline.

This is what lets proposal A's "colour = action, dot = state" and proposal B's "state is a margin rule" both run on the same markup.

---

## 6. The three themes

### 6.1 `current` — today's look, preserved

`current.css` maps the 24 existing tokens onto the contract and keeps the legacy names as aliases (`--bg: var(--surface-canvas)` … see appendix). Aliases exist **only in this file**, are marked deprecated, and are removed at 0.4. Acceptance for PR 1: a pixel diff of the seeded project against `main` is ≤ 0.1 % apart from the one `--state-blocked` correction.

### 6.2 `graphite` — proposal A

Graphite ramp, copper accent, Plex Sans + Mono, dot state, 1 px hairlines, no gradients.

### 6.3 `paper` — proposal B

Paper ramp, Prussian-blue accent, Plex Serif for names, ruled canvas, margin-rule state, red reserved for failure.

### 6.4 Core values

| Token | `current` | `graphite` | `paper` |
|---|---|---|---|
| `--surface-canvas` | `#07090d` | `#0A0B0D` | `#F6F3EC` |
| `--surface-panel` | `#0c1119` | `#101215` | `#FCFAF5` |
| `--surface-raised` | `#101722` | `#16191D` | `#FFFFFF` |
| `--surface-well` | `#141c29` | `#1D2126` | `#EFEADD` |
| `--border-subtle` | `rgba(148,163,184,.12)` | `#2A2F35` | `#E2DAC9` |
| `--border-strong` | `rgba(148,163,184,.22)` | `#3B424A` | `#C9BFAA` |
| `--text-primary` | `#e9edf4` | `#E8EBEF` | `#171614` |
| `--text-secondary` | `#98a3b3` | `#A6ADB7` | `#45413A` |
| `--text-tertiary` | `#808da3` | `#7B838D` | `#5F594D` |
| `--action` | `#7c83ff` | `#E0703F` | `#1F4E79` |
| `--text-inverse` | `#0b0f18` | `#141110` | `#FCFAF5` |
| `--state-passed` | `#34d399` | `#56B98A` | `#2E6B4C` |
| `--state-review` | `#fb7185` | `#D8A33C` | `#8E6116` |
| `--state-ready` | `#60a5fa` | `#7B838D` | `#5F594D` |
| `--state-blocked` | `#76859e` | `#7B838D` | `#5F594D` |
| `--state-idle` | `#76859e` | `#7B838D` | `#5F594D` |
| `--font-display` | system sans | Plex Sans | Plex Serif |
| `--font-ui` | system sans | Plex Sans | Plex Sans |
| `--font-mono` | system mono | Plex Mono | Plex Mono |

### 6.5 Measured contrast (WCAG 2.1, computed from the values above)

| Pair | `current` | `graphite` | `paper` | Floor |
|---|---|---|---|---|
| primary on panel | 16.11 | 15.69 | 17.34 | 7.0 |
| secondary on panel | 7.41 | 8.29 | 9.72 | 4.5 |
| tertiary on panel | 5.64 | 4.89 | 6.66 | 4.5 |
| action on panel | 5.90 | 5.86 | 8.30 | 3.0 (non-text) |
| inverse label on action | 5.98 | 5.87 | 8.30 | 4.5 |
| passed on panel | 9.84 | 7.77 | 6.06 | 4.5 |
| review on panel | 7.03 | 8.24 | 5.20 | 4.5 |
| blocked on panel | 5.06 (was 3.98) | 4.89 | 6.66 | 4.5 |

All three themes pass before implementation begins; the test in §9 will hold them there.

---

## 7. Runtime

### 7.1 Boot, before first paint

`index.html` loads a classic script **before** the stylesheet. It reads the stored preference, resolves `system`, writes one attribute:

```html
<script src="./theme-boot.js"></script>
<link rel="stylesheet" href="/src/renderer/styles.css">
```

```js
// public/theme-boot.js — classic script, no imports, runs before first paint
(function () {
  var KEY = 'ncs.theme';
  var VALID = { current: 1, graphite: 1, paper: 1 };
  var stored = 'system';
  try { stored = localStorage.getItem(KEY) || 'system'; } catch (e) {}
  var mode = stored;
  if (mode === 'system') {
    mode = window.matchMedia('(prefers-color-scheme: light)').matches ? 'paper' : 'graphite';
  }
  if (!VALID[mode]) mode = 'current';
  var root = document.documentElement;
  root.dataset.theme = mode;        // resolved id, drives CSS
  root.dataset.themeMode = stored;  // 'system' | 'current' | 'graphite' | 'paper'
  root.style.colorScheme = mode === 'paper' ? 'light' : 'dark';
})();
```

`public/` does not exist yet; PR 1 adds it (Vite copies it verbatim into `dist/`, so the file keeps its name and costs no bundle).


`color-scheme` is set as well so native scrollbars, caret and form controls follow the theme without extra CSS.

### 7.2 Switching

```js
// renderer — one function, one attribute
function applyTheme(mode) {                       // 'system' | 'current' | 'graphite' | 'paper'
  localStorage.setItem('ncs.theme', mode);
  const resolved = mode === 'system'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'paper' : 'graphite')
    : mode;
  document.documentElement.dataset.theme = resolved;
  window.desktop?.setTheme({ mode, resolved });   // shell follows
}
```

Settings → **Appearance**: three preview cards plus *Match system*. No reload, no restart.

### 7.3 Shell

`main.js` needs the resolved id for two things it owns: the window's pre-paint background and native chrome.

```js
const THEME_BG = { current: '#07090d', graphite: '#0A0B0D', paper: '#F6F3EC' };

ipcMain.handle('theme:set', (_event, { mode, resolved }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(THEME_BG[resolved] || THEME_BG.current);
  }
  nativeTheme.themeSource = resolved === 'paper' ? 'light' : 'dark';
  writePreferences({ theme: mode });            // cache only — see below
  return { ok: true };
});
```

`createWindow()` reads that cache for `backgroundColor`. `nativeTheme` joins the existing `electron` import and `writePreferences` is a ~10-line read/write of `userData/preferences.json`; neither exists yet. **Persistence split, stated explicitly:** `localStorage['ncs.theme']` is the source of truth (it is what the boot script can read synchronously); `userData/preferences.json` is a launch-time cache so the window paints the right colour before the renderer exists. If they disagree, localStorage wins and the cache is rewritten on the next switch.

### 7.4 Migration

- Legacy aliases live in `current.css` only; a test fails if any selector outside a theme file uses one.
- Default for 0.3 stays `current` until a theme is chosen in settings; `system` is offered but not default, so an OS preference cannot silently re-skin an existing install.
- `.ncs` files never store a theme — appearance is per-user, not per-project.

---

## 8. Type and fonts

- **Bundled, offline.** IBM Plex woff2 in `src/renderer/fonts/`: Sans 400/500/600, Serif 400/500/600, Mono 400/500 (8 files, ≈300–400 KB total). `@font-face` with `font-display: swap` and `unicode-range` covering Latin, Latin Ext and Greek (needed for ν, cm⁻¹, Å, °C).
- **Licence.** IBM Plex is OFL 1.1. Ship `docs/third-party/IBM-Plex-OFL.txt` and a `THIRD_PARTY_NOTICES.md` entry; a test asserts both exist and every `@font-face` src resolves to a file on disk.
- **Build.** Fonts are referenced from `styles.css`, so Vite hashes them into `dist/assets/`. `electron-builder` already ships `dist/**`; `build.files` needs no change.
- **`current` keeps the system stack.** Bundling changes metrics; a pixel-compatible legacy theme must not. `graphite` and `paper` opt into Plex.
- **Numbers** always use `--font-mono` with `font-variant-numeric: tabular-nums`, in every theme.

---

## 9. Verification

New `test/theme.test.js`, run in the existing `vitest` suite (no new dependency):

1. **Contract completeness** — parse the three theme blocks; assert each defines exactly the same key set, and that the set equals the documented contract.
2. **No orphans, no strays** — every `var(--x)` in `styles.css`, `index.html` and component CSS resolves in all three themes; no `#hex` / `rgb()` / `rgba()` / `hsl()` literal anywhere outside `src/renderer/themes/*.css`.
3. **Contrast floors** — recompute §6.5 from the parsed values inside the test: text ≥ 7, secondary/tertiary ≥ 4.5, every `--state-*` ≥ 4.5, `--action` vs `--surface-panel` ≥ 3, `--text-inverse` on `--action` ≥ 4.5. A new theme must pass before it can merge.
4. **Type floor** — no `font-size` below 11 px anywhere; the six-step scale is the only source of sizes.
5. **Boot order** — in `index.html`, `theme-boot.js` appears before the stylesheet; its whitelist equals the theme registry; the file contains no `fetch`, `XMLHttpRequest`, `http://` or `https://` (extends the existing no-network guard to `public/`).
6. **Alias quarantine** — legacy names appear only in `current.css`.

Manual matrix before merge: each theme × {canvas, inspector, palette open, modal, queue panel, 3D viewer} at 1440×900 and 1100×700, plus a print screenshot of `paper`.

---

## 10. Rollout

| PR | Contents | Acceptance |
|---|---|---|
| **1** | Contract, `themes/*.css`, boot script, alias block, `styles.css` mechanical rename | `current` pixel-identical (≤0.1 % diff); tests 1, 2, 5, 6 green; no component touched |
| **2** | Components: state/kind split, pills, node rail, type scale, 11 px floor | tests 3, 4 green; `graphite` and `paper` screenshots approved; `current` still within diff budget |
| **3** | Settings → Appearance, persistence, `theme:set` IPC, `nativeTheme`, window background | switch without reload; no flash on cold start in all three themes; window controls legible in `paper` |
| **4** | Fonts, licence, `docs/guide/appearance.md`, regenerated docs screenshots per theme | licence test green; `docs.test.js` green; README screenshot no longer a raw window capture |

Each PR ships independently. PR 1 alone removes the "202 literal colours" problem without changing how the app looks — that is deliberate, so the risky visual work lands on a stable base.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Flash of wrong theme | Boot script before stylesheet; `backgroundColor` seeded from `preferences.json`; test asserts order |
| `system` mode re-skins a user who never asked | `system` is opt-in, not the default for existing installs |
| Two persistence stores drift | localStorage is truth; the JSON is a cache overwritten on every switch |
| `paper` on an OLED in a dark room | Theme is a choice, not a default; system mapping gives dark users `graphite` |
| Docs screenshots churn on every theme | Docs pick one canonical theme (recommendation: `paper` for print, `graphite` for the app default) |
| Legacy aliases become permanent | Alias test + removal scheduled at 0.4 |
| 3D viewer assumes dark | Viewer background becomes `--surface-well`; CPK atom colours stay theme-independent by design |

---

## 12. Open questions for review

1. **Default at 0.3:** keep `current` as default (safest, but the public identity stays the old one) or ship `graphite` as default with `current` as legacy? A theme engine lets this be a one-line change, but it should be decided, not drifted into.
2. **Docs canonical theme:** `paper` makes every screenshot print-ready; `graphite` matches the default app. One theme for all docs, or `paper` for figures and `graphite` for UI shots?
3. **Kind colours:** keep the legacy five hues in `current` forever, or neutralise kinds in all themes at 0.4? Today's amber condition / violet loop is exactly the "six hues fighting" problem.
4. **Font subsetting:** ship one full Latin+Greek file per face (≈40 KB each, simplest) or split by `unicode-range` to load Greek only when used?

---

## Appendix — legacy alias map (quarantined to `current.css`)

| Legacy | Contract |
|---|---|
| `--bg`, `--bg-deep` | `--surface-canvas` |
| `--panel`, `--panel-2`, `--panel-3` | `--surface-panel`, `--surface-raised`, `--surface-well` |
| `--input` | `--surface-well` |
| `--line`, `--line-2` | `--border-subtle`, `--border-strong` |
| `--text` | `--text-primary` |
| `--muted` | `--text-secondary` |
| `--faint` | `--text-tertiary` |
| `--accent`, `--accent-soft` | `--action`, `--action-tint` |
| `--green`, `--red`, `--blue`, `--amber`, `--slate`, `--teal`, `--violet` | `--state-*` / `--kind-*` per §5 |
| `--shadow` | `--shadow-panel` |
| `--sans`, `--mono` | `--font-ui`, `--font-mono` |
