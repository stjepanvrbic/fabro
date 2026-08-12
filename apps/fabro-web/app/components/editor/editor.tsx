/**
 * The workflow editor surface: canvas + inspector over a source pane, on
 * the factory's warm charcoal ground. The file is the artifact — visual
 * edits rewrite it in canonical form (gated by a consequence confirm when
 * the file carries constructs that rewrite would drop), source edits are
 * always lossless. Saving is a commit; pushing is its own button.
 */

import { useMemo, useState } from "react";
import { PlusIcon, XMarkIcon } from "@heroicons/react/16/solid";
import {
  ArrowUturnLeftIcon,
  ArrowUturnRightIcon,
} from "@heroicons/react/24/outline";

import type { EditorSkill, EditorWorkflowFileResponse } from "@qltysh/fabro-api-client";
import { ConfirmDialog } from "~/components/ui";
import { ApiError } from "~/lib/api-client";
import {
  usePushRepo,
  useSaveWorkflow,
  useWorkflowValidation,
  useEditorRepoStatus,
} from "~/lib/editor-queries";
import EditorCanvas from "./canvas/canvas";
import {
  addEdge,
  addNode,
  deleteEdge,
  deleteNode,
  type EditResult,
} from "./model/edit";
import { isValidNodeId, lossyDescription, type Shape } from "./model/graph";
import EdgePanel from "./inspector/edge-panel";
import { Field } from "./inspector/fields";
import GraphPanel from "./inspector/graph-panel";
import NodePanel from "./inspector/node-panel";
import SourcePane from "./source-pane";
import TopBar, { type PushState, type SaveState } from "./top-bar";
import { GHOST_BUTTON_CLASS, WELL_INPUT_CLASS, WELL_SELECT_CLASS } from "./ui";
import { useEditorState } from "./use-editor-state";

const ADD_NODE_TYPES: readonly { value: Shape; label: string }[] = [
  { value: "box", label: "agent" },
  { value: "tab", label: "prompt call" },
  { value: "parallelogram", label: "command" },
  { value: "hexagon", label: "human gate" },
  { value: "diamond", label: "conditional" },
  { value: "component", label: "parallel fan-out" },
  { value: "tripleoctagon", label: "merge fan-in" },
  { value: "insulator", label: "wait" },
  { value: "house", label: "sub-workflow" },
];

