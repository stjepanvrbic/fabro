/**
 * Node editing panel. Named fields cover each node type's primary
 * attributes (per the workflow language reference); the attribute table
 * underneath carries everything else, so no attribute the language grows is
 * ever out of reach.
 */

import { useRef, useState } from "react";
import { PlusIcon, XMarkIcon } from "@heroicons/react/16/solid";

import type { EditorSkill } from "@qltysh/fabro-api-client";
import type { AttrValue, Node, Shape, WorkflowGraph } from "../model/graph";
import { EXIT_ID, START_ID } from "../model/graph";
import {
  addEdge,
  deleteEdge,
  deleteNode,
  renameNode,
  retargetEdge,
  setFreeformEdge,
  updateEdge,
  updateNode,
  type EditResult,
} from "../model/edit";
import { DANGER_TEXT_BUTTON_CLASS, FIELD_LABEL_CLASS, WELL_SELECT_CLASS } from "../ui";
import AttrTable, { coerceAttrValue, formatAttrValue } from "./attr-table";
import { CommitInput, CommitSelect, CommitTextarea, Field } from "./fields";
import SkillPicker from "./skill-picker";

const TYPE_OPTIONS: readonly { value: Shape; label: string }[] = [
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

const REASONING_OPTIONS = [
  { value: "", label: "default (high)" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
] as const;

const FIDELITY_OPTIONS = [
  { value: "", label: "default (compact)" },
  { value: "compact", label: "compact" },
  { value: "full", label: "full" },
  { value: "summary:high", label: "summary: high" },
  { value: "summary:medium", label: "summary: medium" },
  { value: "summary:low", label: "summary: low" },
  { value: "truncate", label: "truncate" },
] as const;

const QUESTION_TYPE_OPTIONS = [
  { value: "", label: "inferred from edges" },
  { value: "yes_no", label: "yes / no" },
  { value: "confirmation", label: "confirmation" },
  { value: "multiple_choice", label: "multiple choice" },
  { value: "multi_select", label: "multi select" },
  { value: "freeform", label: "freeform" },
] as const;

/** Attr keys with named fields, hidden from the generic table. */
const NAMED_ATTRS: Record<string, readonly string[]> = {
  box: ["model", "provider", "timeout", "reasoning_effort", "fidelity"],
  tab: ["model", "provider", "timeout", "reasoning_effort", "fidelity"],
  parallelogram: ["script", "language", "stdin_source", "timeout"],
  hexagon: ["question_type", "human.default_choice", "timeout"],
  diamond: [],
  component: ["max_parallel", "for_each"],
  tripleoctagon: ["model", "provider", "timeout", "reasoning_effort", "fidelity"],
  insulator: ["duration"],
  house: ["stack.child_workflow", "manager.max_cycles"],
  mdiamond: [],
  msquare: [],
};

export default function NodePanel({
  graph,
  node,
  skills,
  onApply,
  onConnectStart,
}: {
  graph: WorkflowGraph;
  node: Node;
  skills: readonly EditorSkill[];
  onApply: (result: EditResult) => void;
  onConnectStart: (from: string) => void;
}) {
  const isTerminal = node.shape === "mdiamond" || node.shape === "msquare";
  const attrs = node.attrs ?? {};

  const setAttr = (key: string, value: AttrValue | undefined) => {
    const next = { ...attrs };
    if (value === undefined || value === "") {
      delete next[key];
    } else {
      next[key] = value;
    }
    onApply(updateNode(graph, node.id, { attrs: next }));
  };

  const attrString = (key: string): string => {
    const value = attrs[key];
    return value === undefined ? "" : formatAttrValue(value);
  };

  return (
    <div className="space-y-3 p-3">
      {!isTerminal && (
        <>
          <Field label="id">
            <CommitInput
              key={node.id}
              ariaLabel="Node id"
              mono
              value={node.id}
              onCommit={(next) => onApply(renameNode(graph, node.id, next))}
            />
          </Field>
          <Field label="type">
            <CommitSelect
              ariaLabel="Node type"
              value={node.shape}
              options={TYPE_OPTIONS}
              onCommit={(next) =>
                onApply(updateNode(graph, node.id, { shape: next as Shape }))
              }
            />
          </Field>
        </>
      )}
      <Field label={node.shape === "hexagon" ? "question" : "label"}>
        <CommitInput
          key={`${node.id}:label:${node.label}`}
          ariaLabel="Node label"
          value={node.label}
          onCommit={(next) => onApply(updateNode(graph, node.id, { label: next }))}
        />
      </Field>

      {(node.shape === "box" ||
        node.shape === "tab" ||
        node.shape === "tripleoctagon") && (
        <PromptField
          node={node}
          graph={graph}
          skills={skills}
          onApply={onApply}
        />
      )}

      {node.shape === "parallelogram" && (
        <>
          <Field label="script">
            <CommitTextarea
              key={`${node.id}:script:${attrString("script")}`}
              ariaLabel="Command script"
              rows={4}
              value={attrString("script")}
              onCommit={(next) => setAttr("script", next)}
            />
          </Field>
          <Field label="language">
            <CommitSelect
              ariaLabel="Script language"
              value={attrString("language")}
              options={[
                { value: "", label: "shell (default)" },
                { value: "python", label: "python" },
              ]}
              onCommit={(next) => setAttr("language", next)}
            />
          </Field>
          <Field label="stdin source">
            <CommitInput
              key={`${node.id}:stdin:${attrString("stdin_source")}`}
              ariaLabel="Stdin source context key"
              mono
              value={attrString("stdin_source")}
              placeholder="context.KEY"
              onCommit={(next) => setAttr("stdin_source", next)}
            />
          </Field>
        </>
      )}

      {node.shape === "hexagon" && (
        <GateSection graph={graph} node={node} onApply={onApply} />
      )}

      {node.shape === "component" && (
        <>
          <Field label="max parallel">
            <CommitInput
              key={`${node.id}:maxp:${attrString("max_parallel")}`}
              ariaLabel="Maximum parallel branches"
              mono
              value={attrString("max_parallel")}
              placeholder="4"
              onCommit={(next) =>
                setAttr("max_parallel", next === "" ? undefined : coerceAttrValue(next))
              }
            />
          </Field>
          <Field label="for each">
            <CommitInput
              key={`${node.id}:foreach:${attrString("for_each")}`}
              ariaLabel="For-each context key"
              mono
              value={attrString("for_each")}
              placeholder="context.items"
              onCommit={(next) => setAttr("for_each", next)}
            />
          </Field>
        </>
      )}

      {node.shape === "insulator" && (
        <Field label="duration">
          <CommitInput
            key={`${node.id}:duration:${attrString("duration")}`}
            ariaLabel="Wait duration"
            mono
            value={attrString("duration")}
            placeholder="30s"
            onCommit={(next) => setAttr("duration", next)}
          />
        </Field>
      )}

      {node.shape === "house" && (
        <>
          <Field label="child workflow">
            <CommitInput
              key={`${node.id}:child:${attrString("stack.child_workflow")}`}
              ariaLabel="Child workflow path"
              mono
              value={attrString("stack.child_workflow")}
              placeholder="path/to/workflow.fabro"
              onCommit={(next) => setAttr("stack.child_workflow", next)}
            />
          </Field>
          <Field label="max cycles">
            <CommitInput
              key={`${node.id}:cycles:${attrString("manager.max_cycles")}`}
              ariaLabel="Manager max cycles"
              mono
              value={attrString("manager.max_cycles")}
              onCommit={(next) =>
                setAttr(
                  "manager.max_cycles",
                  next === "" ? undefined : coerceAttrValue(next),
                )
              }
            />
          </Field>
        </>
      )}

      {(node.shape === "box" ||
        node.shape === "tab" ||
        node.shape === "tripleoctagon") && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="model">
            <CommitInput
              key={`${node.id}:model:${attrString("model")}`}
              ariaLabel="Model override"
              mono
              value={attrString("model")}
              placeholder="stylesheet default"
              onCommit={(next) => setAttr("model", next)}
            />
          </Field>
          <Field label="timeout">
            <CommitInput
              key={`${node.id}:timeout:${attrString("timeout")}`}
              ariaLabel="Node timeout"
              mono
              value={attrString("timeout")}
              placeholder="900s"
              onCommit={(next) => setAttr("timeout", next)}
            />
          </Field>
          <Field label="reasoning effort">
            <CommitSelect
              ariaLabel="Reasoning effort"
              value={attrString("reasoning_effort")}
              options={REASONING_OPTIONS}
              onCommit={(next) => setAttr("reasoning_effort", next)}
            />
          </Field>
          <Field label="fidelity">
            <CommitSelect
              ariaLabel="Context fidelity"
              value={attrString("fidelity")}
              options={FIDELITY_OPTIONS}
              onCommit={(next) => setAttr("fidelity", next)}
            />
          </Field>
        </div>
      )}

      {node.shape === "hexagon" && (
        <Field label="timeout">
          <CommitInput
            key={`${node.id}:timeout:${attrString("timeout")}`}
            ariaLabel="Answer deadline"
            mono
            value={attrString("timeout")}
            placeholder="none"
            onCommit={(next) => setAttr("timeout", next)}
          />
        </Field>
      )}

      {!isTerminal && (
        <AttrTable
          label="other attributes"
          attrs={attrs}
          omit={NAMED_ATTRS[node.shape] ?? []}
          onSet={(key, value) => setAttr(key, value)}
          onRemove={(key) => setAttr(key, undefined)}
        />
      )}

      <div className="flex items-center justify-between border-t border-fac-line pt-3">
        <button
          type="button"
          onClick={() => onConnectStart(node.id)}
          disabled={node.id === EXIT_ID}
          className="inline-flex items-center gap-1 rounded-[8px] px-2 py-1 text-[11.5px] font-medium text-fac-muted transition-colors hover:bg-fac-hover hover:text-fac-ink disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fac-ink/60"
        >
          <PlusIcon className="size-3.5" />
          Connect to…
        </button>
        {!isTerminal && (
          <button
            type="button"
            onClick={() => onApply(deleteNode(graph, node.id))}
            className={DANGER_TEXT_BUTTON_CLASS}
          >
            Delete node
          </button>
        )}
      </div>
    </div>
  );
}

function PromptField({
  graph,
  node,
  skills,
  onApply,
}: {
  graph: WorkflowGraph;
  node: Node;
  skills: readonly EditorSkill[];
  onApply: (result: EditResult) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const insertCommand = (command: string) => {
    const textarea = textareaRef.current;
    setPickerOpen(false);
    if (!textarea) {
      onApply(
        updateNode(graph, node.id, {
          prompt: `${node.prompt ?? ""}${command}`,
        }),
      );
      return;
    }
    const caret = textarea.selectionStart ?? textarea.value.length;
    const next =
      textarea.value.slice(0, caret) + command + textarea.value.slice(caret);
    onApply(updateNode(graph, node.id, { prompt: next }));
    textarea.focus();
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div className={FIELD_LABEL_CLASS}>prompt</div>
        <SkillPicker
          skills={skills}
          open={pickerOpen}
          onOpen={() => setPickerOpen(true)}
          onClose={() => setPickerOpen(false)}
          onPick={insertCommand}
        />
      </div>
      <CommitTextarea
        key={`${node.id}:prompt:${node.prompt ?? ""}`}
        ariaLabel="Node prompt"
        rows={8}
        value={node.prompt ?? ""}
        placeholder="What this node's agent should do. Type / for the skill picker."
        onCommit={(next) => onApply(updateNode(graph, node.id, { prompt: next }))}
        textareaRef={textareaRef}
        onOpenPicker={() => setPickerOpen(true)}
      />
    </div>
  );
}

/**
 * Human gate editing: the verdict list IS the outgoing edges, the freeform
 * toggle is the one `freeform=true` edge, exactly the semantics the engine
 * reads.
 */
function GateSection({
  graph,
  node,
  onApply,
}: {
  graph: WorkflowGraph;
  node: Node;
  onApply: (result: EditResult) => void;
}) {
  const attrs = node.attrs ?? {};
  const outgoing = graph.edges
    .map((edge, index) => ({ edge, index }))
    .filter(({ edge }) => edge.from === node.id);
  const verdicts = outgoing.filter(({ edge }) => edge.attrs.freeform !== true);
  const freeform = outgoing.find(({ edge }) => edge.attrs.freeform === true);
  const targets = graph.nodes
    .filter((candidate) => candidate.id !== START_ID)
    .map((candidate) => ({ value: candidate.id, label: candidate.id }));

  const setQuestionType = (next: string) => {
    const nextAttrs = { ...attrs };
    if (next === "") {
      delete nextAttrs.question_type;
    } else {
      nextAttrs.question_type = next;
    }
    onApply(updateNode(graph, node.id, { attrs: nextAttrs }));
  };

  return (
    <div className="space-y-2 rounded-[10px] border border-fac-line bg-fac-well/60 p-2.5">
      <Field label="question type">
        <CommitSelect
          ariaLabel="Question type"
          value={typeof attrs.question_type === "string" ? attrs.question_type : ""}
          options={QUESTION_TYPE_OPTIONS}
          onCommit={setQuestionType}
        />
      </Field>

      <div className="space-y-1.5">
        <div className={FIELD_LABEL_CLASS}>verdicts (outgoing edges)</div>
        {verdicts.length === 0 && (
          <p className="text-[12px] text-fac-dim">
            No verdict edges yet — the gate needs at least one way out.
          </p>
        )}
        {verdicts.map(({ edge, index }) => (
          <div key={index} className="flex items-start gap-1.5">
            <CommitInput
              key={`${index}:${formatAttrValue(edge.attrs.label ?? "")}`}
              ariaLabel={`Verdict label for edge to ${edge.to}`}
              value={typeof edge.attrs.label === "string" ? edge.attrs.label : ""}
              placeholder={`[K] Label → ${edge.to}`}
              onCommit={(next) =>
                onApply(
                  updateEdge(graph, index, { ...edge.attrs, label: next }),
                )
              }
            />
            <select
              aria-label={`Verdict target for ${edge.to}`}
              className={`${WELL_SELECT_CLASS} w-2/5 shrink-0`}
              value={edge.to}
              onChange={(event) =>
                onApply(retargetEdge(graph, index, event.target.value))
              }
              onKeyDown={(event) => event.stopPropagation()}
            >
              {targets.map((target) => (
                <option key={target.value} value={target.value}>
                  {target.value}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label={`Remove verdict to ${edge.to}`}
              onClick={() => onApply(deleteEdge(graph, index))}
              className="mt-1 flex size-6 shrink-0 items-center justify-center rounded text-fac-dim transition-colors hover:bg-fac-hover hover:text-fac-red focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fac-ink/60"
            >
              <XMarkIcon className="size-3.5" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => onApply(addEdge(graph, node.id, EXIT_ID))}
          className="inline-flex items-center gap-1 rounded-[8px] px-2 py-1 text-[11.5px] font-medium text-fac-muted transition-colors hover:bg-fac-hover hover:text-fac-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fac-ink/60"
        >
          <PlusIcon className="size-3.5" />
          Add verdict
        </button>
      </div>

      <div className="space-y-1.5">
        <label className="flex items-center gap-2 text-[12.5px] text-fac-ink-2">
          <input
            type="checkbox"
            checked={freeform !== undefined}
            onChange={(event) =>
              onApply(
                setFreeformEdge(
                  graph,
                  node.id,
                  event.target.checked ? EXIT_ID : null,
                ),
              )
            }
            className="size-3.5 accent-fac-go"
          />
          Accept freeform text
        </label>
        {freeform && (
          <div className="flex items-center gap-2 pl-5">
            <span className="text-[11.5px] text-fac-muted">routes to</span>
            <select
              aria-label="Freeform target"
              className={`${WELL_SELECT_CLASS} flex-1`}
              value={freeform.edge.to}
              onChange={(event) =>
                onApply(setFreeformEdge(graph, node.id, event.target.value))
              }
              onKeyDown={(event) => event.stopPropagation()}
            >
              {targets.map((target) => (
                <option key={target.value} value={target.value}>
                  {target.value}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <Field label="default choice on timeout">
        <CommitInput
          key={`${node.id}:default:${formatAttrValue(attrs["human.default_choice"] ?? "")}`}
          ariaLabel="Default choice on timeout"
          mono
          value={
            typeof attrs["human.default_choice"] === "string"
              ? attrs["human.default_choice"]
              : ""
          }
          placeholder="none — an unanswered gate fails closed"
          onCommit={(next) => {
            const nextAttrs = { ...attrs };
            if (next === "") {
              delete nextAttrs["human.default_choice"];
            } else {
              nextAttrs["human.default_choice"] = next;
            }
            onApply(updateNode(graph, node.id, { attrs: nextAttrs }));
          }}
        />
      </Field>
    </div>
  );
}
