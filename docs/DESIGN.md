# Minetrack design spec

This spec covers the "New" design (`[data-design-root="new"]`, `assets/css/main.css`).
The legacy design (`legacy.css`) is frozen and is out of scope.

Minetrack follows a **Linear-style** look: a near-black canvas, quiet surfaces, one
neutral type family, colour only where it carries data, and small, precise controls.
The aim is a page that is calm to look at and quick to read: the graph and the
player counts should stand out, and everything else should step back.

The rules below are based on:
- **Refactoring UI** (Wathan & Schoger): fixed scales, hierarchy from weight and colour before size, de-emphasise rather than emphasise.
- **WCAG 2.2 AA**: 4.5:1 contrast for text, 3:1 for UI boundaries and focus indicators, visible focus, target size.
- **IBM Carbon data-visualisation guidelines** for the chart: quiet gridlines, legible axes, colour reserved for series.
- **Practical Typography** (Butterick): tabular figures for numbers, restrained letter-spacing, comfortable line height.

Every value in the stylesheet should come from the tokens below. A value that is not
on a scale needs a comment saying why (for example, an optical nudge).

## 1. Colour

All colours are CSS custom properties on `:root`. Contrast figures are against
`--canvas` / `--surface-1`.

| Token | Value | Use | Contrast |
|---|---|---|---|
| `--canvas` | `#08090a` | Page background | — |
| `--surface-1` | `#141516` | Cards, row hover, inputs | — |
| `--surface-2` | `#1c1c1f` | Popovers, tooltip, dock | — |
| `--surface-3` | `#23252a` | Hover inside popovers | — |
| `--surface-4` | `#2d2e31` | Text selection | — |
| `--line` | `#23252a` | Dividers, resting borders | decorative |
| `--line-strong` | `#34343a` | Hover borders, popover borders | decorative |
| `--text` | `#f7f8f8` | Primary text, active state | 19+:1 |
| `--text-secondary` | `#d0d6e0` | Supporting text that must still read well | 12.5:1 |
| `--text-muted` | `#8a8f98` | Secondary labels, resting controls | 5.6:1 |
| `--text-tertiary` | `#7c8089` | Least important *readable* text: column titles, ranks, axis labels, placeholders | ≥4.5:1 |
| `--text-quaternary` | `#62666d` | Disabled and purely decorative marks only, never information | 3.2:1 (exempt) |
| `--accent` | `#7170ff` | Focus rings, drag selection on the graph, the one "you are here" highlight | 4.8:1 |
| `--up` | `#4cb782` | Rising trend | 7.3:1 |
| `--down` | `#eb5757` | Falling trend, invalid input | 5.3:1 |

Rules:
- **Four levels of text, no more.** Pick by importance: `--text` → `--text-secondary` → `--text-muted` → `--text-tertiary`. Text a user needs to read is never below `--text-tertiary`.
- **Colour means data.** Server colours appear only on the graph lines, status dots, sparklines and comparison highlights. UI chrome stays grey; `--accent` is the only non-grey UI colour.
- **No raw hex values** outside `:root` in CSS. JS that has to pass colours to the canvas (uPlot) reads them from the tokens (see `cssVar()` in `graph.js`) rather than hard-coding them.
- Errors use `--down`; there is no separate red.

## 2. Typography

Families: `--font-sans` (Inter, variable) for everything; `--font-mono` (JetBrains Mono)
for addresses, timestamps and axis labels. Numbers in the list use Inter with tabular
figures rather than mono, so counts align without looking like code.

| Token | Size / line height | Use |
|---|---|---|
| `--text-micro` | 11px / 16px | Uppercase column titles, axis labels, trend deltas, pills |
| `--text-small` | 12px / 16px | Controls, menus, tooltip rows, footer, addresses |
| `--text-regular` | 13px / 20px | Body default, server names, search |
| `--text-large` | 15px / 20px | Brand, player counts |
| `--text-title` | 20px / 24px | Live total in the top bar |

- 16px is used only for text inputs on phones, because iOS zooms the page on smaller ones.
- Weights: **400** (regular), **510** (medium: names, controls, active labels), **590** (semibold: brand only). No 500, no bold.
- Letter-spacing: `-0.01em` for body text and `-0.02em` at 15px and above. Uppercase micro labels get `+0.04em`.
- Every number that updates (counts, records, totals, ranks, times) uses `font-variant-numeric: tabular-nums` so it does not jitter as it changes.
- Hierarchy comes from colour and weight first. Do not add a new size to make something stand out.