export default function Editor({
  repo,
  path,
  file,
  skills,
  onClose,
}: {
  repo: string;
  path: string;
  /** The opened file; `null` fields for a new workflow. */
  file: EditorWorkflowFileResponse;
  skills: readonly EditorSkill[];
  onClose: () => void;
}) {
  const editor = useEditorState(file.fabro_source, file.base_oid || null);
  const [pendingEdit, setPendingEdit] = useState<EditResult | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const [pushState, setPushState] = useState<PushState>({ kind: "idle" });
  const [addingNode, setAddingNode] = useState(false);

  const validation = useWorkflowValidation(
    editor.parse.ok ? editor.state.source : null,
  );
  const diagnostics = useMemo(
    () => validation.data?.diagnostics ?? [],
    [validation.data],
  );
  const errorNodes = useMemo(
    () =>
      new Set(
        diagnostics
          .filter((d) => d.severity === "error" && d.node_id)
          .map((d) => d.node_id!),
      ),
    [diagnostics],
  );
  const errorEdges = useMemo(() => {
    const indexes = new Set<number>();
    if (!editor.graph) return indexes;
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity !== "error") continue;
      if (!diagnostic.edge_from || !diagnostic.edge_to) continue;
      editor.graph.edges.forEach((edge, index) => {
        if (edge.from === diagnostic.edge_from && edge.to === diagnostic.edge_to) {
          indexes.add(index);
        }
      });
    }
    return indexes;
  }, [diagnostics, editor.graph]);
  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter((d) => d.severity === "warning").length;

  const repoStatus = useEditorRepoStatus(repo);
  const save = useSaveWorkflow(repo, path);
  const push = usePushRepo(repo);

  // A visual edit on a lossy file waits behind the consequence confirm.
  const applyVisualEdit = (result: EditResult) => {
    if (result.ok && editor.needsLossyConfirm) {
      setPendingEdit(result);
      return;
    }
    editor.applyEdit(result);
  };

  const handleSave = async (commitMessage: string) => {
    setSaveState({ kind: "committing" });
    try {
      const response = await save.trigger({
        fabro_source: editor.state.source,
        toml_source:
          file.toml_source === null && editor.state.baseOid === null
            ? "_version = 1\n"
            : undefined,
        base_oid: editor.state.baseOid ?? undefined,
        commit_message: commitMessage,
      });
      editor.markSaved(response.base_oid);
      setSaveState({ kind: "committed", sha: response.commit_sha });
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : "The save failed; the repo was not changed.";
      setSaveState({ kind: "failed", message });
    }
  };

  const handlePush = async () => {
    setPushState({ kind: "pushing" });
    try {
      const response = await push.trigger();
      setPushState({ kind: "pushed", count: response.pushed_commits });
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : "The push was rejected.";
      setPushState({ kind: "failed", message });
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    const typing =
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT";
    if ((event.metaKey || event.ctrlKey) && event.key === "s") {
      event.preventDefault();
      if (editor.dirty && editor.parse.ok && errorCount === 0) {
        void handleSave(defaultCommitMessage);
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "z") {
      if (typing) return;
      event.preventDefault();
      if (event.shiftKey) {
        editor.redo();
      } else {
        editor.undo();
      }
      return;
    }
    if (typing) return;
    if (event.key === "Escape") {
      if (editor.state.connectFrom) {
        editor.connectCancel();
      } else {
        editor.select({ kind: "graph" });
      }
      return;
    }
    if (!editor.graph) return;
    if (event.key === "n") {
      setAddingNode(true);
      return;
    }
    if (event.key === "e" && editor.state.selection.kind === "node") {
      editor.connectStart(editor.state.selection.id);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      const selection = editor.state.selection;
      if (selection.kind === "node") {
        applyVisualEdit(deleteNode(editor.graph, selection.id));
      } else if (selection.kind === "edge") {
        applyVisualEdit(deleteEdge(editor.graph, selection.index));
      }
      return;
    }
    if (event.key === "j" || event.key === "ArrowDown" || event.key === "k" || event.key === "ArrowUp") {
      const nodes = editor.graph.nodes;
      const current =
        editor.state.selection.kind === "node"
          ? nodes.findIndex((node) => node.id === (editor.state.selection as { id: string }).id)
          : -1;
      const forward = event.key === "j" || event.key === "ArrowDown";
      const next = forward
        ? nodes[(current + 1) % nodes.length]
        : nodes[(current - 1 + nodes.length) % nodes.length];
      if (next) editor.select({ kind: "node", id: next.id });
    }
  };

  const workflowName = editor.graph?.name ?? path;
  const defaultCommitMessage =
    editor.state.baseOid === null
      ? `Add ${workflowName} workflow`
      : `Edit ${workflowName} workflow`;

  return (
    // The surface owns its keyboard map; every control inside remains a real
    // focusable element, so this handler only adds accelerators.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      role="application"
      aria-label="Workflow editor"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="fac-ground flex h-full min-h-0 flex-col gap-3 p-3 font-[family-name:var(--font-poppins)] text-fac-ink outline-none"
    >
      <TopBar
        repo={repo}
        path={path}
        dirty={editor.dirty}
        parseOk={editor.parse.ok}
        errorCount={errorCount}
        warningCount={warningCount}
        validating={validation.isLoading}
        saveState={saveState}
        pushState={pushState}
        repoStatus={repoStatus.data}
        defaultCommitMessage={defaultCommitMessage}
        onSave={(msg) => void handleSave(msg)}
        onPush={() => void handlePush()}
        onClose={onClose}
      />

      <div className="grid min-h-0 flex-1 grid-rows-[3fr_2fr] gap-3">
        <div className="grid min-h-0 grid-cols-[1fr_340px] gap-3">
          {editor.graph ? (
            <EditorCanvas
              graph={editor.graph}
              diagnostics={{ errorNodes, errorEdges }}
              selection={editor.state.selection}
              connectFrom={editor.state.connectFrom}
              onSelect={editor.select}
              onConnectTo={(target) => {
                const from = editor.state.connectFrom;
                if (from && editor.graph) {
                  applyVisualEdit(addEdge(editor.graph, from, target));
                }
              }}
            />
          ) : (
            <div className="fac-card flex items-center justify-center p-6">
              <p className="max-w-md text-center text-[13px] leading-relaxed text-fac-muted">
                The source does not parse, so the canvas is off. Fix the
                error shown under the source — the text is the artifact and
                editing it is always safe.
              </p>
            </div>
          )}

          <aside className="fac-card flex h-full min-h-0 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center justify-between border-b border-fac-line px-3 py-2">
              <span className="font-mono text-[10.5px] uppercase tracking-wider text-fac-label">
                {editor.state.selection.kind === "node"
                  ? "Node"
                  : editor.state.selection.kind === "edge"
                    ? "Edge"
                    : "Workflow"}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Undo"
                  title="Undo (Cmd+Z)"
                  onClick={editor.undo}
                  disabled={!editor.canUndo}
                  className="flex size-6 items-center justify-center rounded text-fac-muted transition-colors hover:bg-fac-hover hover:text-fac-ink disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fac-ink/60"
                >
                  <ArrowUturnLeftIcon className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Redo"
                  title="Redo (Shift+Cmd+Z)"
                  onClick={editor.redo}
                  disabled={!editor.canRedo}
                  className="flex size-6 items-center justify-center rounded text-fac-muted transition-colors hover:bg-fac-hover hover:text-fac-ink disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fac-ink/60"
                >
                  <ArrowUturnRightIcon className="size-3.5" />
                </button>
                {editor.graph && (
                  <button
                    type="button"
                    onClick={() => setAddingNode(true)}
                    className="ml-1 inline-flex items-center gap-1 rounded-[8px] px-2 py-1 text-[11.5px] font-medium text-fac-muted transition-colors hover:bg-fac-hover hover:text-fac-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fac-ink/60"
                  >
                    <PlusIcon className="size-3.5" />
                    Node
                  </button>
                )}
              </div>
            </div>

            {editor.state.editError && (
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-fac-red-line bg-fac-red-bg px-3 py-1.5 text-[12px] text-fac-red">
                <span>{editor.state.editError}</span>
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={editor.clearEditError}
                  className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-fac-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fac-red"
                >
                  <XMarkIcon className="size-3.5" />
                </button>
              </div>
            )}

            {addingNode && editor.graph && (
              <AddNodeForm
                onAdd={(id, shape) => {
                  applyVisualEdit(addNode(editor.graph!, id, shape));
                  setAddingNode(false);
                }}
                onCancel={() => setAddingNode(false)}
              />
            )}

            <div className="min-h-0 flex-1 overflow-auto">
              {editor.graph &&
                (editor.state.selection.kind === "node" ? (
                  <NodePanel
                    key={editor.state.selection.id}
                    graph={editor.graph}
                    node={
                      editor.graph.nodes.find(
                        (node) =>
                          node.id ===
                          (editor.state.selection as { id: string }).id,
                      ) ?? editor.graph.nodes[0]!
                    }
                    skills={skills}
                    onApply={applyVisualEdit}
                    onConnectStart={editor.connectStart}
                  />
                ) : editor.state.selection.kind === "edge" ? (
                  <EdgePanel
                    key={editor.state.selection.index}
                    graph={editor.graph}
                    index={editor.state.selection.index}
                    onApply={applyVisualEdit}
                  />
                ) : (
                  <GraphPanel graph={editor.graph} onApply={applyVisualEdit} />
                ))}
            </div>
          </aside>
        </div>

        <SourcePane
          source={editor.state.source}
          onEdit={editor.editSource}
          parse={editor.parse}
          diagnostics={diagnostics}
          tomlPath={file.toml_path ?? null}
          tomlSource={file.toml_source ?? null}
        />
      </div>

      <ConfirmDialog
        open={pendingEdit !== null}
        title="Rewrite this file in canonical form?"
        description={
          editor.graph
            ? `Visual edits rewrite the file in the canonical style; its ${lossyDescription(
                editor.graph.lossy,
              )} will be dropped. Edit the source pane instead to keep them.`
            : ""
        }
        confirmLabel="Rewrite and continue"
        onConfirm={() => {
          if (pendingEdit) {
            editor.acceptLossy();
            editor.applyEdit(pendingEdit);
          }
          setPendingEdit(null);
        }}
        onCancel={() => setPendingEdit(null)}
      />
    </div>
  );
}

function AddNodeForm({
  onAdd,
  onCancel,
}: {
  onAdd: (id: string, shape: Shape) => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState("");
  const [shape, setShape] = useState<Shape>("box");
  const valid = isValidNodeId(id);

  return (
    <div className="shrink-0 space-y-2 border-b border-fac-line bg-fac-well/60 p-3">
      <Field label="new node">
        <div className="flex items-center gap-1.5">
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the form opens on explicit request; focus belongs in the id field
            autoFocus
            type="text"
            aria-label="New node id"
            placeholder="node_id"
            className={`${WELL_INPUT_CLASS} font-mono`}
            value={id}
            onChange={(event) => setId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && valid) onAdd(id, shape);
              if (event.key === "Escape") onCancel();
              event.stopPropagation();
            }}
          />
          <select
            aria-label="New node type"
            className={`${WELL_SELECT_CLASS} w-2/5 shrink-0`}
            value={shape}
            onChange={(event) => setShape(event.target.value as Shape)}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {ADD_NODE_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </Field>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onAdd(id, shape)}
          disabled={!valid}
          className={GHOST_BUTTON_CLASS}
        >
          Add
        </button>
        <button type="button" onClick={onCancel} className={GHOST_BUTTON_CLASS}>
          Cancel
        </button>
      </div>
    </div>
  );
}
