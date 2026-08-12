# Design

<!-- impeccable:design-schema 1 -->

Two visual systems live in this app today, deliberately.

- The **incumbent fabro system** — cool navy ground (`--color-page #0F1729`),
  sky-blue teal accents, Geist — carries every stock fabro route. It is
  upstream's identity; the fork does not reskin it wholesale.
- The **factory system** below carries factory surfaces (the workflow editor
  at `/editor` today) per the dashboard design record (2026-08-12, factory
  repo). New factory surfaces (interview thread, run panels, tickets view)
  adopt it as they land; reuse these tokens, never a parallel set.

## The factory world

Warm charcoal, layered, atmospheric. Cards float on shadow with barely-there
borders; inputs are inset darker wells; the ground carries a 22px dot grid
and a faint warm top glow (`.fac-ground`, `.fac-card` in `app.css`).

### Tokens (`@theme` in `app.css`, prefix `fac-`)

| Token | Value | Role |
|---|---|---|
| `--color-fac-ground` | `#1b1918` | page ground |
| `--color-fac-card` | `#232120` | floating cards |
| `--color-fac-well` | `#171514` | inset input wells |
| `--color-fac-ink` | `#f0eeec` | primary text |
| `--color-fac-ink-2` | `#d8d5d2` | secondary text |
| `--color-fac-label` | `#cbc7c4` | field labels (mono, uppercase, 10px) |
| `--color-fac-muted` / `-dim` | `#969290` / `#8f8b88` | tertiary text, ≥4.5:1 on card |
| `--color-fac-line` / `-strong` | white 5% / 9% | hairlines |
| `--color-fac-go` / `-go-text` / `-on-go` | `#8fd460` / `#a8de7c` / `#1b1918` | the go action / confirmations |
| `--color-fac-red` / `-red-bg` / `-red-line` | `#e0756c` / `#261a18` / red 35% | failures and errors, loud |
| `--font-poppins` | Poppins 400/500/600/700 | all factory UI text |

### Color semantics (exclusive, from the design record)

- **Amber = waiting-on-you, only.** Nothing in the editor waits on the
  operator, so amber never appears there. Do not borrow it for warnings.
- **Glow = an agent working now, only.** Nothing in the editor is working,
  so glow never appears there. Busy states are quiet text in the acting
  control ("Committing…").
- **One green family:** filled `fac-go` is the single go action per surface
  (Save in the editor); `fac-go-text` states facts ("valid",
  "committed abc1234"). Never decorative.
- **Red = failure, loud:** validation errors, refused saves, rejected
  pushes. Failed things are never quiet.
- **Blue is absent** on factory surfaces.
- Selection emphasis is ink: white stroke plus a soft white ring.

### Type roles

Poppins: micro 10–11 (labels, uppercase mono-style tracking), meta 11.5–12
(buttons, chips, facts), body 12.5–13, titles 13–14 medium. Tabular numerals
on every count. JetBrains Mono strictly for ids, paths, DOT source, prompts,
and attribute values — never as a costume.

### Interaction rules

- Radius: 14px cards, 10px controls and wells. Shadow over border
  (`0 6px 18px rgba(0,0,0,0.35)`).
- Every control is a real focusable element with a visible
  `focus-visible` outline.
- Destructive or rewriting actions state their consequence in their own
  copy (the lossy-open confirm, push labels carrying the real ahead count).
- No progress bars, no percentages, no fake motion. Transitions are quiet
  color cross-fades (150ms); reduced motion loses nothing.
- Facts over states: "unsaved changes", "committed abc1234",
  "Push · 2 ahead" — each label is a true sentence about the repo.

### Canvas

Graphviz auto-layout; layout is computed, never stored. Node type is
encoded by the workflow language's own shapes, not invented colors. The one
color statement on the canvas is red for validation errors, anchored to the
node or edge the diagnostic names. The dot-grid ground is the record's
pinned texture and marks the one surface that is genuinely a canvas.
