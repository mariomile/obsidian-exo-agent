# Marioverse Obsidian Suite — Design System

The shared visual language for Mario's Obsidian plugins and theme: **Exo Agent** (agentic chat), **Masonry** (note card grid), **TabX** (vertical tabs + card grid), **Sonar** (spotlight search), and the **Cosmos** theme. They are separate repos but one designed environment — a note that opens the same way a tab renders, a search row, a chat card. This document is the canonical cross-plugin reference; it lives in `obsidian-exo/docs/` because Exo carries the richest, most mature system.

> **Read this before styling any new surface in the suite.** The recurring failure mode is reaching for generic Obsidian-modal defaults (native `<select>`, `mod-cta`, uppercase field labels, decorative backgrounds) instead of the suite's own recipes below. Grep the target repo's stylesheet for an existing equivalent first, then reuse it.

---

## 1. The six laws

Non-negotiable principles every plugin and the theme already follow. Break one and the surface stops reading as part of the suite.

1. **Delegate all color to Obsidian theme variables.** Build on `--background-*`, `--text-*`, `--interactive-accent`, `--font-ui-*`. The stylesheet must adapt to any theme with zero hard-coded colors. The only fixed colors in the entire suite are (a) the two provider brand accents in Exo (Claude `#d97757`, Codex `#19c37d`), and (b) the Cosmos theme's own dark palette — which is the theme's job, not a component's.

2. **Quiet surfaces.** No permanent decorative backgrounds, fills, or chrome. Hierarchy comes from typography weight, spacing, and geometry — not from color volume or boxes. Interactive state (hover / active / open) is the *only* time a surface tints. Mario has explicitly rejected permanent backgrounds behind the tab bar and behind cards. Glassmorphism and gradients are anti-references (Cosmos `PRODUCT.md`) — fills are solid or `color-mix` blends, never gradients.

