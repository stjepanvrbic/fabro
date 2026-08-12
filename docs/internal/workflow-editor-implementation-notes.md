# Workflow editor — implementation notes

Companion to `workflow-editor-design.md`. Records where the build deviated
from the design record's letter and why, plus verification state.

## Deviations

- **Poppins loads from Google Fonts, not self-hosted.** The design record
  says "Poppins, self-hosted at build"; the app loads Geist and JetBrains
  Mono from Google Fonts in `index.template.html`, and the editor follows
  that existing mechanism (one added family in the same link). Self-hosting
  all app fonts is a separate decision for the fork.
- **Upstream's 501 `/api/v1/workflows*` routes stay untouched.** They are
  upstream's future run-catalog surface. The editor claimed its own
  `/api/v1/editor/*` namespace instead, so rebases never collide.
- **Subgraph bodies flatten on parse** (matching the server's semantic
  pass) and count as a lossy construct; the canonical serializer does not
  re-emit subgraph grouping. Files that use clusters remain fully editable
  in the source pane.
- **The `insulator` (wait) shape was missing from the playground's Shape
  union** and was added there; the playground inspector labels it "wait".
- **Skill roots**: repo `.fabro/skills`, `repo/skills`, repo
  `.claude/skills`, `~/.claude/skills`, `~/.agents/skills`; the most
  repo-specific root wins a name collision.

## Acceptance evidence

- Round-trip: `model.test.ts` round-trips the interview fixture (parallel
  verdict edges, freeform edge) and the implement-issue fixture
  (model_stylesheet, dotted keys) semantically, and proves canonical text
  is a fixed point. Server tests prove save commits exactly the workflow
  paths with compare-and-swap conflict refusal, and that a new workflow
  (graph + toml) becomes discoverable.
- New-from-blank produces the same shape as the server test suite's
  minimal run manifest workflow (start → exit with a goal), which the run
  paths already exercise.
- Gates: verdict edges with `[K]` labels and the single `freeform=true`
  edge are edited visually (gate section) and round-trip; component test
  covers the gate panel render.
- Mechanical design detector: two findings, both dispositioned — the
  Geist warning names the incumbent app font (out of the editor's scope);
  the grid-background advisory is the record-pinned dot grid on an actual
  canvas surface (the same finding was adjudicated a false positive in the
  dashboard critique).
- The browser-based finish review (screenshots) could not run on this
  headless box; the mechanical detector ran in its place and the operator
  reviews the surface live.
