# Product

<!-- impeccable:product-schema 1 -->

This file scopes the factory product record to the fork's web UI. The full
product record lives in the factory repo (`~/factory/PRODUCT.md`, ratified
2026-08-12); vocabulary in `~/factory/CONTEXT.md`. Where the two disagree, the
factory repo wins.

## Platform

web

## Users

Stjepan Vrbic — the operator: a solo operator-developer running a personal
software factory on his Linux dev box. He starts runs, answers each run's
thread (interviews, verdicts, escalations, steering), watches live agents, and
authors the workflows the factory executes. He is an expert daily user; this
UI is a cockpit he lives in, not a product he evaluates.

## Product Purpose

This app is the web UI of the factory — a fork of fabro (Rust server, React 19
UI) driving real agent TUIs in tmux through orchestra. Work flows through
deterministic DOT workflows executed as runs; anything needing the human lands
in one thread per run. Success: work flows end-to-end with threads as the only
human touchpoints, every run observable live and auditable afterward — and
every workflow authorable and editable in the UI itself.

## Positioning

Unlike headless orchestrators, the factory drives real interactive agent TUIs
in tmux — every agent watchable and attachable, live. The UI never simulates
what the agent is doing; it shows what is actually happening or says nothing.

## Operating Context

- Single trusted operator on a Linux dev box; served locally (and over
  Tailscale). No multi-tenancy, no onboarding funnel, no unauthenticated use.
- Workflows are Graphviz DOT digraphs stored as files in each target repo. A
  node is agent work or a human gate; a verdict picks a gate's outgoing edge.
- The editor requirement (spec D14, ticket #26): open any workflow file from
  the target repo, edit the graph visually (nodes, edges, gates, per-node
  prompts, timeouts, models), a skill picker inserts slash commands into
  prompts, validate, save. Saving commits to the repo; push is a separate,
  explicit button. Fully generic — nothing dev-flow-specific (spec D11).
- Skills are the operator's existing Claude skills invoked as slash commands
  inside node prompts; agents expand them themselves.
- The fork diff against upstream fabro is kept as small as its features allow.

## Capabilities and Constraints

- From fabro (stock): runs board, live workflow graph with node states,
  per-run SSE, automations with UI CRUD, steering endpoint, checkpoints,
  worktree per run, OpenAPI-first REST API, Playground (chat-driven workflow
  authoring with canvas and client-side simulation — no editing of existing
  repo workflow files; the editor adds that).
- Terminology is binding (CONTEXT.md): workflow, run, node, human gate,
  verdict, interview, escalation, thread, steering, automation, checkpoint,
  operator, ticket, tracker. Avoid: pipeline, task, stage, queue item, chat.
- House rules: no AI attribution anywhere; no skipped tests; React 19 +
  TypeScript + Tailwind per the fabro codebase; direct `useEffect` avoided per
  `docs/internal/react-effects-policy.md`.

## Brand Commitments

- The product is **factory**; the upstream project's name stays on the fork.
- The dashboard design record (design session 2026-08-12, factory repo)
  governs the look of every factory surface in the fork UI, the editor
  included. Binding, recorded without expansion: warm charcoal (not neutral
  black), floating cards on shadow, amber reserved exclusively for
  waiting-on-you, one green family (glow = agent working now, text = done,
  filled = the go action), red = failed and as loud as reviews, blue absent,
  no fake progress — position is progress, Poppins at build, destructive
  actions state their consequence, keyboard as a first-class path.
- Anti-references, recorded: no terminal cosplay, no generic SaaS admin look.

## Evidence on Hand

- Approved spec `~/factory/docs/factory.md` (D11, D14 for the editor); ticket
  stjepanvrbic/factory#26 with acceptance criteria.
- Dashboard design record: decision log and committed-world tokens from the
  2026-08-12 session (critique snapshot at
  `~/factory/.impeccable/critique/2026-08-12T05-43-45Z__dashboard-direction-html.md`,
  28/40 with recorded P1 lessons: failures must be loud, the queue needs a
  surface, confirms state consequences, accessibility is direction).
- Operator visual anchors `~/uiinspo.png` and `~/ui.webp` (the second is a
  node-graph editor in the target aesthetic).
- fabro verified at commit 3226d845 (fork point).

## Product Principles

1. Visible by construction — observability is never bolted on; the UI shows
   real state or says nothing.
2. The human is a conversation participant — anything needing the operator
   surfaces loudly and is answerable in place; nothing blocks silently.
3. Buy the platform, build the identity — fabro carries scheduling and UI
   chrome; we build only what makes the factory itself.
4. No fake progress — a run's position in its graph is its progress; amber
   means waiting-on-you, and nothing else does.
5. Honest writes — saving is a git commit, pushing is a separate explicit
   act; the UI never mutates a repo behind the operator's back.
