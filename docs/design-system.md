# ArrangeMySchool design system

An administration ERP: dense, scannable, calm. The brand comes from the star
logo; everything else is neutral so status colors carry meaning. Tokens live
in `timetable-ui/src/styles.css` (`:root`, with dark values under
`prefers-color-scheme: dark` and `[data-theme='dark']`). Components live in
`styles.css` (primitives) and `shell.css` (shell, auth screens, dashboard).

## Tokens

| Group | Tokens | Rule |
|---|---|---|
| Brand | `--accent`, `--accent-text`, `--accent-soft`, `--brand-gradient` | `--accent-text` for text on light surfaces (AA); `--accent` for fills. |
| Surfaces | `--paper`, `--surface`, `--surface-2`, `--line`, `--line-strong` | Cards sit on `--surface` with a `--line` border. |
| Text | `--ink`, `--ink-2`, `--muted` | Never gray-on-gray below `--muted` on `--surface`. |
| Status | `--ok`/`--ok-soft`, `--warn`/`--warn-soft`, `--bad`/`--bad-soft` | Tone always paired with an icon or words, never color alone. |
| Spacing | `--space-1` … `--space-8` (4px base: 4, 8, 12, 16, 20, 24, 32) | Dense by default; use the scale, not raw px, in new CSS. |
| Type | `--text-xs` 11.5 · `--text-sm` 13 · `--text-md` 14 · `--text-lg` 16 · `--text-xl` 20 · `--text-2xl` 28 | Body copy ≥ `--text-sm`; `--text-xs` only for labels and meta. |
| Radius | `--radius` 12, `--radius-lg` 20 | Dense tables/grids use `--radius`; cards and dialogs `--radius-lg`. |
| Elevation | `--shadow` (dense), `--shadow-soft` (chrome) | |
| Motion | `--dur-fast` 150ms, `--dur-base` 220ms, `--ease-out` | Zeroed globally under `prefers-reduced-motion`. |
| Focus | global `:focus-visible` outline in `--accent`, `--focus-ring` | Never remove a focus style without replacing it. |

Fonts: DM Sans (Latin) and Cairo (Arabic), ordered by `dir`. Layout uses
logical properties (`inset-inline-*`, `margin-block-*`) so Arabic RTL works
without overrides.

## Components

- **`.stat-tile`** (`--neutral | --ok | --warn | --bad`): a summary number
  that is also a link into its module; icon + label + value + hint.
- **`.tile-grid`**: auto-fit grid of tiles (min 210px).
- **`.section-head`** (`--split` for trailing actions): page section titles.
- **`.card`**, `.card__head`, `.card__title`, `.card__link`, `.card__empty`.
- **`.activity`**: compact event feed with relative times.
- **`.skeleton`**: loading placeholder that reserves space (no layout shift).
- **`.quick-actions`**: permission-gated shortcut buttons in a page header.

## Rules

- SVG stroke icons (24px grid, `currentColor`), never emoji.
- Touch targets ≥ 40px (44px on the auth screens); links and buttons show
  hover and `:focus-visible` states.
- Gate actions on `useAuth().can(scope)`, the same scope the API enforces.
- Loading, empty and error states for every async block.
- The generated "operations landing" direction (dark slate + green, Fira,
  glassmorphism) was reviewed and not adopted: it conflicts with the logo
  brand, Fira has no Arabic, and glass hurts contrast on dense data.
