---
version: 1
slug: "app-routes-editor-tsx"
primary_target: "app/routes/editor.tsx"
related_targets: ["app/components/editor"]
---

# Surface: generic workflow editor (/editor)

Mode: Operate. Scope: the editor route, its components under
`app/components/editor/`, and the shared playground state modules it grows
from.

Audience and job: the operator (expert, daily) opens a workflow file from a
target repo, edits the graph visually or in source, validates, saves as a
commit, pushes on a separate explicit button; or authors a new workflow from
blank. Fully generic — any digraph the workflow language allows (ticket
stjepanvrbic/factory#26; spec D11/D14).

Chosen direction: the file is the artifact; the editor is a view. Extended
draft model mirrors the server's attrs-map graph model (parallel edges,
self-loops, all graph attrs). Canonical-form save with a lossy-open
consequence confirm (comments/subgraphs/defaults); source pane is first-class
and always lossless. Canvas keeps Graphviz auto-layout — no position store.
Inspector is the editing surface; gate editing = verdict edges + freeform
toggle. Skill picker inserts slash commands into prompts. Server: fork fills
upstream's 501 /workflows routes plus validate/status/push/skills, spec-first.
Full design record: docs/internal/workflow-editor-design.md (authoritative
for this surface).

Memorable moment: diagnostics land on the graph itself — the failing node
wears its error where the operator is looking.

Color semantics on this surface: amber and glow never appear (nothing waits,
nothing works); filled green = Save only; red = errors, loud; selection is
ink + white ring.

Unresolved, assumed (operator away, spec-backed): repo entry is a typed local
path with recents (no registry exists); commit message inline, prefilled;
skill roots = repo .fabro/skills, repo/skills, repo/.claude/skills,
~/.claude/skills, ~/.agents/skills.