3. **Quiet focus on form fields.** Text inputs, textareas, and selects never wear the glowing accent ring — the caret already signals focus. They get a border-color change (or, in Sonar's search, nothing at all). The 2px accent outline is reserved for buttons and `[role="button"]` / interactive non-text controls.

4. **`color-mix` for every blend.** Subtle surfaces are composited from theme vars: card background is `color-mix(in srgb, var(--background-primary) 92%, var(--background-secondary))`; an accent tint is `color-mix(in srgb, var(--interactive-accent) N%, transparent)`. Never approximate with a hard-coded rgba.

5. **Motion is taste, not requirement.** Every transition collapses under `@media (prefers-reduced-motion: reduce)` (to `0.01ms` / `none`). Two semantic easings (see §3) — one for color washes, one for physical lift.

6. **One namespace per surface, tokenized locally.** Each plugin owns a class prefix and defines its own `--{prefix}-ease` / `--{prefix}-radius` tokens at its root: `.mva-*` (Exo), `.masonry-*`, `.tabx-*`, `.sonar-*`. The Cosmos theme uses `--mv-*`. Never leak one plugin's classes into another; share *recipes* (below), not selectors.

---

## 2. Tokens

Each surface defines its own tokens, but they draw from one intended scale. The table shows real values as they exist today — including where they've drifted (harmonization targets called out below).

| Token | Exo (`.mva-`) | Masonry (`.masonry-`) | TabX (`.tabx-`) | Sonar (`.sonar-`) | Cosmos (`--mv-`) |
|---|---|---|---|---|---|
| radius small | `--mva-r1: 6px` | `--radius-s` (native) | `--radius-s` | `--radius-s` | `--mv-r1: 6px` |
| radius base | `--mva-r2: 9px` | `--masonry-radius: 11px` | `--tabx-radius: 9px` | `--sonar-row-radius: 8px` | `--mv-r-card: 11px` |
| radius large | `--mva-r3: 13px` | — | — | `--sonar-radius: 12px` | `14px` (tab pill) |
| chip radius | `999px` (removable) | `5px` | `5px` | `7px` | `--mv-r-chip: 5px` |
| duration | `--mva-t: 0.14s` | 120–180ms | 120–180ms | `--sonar-ease: 80ms` | `--mv-t: 140ms` |
| ease (wash) | — | `cubic-bezier(0.25,1,0.5,1)` | `--tabx-ease: cubic-bezier(0.25,1,0.5,1)` | `ease` | `--mv-wash: cubic-bezier(0.25,1,0.5,1)` |
| ease (lift) | `--mva-ease-out: cubic-bezier(0.22,1,0.36,1)` | — | — | — | `--mv-lift: cubic-bezier(0.22,1,0.36,1)` |

**The two-easing system** (the Cosmos theme names both, and is the key to reading the suite): `wash` = `cubic-bezier(0.25, 1, 0.5, 1)` for color/background transitions; `lift` = `cubic-bezier(0.22, 1, 0.36, 1)` for physical motion (card hover elevation, translate). They are not a drift to reconcile — they're two purposes. When you add motion, pick by kind: coloring → wash, moving → lift.

**Harmonization notes** (drift worth closing when you touch a file, not a mandate to refactor):
- **Base radius should be 9px** for interactive controls (Exo `--mva-r2`, TabX `--tabx-radius`). Cards run larger (11px, Masonry/TabX/Cosmos card) — a deliberate card-vs-control distinction, keep it.
- **140ms is the house duration** (Exo `--mva-t`, Cosmos `--mv-t`). Sonar's 80ms is intentional for a snappy spotlight modal; keep it there, don't generalize it.
- **Spacing**: Exo/Masonry/TabX use ad-hoc px on a rough 2/4/6/8/10/12/18/24 rhythm; Sonar uses Obsidian's `--size-4-*` scale. No formal spacing token exists suite-wide — prefer the `--size-4-*` native scale in new work.

---

## 3. Typography — three registers

Getting the register wrong is the single most common mistake (it's what made the Exo task modal look off-brand). There are exactly three:

**A. Eyebrow — structural section headers.** UPPERCASE, `~11px` / `0.7rem`, weight `600`, `letter-spacing: 0.04–0.06em`, `color: var(--text-muted)`. Used for: recap-rail title, tune-dialog section labels (Exo); rail header (TabX, `0.04em`); group headers and the file-type source badge (Sonar, `0.03em`); Bases card property labels (Cosmos, `0.05em`). **Never on a form field label.**

**B. Title — card and heading text.** Weight `640–680`, `letter-spacing: -0.015em to -0.02em` (tight tracking for display). Used for card titles and group headings across Masonry / TabX / Cosmos, and Sonar's preview title (`--font-bold`).

**C. Body & field labels.** Sentence case, native `--font-ui-*` sizes (smaller `~11px`, small `~12–13px`, medium `~14px`), normal weight. **Form-field labels use register C**, not A: `var(--font-ui-smaller)`, `var(--text-muted)`, `4px` bottom margin — this is the `.mva-pv-label` pattern in Exo. Numbers that align in columns (scores, counts, dates) add `font-variant-numeric: tabular-nums`.

### The registers as tokens (Exo, 2026-08-11)

Exo stopped describing the three registers and started shipping them. Each one is a set of tokens declared once in the Cosmos bridge at the top of `styles.css`, plus one class that spends them:

| Register | Tokens | Class |
|---|---|---|
| A. Eyebrow | `--mva-type-eyebrow-size` / `-weight` / `-track` / `-case` / `-color` | `.mva-type-eyebrow` |
| B. Title | `--mva-type-title-size` / `-weight` / `-track` | `.mva-type-title` |
| C. Body | `--mva-type-body-size` / `-size-sm` / `-weight` / `-track` | `.mva-type-body` |

Three things follow from that, and they are the point:

- **A surface declares its register, not its type.** The chat bubble, the composer, the sidebar rows and the step headers carry the class and declare no `font-size` / `font-weight` / `letter-spacing` of their own. What you see in the inspector is the register, in words.
- **The size slot is the only local call.** A surface that genuinely owns its size overrides the token, not the property: `.mva-bubble { --mva-type-body-size: var(--exo-font-size, 14px); }`. Register C keeps a second step, `--mva-type-body-size-sm`, for the small chrome slot (previews, step headers): the same register, one rung down.
- **Register A resolves through Cosmos.** The eyebrow tokens chain through the theme's label family, so a Cosmos flavour that drops the uppercase or flattens the tracking reaches every eyebrow in the suite at once, instead of leaving one pane shouting on its own.

`src/style-contract.test.ts` enforces two of these: that each class spends its own tokens, and that register A never lands on a form-field label (§7's most-repeated anti-pattern). Registers are not tokenized outside Exo yet: the other repos still inline the recipes above.

---

## 4. Color

- **Text hierarchy**: `--text-normal` (primary, active), `--text-muted` (secondary, labels, icons at rest), `--text-faint` (tertiary, paths, counts, empty states). Icons go muted→normal on hover.
- **Surfaces**: `--background-primary` (base), `--background-secondary` (raised: inputs, popovers, preview panes), `--background-modifier-hover` (the one hover/active tint), `--background-modifier-border` (all 1px borders), `--background-modifier-border-hover` (border on card hover).
- **Brand accents** (Exo only, theme-independent): Claude `#d97757`, Codex `#19c37d`, exposed as `brandColor` on each provider and used for provider dots. Same dot language across tab bar and gallery cards.
- **Semantic**: always `var(--color-x, #fallback)` — caution `--color-orange, #e0a341`, danger `--color-red, #e05b5b`, success `--color-green, #19c37d`. In Exo these stay *quiet at rest*: a small colored dot signals risk while text stays muted; full color floods only on hover/open.
- **The shared card color recipe** (Cosmos tokenizes it as `--mv-card-bg`; Masonry & TabX inline the same):
  - base `color-mix(in srgb, var(--background-primary) 92%, var(--background-secondary))`
  - hover `color-mix(in srgb, var(--background-primary) 82%, var(--background-secondary))`
  - accent ring / active inset `color-mix(in srgb, var(--interactive-accent) 16%, transparent)`
  - active border `color-mix(in srgb, var(--interactive-accent) 55%, var(--background-modifier-border))`

---

## 5. Component recipes

These are the shared patterns. Copy the recipe, keep your prefix. "Used by" tells you where the reference implementation lives.

### Button — `.mva-btn` (Exo is canonical)
```css
.mva-btn          { padding: 5px 11px; font-size: 12px; font-weight: 550;
                    color: var(--text-normal); background: var(--background-modifier-hover);
                    border: 1px solid var(--background-modifier-border);
                    border-radius: var(--mva-r1); box-shadow: none;
                    transition: background var(--mva-t), border-color var(--mva-t); }
.mva-btn-primary  { color: var(--text-on-accent); background: var(--interactive-accent);
                    border-color: transparent; }              /* hover: opacity .92 */
.mva-btn-danger   { color: var(--text-error);
                    border-color: color-mix(in srgb, var(--text-error) 35%, transparent); }
```
**Never use Obsidian's `mod-cta`** for a suite button — it doesn't match this weight/size/radius.

### Picker — chip + popover (`.mva-sel`, Exo)
Never a native `<select>` (its value clips and it ignores the theme). Use a chip that opens a popover via `openablePopover()` (`src/ui/popover.ts`):
- `.mva-sel` (inline-flex wrap) › `.mva-sel-chip` (11.5–12.5px, `--text-muted`, hover/`is-open` → normal + `--background-modifier-hover`) › `.mva-sel-pop` (`--background-secondary`, 1px border, `--mva-r2`, `--shadow-l`, `scrollbar-width: none`) › `.mva-sel-opt` rows with a trailing `.mva-sel-opt-check` on the active value.

### Form field — `.mva-pv-input` (Exo)
```css
.mva-pv-input        { width: 100%; padding: 8px 12px; border-radius: var(--mva-r2);
                       border: 1px solid var(--background-modifier-border);
                       background: var(--background-primary); color: var(--text-normal); }
.mva-pv-input:focus  { outline: none; border-color: var(--interactive-accent); }  /* law 3 */
```
Sonar's search input takes law 3 to the extreme: fully flat, `!important` resets on `:focus`/`:focus-within` to defeat theme rings — right for a spotlight field, overkill for a normal form.

**Modal gotcha (learned 2026-07-09).** An Obsidian `Modal` renders in `.modal-container`, *outside* `.mva-root` — two things break there that don't inside the view:
1. **Feature-scoped tokens are undefined.** `--mva-r1/r2/r3` and the timing tokens must never live on `.mva-root`, or `var(--mva-r2)` resolves to empty in a modal and radii silently collapse to `0`. Hoist them to an ancestor, and the right ancestor is **`body`, not `:root`** (learned 2026-08-11, measured in a browser). A custom property is substituted where it is *declared*, and both Obsidian's palette and every Cosmos token are declared on `body`. A chain written on `:root` (the `html` element, one level up) therefore resolves against nothing: it takes the fallback even under Cosmos, and it resolves the dark palette once and keeps it under a light theme. `.modal-container` is a child of `body`, so `body` fixes the modal case too. Pure constants with no theme or kit input (Exo's `--exo-font-size` Style Settings default) are the exception and stay on `:root`, above the `body` block Style Settings writes to.
2. **The theme outranks the bare recipe classes.** The active theme (e.g. Cosmos) styles `.modal input/textarea/button` at specificity `0,1,1`, beating `.mva-pv-input` / `.mva-btn` (`0,1,0`) — and it styles `input` and `textarea` *differently*, so the two visibly diverge (one gets a fill, the other doesn't). Re-assert the recipe's surface scoped to `.modal-container .mva-pv-input` / `.modal-container .mva-btn*` (`0,2,0`), using the same tokens — enforcement, not a fork. Do this once at the canonical level so every modal (prompt-vars, task modal, …) inherits the fix.

### Card — the shared grid card (Masonry / TabX are near-identical twins)
1px `--background-modifier-border`, card-radius (11px), background = the §4 card recipe. Hover: `border-color: var(--background-modifier-border-hover)` + soft lift shadow `0 5px 16px color-mix(in srgb, var(--background-modifier-box-shadow) 18%, transparent)` on `--mv-lift`/wash. Active: accent-tinted border (55%) + inset ring (16%). Focus: `outline: 2px solid var(--interactive-accent); outline-offset: 2px` (outset for grid cards; inset `-2px` for tab rows so layout doesn't shift). Exo tokenizes its own card family as `--mva-card-pad/radius/border` so tool/permission/ask/capabilities cards read as one system.

### Tag chip — `[data-tag-kind]` (Masonry / TabX, identical)
`padding: 1px 6px; border-radius: 5px; border: 1px solid var(--background-modifier-border); background: transparent; color: var(--text-muted); font-size: 0.68rem`. Semantic variants by attribute: `status` → accent-tinted border + 5px accent dot `::before`; `type` → `border-style: dashed`; `domain` → filled `--background-secondary`, transparent border.

### Reveal-on-interaction controls
Close buttons and card actions are `opacity: 0` at rest, shown on `:hover` / `:focus-within` (translateY in from `-3px` for Masonry actions), and **always visible on `@media (pointer: coarse)`** with enlarged 40–44px targets.

### Loading skeleton — shimmer (Masonry / TabX, identical)
```css
background: linear-gradient(100deg, transparent 20%, var(--background-modifier-hover) 48%, transparent 76%),
            var(--background-secondary);
background-size: 220% 100%;
animation: {prefix}-shimmer 1.25s linear infinite;   /* 180% 0 → -40% 0 */
```

### Presentation / density toggle (Masonry / TabX)
`compact | editorial | visual` via `[data-presentation]` on the grid, driving `--{prefix}-card-width` (200 / 260–310 / 340–360px) and `--{prefix}-excerpt-lines` (3 / 5 / 9). A small `.…-density` segmented button group (28px buttons, `aria-pressed` active state) on desktop; collapses to a select on narrow containers. Layout adapts by **container query** (`container-type: inline-size`), not viewport media query.

### Focus (universal)
`:focus-visible { outline: 2px solid var(--interactive-accent); outline-offset: 2px; }` on buttons and `[role="button"]`; form controls exempt (law 3). Grid cards render the ring via a `::after` pseudo-element so the geometry doesn't shift.

---

## 6. Per-surface character

- **Exo** — the flagship. In-sidebar agentic chat, theme-agnostic, richest token set. Owns the canonical button, picker, form-field, and card-family recipes. Modals (`.mva-ie-*`, `.mva-pv-*`, task modal) live **outside** `.mva-root`, so they redeclare their own focus resets. One signature animation: a gentle staggered ease-in on first paint.
- **Masonry & TabX** — the card-grid twins (shared "template" lineage). Pinterest-style column masonry (Masonry) / absolutely-positioned grid (TabX), identical card + tag-chip + density + shimmer recipes. TabX adds a vertical tab rail and a **geometry-only** auto-hide/scroll tab bar (no decorative fill — law 2), with a dual-delay collapse (450ms grace out, immediate reveal in).
- **Sonar** — a spotlight search modal (880px, `margin-top: 9vh`, results/preview 56/44 split). Snappier 80ms timing, flat quiet input, `--size-4-*` native spacing, uppercase file-type source badges. Hosts the cross-plugin **"Search with Exo"** row (icon in `--text-accent` to mark the AI hand-off) via `app.plugins.plugins["exo-agent"].askExo(...)`.
- **Cosmos theme** — the de-Baselined fork that ties it together. Defines the `--mv-*` tokens the plugins echo, an SF Pro type scale (12/13/14/16/18px UI, 24px body) with 1px Nucleo-style icon strokes, a unified dark palette (`#141414` editor ≈ `#171717` panels), Craft/Notion pill tabs, and four reversible flavours (Cupertino / Fusion / Border / Standard) gated by `.layout-*` classes. Every layer falls back to clean Baseline when disabled. Philosophy in its `PRODUCT.md`: *quiet, considered, tactile — like a well-made notebook, not a dashboard.*

---

## 7. Anti-patterns — never ship these

- A native `<select>` in suite UI → use the chip + popover picker.
- `mod-cta` for a button → use `.mva-btn-primary` (or the local equivalent).
- UPPERCASE eyebrow labels on **form fields** → register C (sentence case, muted). Eyebrows are for structural section headers only.
- A permanent decorative background/fill behind a bar, card, or panel → law 2.
- A hard-coded hex/rgba where a theme var or `color-mix` would do → law 1 & 4.
- Gradients or glassmorphism → solid fills / `color-mix` only.
- An accent focus ring on a text input → law 3 (border-only).
- Motion with no reduced-motion guard → law 5.

---

## 8. Checklist for any new UI surface

1. **Grep first.** Search the repo's stylesheet for the component family (`.mva-pv-*`/`.mva-sel-*`/`.mva-btn*` in Exo; `[data-tag-kind]`, `-card`, `-density` in Masonry/TabX; `-result`, `-chip` in Sonar). Reuse the recipe; don't invent.
2. **Pick the right type register** (§3) — eyebrow vs title vs field label.
3. **Tokens, not literals** — your prefix's `--*-ease`/`--*-radius`, native `--background-*`/`--text-*`/`--size-4-*`, `color-mix` for blends.
4. **Quiet by default** — no fill at rest; state only on hover/active/open. Form fields get quiet focus.
5. **Reduced-motion guard** on every transition.
6. **Verify in Obsidian** — reload the plugin and screenshot (`obsidian plugin:reload id=…` → `obsidian dev:screenshot`), don't trust the CSS by eye. For modals, also inspect *computed* styles (`getComputedStyle` via `obsidian eval`) on the fields vs the button — a modal renders outside `.mva-root`, so verify tokens resolve and the recipe wins over the theme (see §5 Modal gotcha).