## 3. Spacing and layout

Base unit 4px. Scale: **4, 8, 12, 16, 24, 32, 48, 64**.

- 2px is allowed only for optical nudges inside a text block (for example, the gap between a server name and its address), and must be commented.
- Content column: `min(1080px, 100% - 32px)` on desktop, 16px side gutter on phones.
- Section rhythm: 48px between major sections on desktop, 24px on phones.
- Inside components: 8px between related items, 16px between groups, 24px between a heading and its block.
- List rows: 48px minimum height (56px is fine where a row has two lines of text), and every column lines up with its header.
- One alignment edge per column. Text in the header starts exactly where the row text below it starts.
- A server's status dot sits on the corner of its icon (like presence on an avatar), so the name, address, column title and "Add new server" share one left edge.
- A count's trend sits on the same line, to its left, so every count is centred in its row whether or not it has a trend.

## 4. Shape and elevation

| Token | Value | Use |
|---|---|---|
| `--radius-s` | 4px | Buttons, inputs, favicons, menu items |
| `--radius-m` | 6px | Menus, tooltip, dock |
| `--radius-l` | 8px | Cards (graph panel, empty state) |
| `--radius-full` | 9999px | Pills, dots |

- Resting surfaces are flat: a 1px `--line` border, no shadow.
- Floating surfaces (menus, tooltip, dock) use `--surface-2`, a 1px `--line-strong` border and `--shadow-pop`: `0 8px 24px rgba(0,0,0,.4), 0 2px 4px rgba(0,0,0,.2)`.
- No gradients and no glows.

## 5. Controls

- **Heights:** 28px for toolbar controls on desktop and 32px for the search box. On phones, controls are at least 36px tall and touch targets at least 40px.
- **States, in this order of strength:** resting (`--text-muted`, `--line` border) → hover (`--text`, `--line-strong` border or `--surface-1` fill) → active/selected (`--text`, plus a filled or checked indicator) → disabled (`--text-quaternary`, no hover).
- **Focus:** every interactive element shows `outline: 2px solid var(--accent); outline-offset: 2px` on `:focus-visible` (inset by 2px on full-width rows). Never remove an outline without a replacement.
- Icon-only buttons have an `aria-label` and a hit area of at least 24×24px on desktop.

## 6. Motion

- `--ease`: `cubic-bezier(.25, .1, .25, 1)`. Durations: `--dur-fast` 120ms (colour, border, background, opacity) and `--dur-base` 200ms (menus opening, the dock appearing).
- Hover and state changes on controls and rows transition with `--dur-fast`. Nothing moves on hover; only colour changes.
- `prefers-reduced-motion: reduce` turns off all transitions and animations except opacity changes.

## 7. The graph

- The plot area has no background of its own; it sits on the `--surface-1` card.
- Gridlines: horizontal only, `--line`, 1px. No vertical gridlines; time is read from the axis.
- Axis labels: `--text-micro` mono in `--text-tertiary`. No tick marks.
- Series: 1.5px lines in the server's colour. "Last week" lines are dashed at 60% opacity in the same colour.
- Hover: a 1px `--line-strong` crosshair, a dot on the hovered series, and a tooltip on `--surface-2`.
- Drag selection uses `--accent` at 16% fill with 1px `--accent` edges.
- Sparklines in the list are 1.5px, with no axes, at 45% opacity until their row is hovered or selected.
- Y axis steps go 1, 2 or 5 × 10ⁿ with about five gridlines. X axis labels are one line: times, or days once each step is a day or more. Days are also named inside the plot at each midnight.
- Server colours too dark to see on the card (below 3:1 against `--surface-1`) are lightened in the browser, keeping their hue.

## 8. States

- **Loading:** skeleton blocks at the final size of what they stand in for, pulsing `--surface-1` → `--surface-2`.
- **Empty:** a bordered `--radius-l` box with one sentence and one action.
- **Offline server:** the row stays in place, its text drops to `--text-tertiary`, and an "offline" pill replaces the count.
- **Comparing:** selected rows get a 2px inset bar and a 7% tint in their series colour; the other rows drop to 70% opacity, which keeps their text readable.

## Checklist for changes

- [ ] Every new value is a token or on a scale (or commented).
- [ ] Text a user must read is ≥4.5:1 against its background.
- [ ] Hover, focus-visible, active and disabled states are all defined.
- [ ] Checked at 1280×900 desktop and iPhone 13 size, scrolled and at rest.
- [ ] `prefers-reduced-motion` respected.
