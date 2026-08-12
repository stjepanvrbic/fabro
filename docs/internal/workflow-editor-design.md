# Workflow editor — design record

The generic workflow editor grows out of the Playground (`apps/fabro-web`).
It opens a workflow from a target repo, edits it visually, validates it,
saves it as a git commit, and pushes only on an explicit button. It is fully
generic: any digraph the workflow language allows, nothing specific to one
workflow.

The factory visual language (the dashboard design record, 2026-08-12) governs
this surface. This document records the editor's design so later changes keep
it coherent.

## The core commitment: the file is the artifact

The workflow file in the repo is the source of truth. The editor is a view
over it. The DOT digraph is the only machine-readable layer; the editor
stores no layout, no positions, no sidecar state.

- The client graph model mirrors the server's semantic model
  (`fabro_types::graph`): nodes and edges carry open attribute maps; graph
  attributes (`goal`, `model_stylesheet`, `rankdir`, and any other) are kept
  and editable. Edges are addressed by index: parallel edges between the
  same pair and self-loops are legal in the language and in the editor.
- Visual edits re-render the file through the canonical serializer (the
  same style the repo's own workflow files use).
- **Lossy-open contract.** When a file carries constructs the canonical
  form rewrites (comments, subgraphs, `node [...]`/`edge [...]` default
  statements), the canvas opens view-only and the first visual edit asks
  with the real consequence: "Visual edits rewrite this file in canonical
  form; its 3 comments will be dropped. Edit the source to keep them."
  Source edits are always lossless and never gated.
- The source pane is a first-class editor, two-way with the canvas. A parse
  error keeps the last good graph dimmed and shows the error with line and
  column; the source stays editable throughout.

## Composition

Full-height, wide route (`/editor`), same shell flags as the Playground.
Warm charcoal ground with the dot grid; panels are floating cards.

- **Entry.** Repo path input with recent repos; workflow list (name, goal,
  project/user source) from the server's discovery; "New workflow" seeds a
  start → exit skeleton. Deep link: `/editor?repo=…&workflow=…`.
- **Top bar.** Identity (repo · path · name, mono), plain-ink "unsaved
  changes", validation chip (red count of errors — failures are loud;
  quiet green "valid" when clean), Save (filled green; the go action),
  Push (secondary, real ahead count: "Push · 2 ahead").
- **Canvas.** Graphviz auto-layout (layout is computed, never stored),
  pan/zoom/fit, nodes and edges selectable. Selection is ink emphasis with
  a soft white ring. Diagnostics badge the nodes and edges they name.
- **Inspector (right).** The editing surface, per selection:
  - Node: id (rename rewires edges), type (the ten node types under their
    plain-language names), label, prompt (tall mono textarea with the
    skill picker), model, provider, timeout, reasoning effort, and a
    generic attribute table (add/edit/delete any attribute) — the escape
    hatch that keeps the editor generic.
  - Human gate: question type, verdict edges (label with accelerator,
    target, add/remove), freeform toggle (one `freeform=true` edge and its
    target), default choice on timeout.
  - Edge: label, condition, weight, fidelity, freeform.
  - Nothing selected: graph panel — name, goal, rankdir, model stylesheet
    (mono textarea), generic graph-attribute table.
- **Source pane (bottom).** `workflow.fabro` with DOT highlighting,
  editable; `workflow.toml` read-only tab.
- **Skill picker.** In the prompt editor, "/" at a word start (or the
  button) opens a filterable list of the operator's skills (name and
  one-line description, source-labeled) and inserts `/name ` at the
  cursor.

## Server surface (fork endpoints, spec-first)

Upstream's real-mode `/api/v1/workflows*` routes are 501 stubs; the fork
fills them. All fork endpoints follow the OpenAPI-first workflow.

- `GET /api/v1/workflows?repo=<path>` — discovery via
  `fabro_config::project` (workflow.toml-keyed).
- `GET /api/v1/workflows/{name}?repo=<path>` — sources plus the base blob
  oid for conflict detection.
- `PUT /api/v1/workflows/{name}?repo=<path>` — body: sources, base oid,
  commit message. Writes the files, stages exactly those paths, commits.
  Compare-and-swap on the base oid: a file changed on disk refuses with
  the real state. Creating a new workflow writes both `workflow.fabro`
  and `workflow.toml` (discovery requires the toml).
- `POST /api/v1/workflows/validate` — body: inline source. Runs the real
  parser and the 31 lint rules; returns diagnostics with rule, severity,
  message, node id, edge, line, column.
- `GET /api/v1/repos/status?repo=<path>` — current branch, ahead count,
  dirty state in scope.
- `POST /api/v1/repos/push?repo=<path>` — pushes the current branch,
  non-interactive, never force.
- `GET /api/v1/skills?repo=<path>` — SKILL.md discovery (fabro's
  `parse_skill`) over the conventional roots: `<repo>/.fabro/skills`,
  `<repo>/skills`, `<repo>/.claude/skills`, `~/.claude/skills`,
  `~/.agents/skills`.

The repo path must contain `.fabro/project.toml`; anything else is refused
at the boundary. The server is a local, single-operator surface.

## Validation model

Two layers. The client keeps the cheap structural guards that match the
server's lint rules (no edges out of exit, none into start, reserved ids).
Everything else is the server's job: validation runs debounced while
editing and always before save; save is blocked only by errors, never by
warnings. Diagnostics render in three places: the top-bar chip (count),
the source pane (line markers), and the canvas (badges on the named node
or edge).

## Color, type, motion (the committed world, applied)

- Ground `#1b1918` with the dot grid and faint warm top glow; cards
  `#232120`, 14px radius, shadow over border; inputs are inset darker
  wells.
- Poppins for UI text — micro 11 / meta 12 / body 13 / title 14–16,
  tabular numerals for counts. JetBrains Mono only for ids, paths, DOT
  source, prompts, attribute values.
- **Amber appears nowhere in the editor** — nothing here waits on the
  operator. **Glow appears nowhere** — nothing here is a working agent.
  Green: filled fill for the one go action (Save); text green for "valid"
  and "committed abc1234" facts. Red for validation errors and failed
  operations, loud. Blue absent.
- Node type is encoded by the language's own shapes; no invented
  color-per-type taxonomy.
- Motion is quiet feedback only: 150 ms cross-fades, no choreography, no
  loops. Busy states are factual ("committing…") inside the acting
  button. Reduced motion loses nothing.

## Keyboard

`n` add node · `e` connect (click source, then target) · `Delete` removes
the selection · `Cmd+S` save · `Cmd+Z` / `Shift+Cmd+Z` undo and redo
(in-memory, visual and source edits alike) · `Esc` deselects or closes the
picker · arrows or `j`/`k` cycle nodes · `/` opens the skill picker inside
a prompt.

Every control is a real focusable element with a visible focus state; the
inspector takes focus when opened from the canvas and returns it.

## States

- New from blank: seeded skeleton, name asked inline, runnable after save.
- Parse-failure open: source-only mode with the honest error.
- Lossy open: the consequence confirm above.
- Changed on disk: save refuses and says so; reload is offered.
- Push behind or diverged: the honest git state, no force, no retry
  theater.
- Save lifecycle facts: unsaved changes → validating → committing →
  committed <sha> → Push · n ahead.

## Anti-goals

No simulation (the Playground keeps it; nothing fakes execution here). No
chat authoring in the editor. No manual node positioning or position
persistence. No autosave commits. No push without the button. No amber, no
glow, no progress bars.
