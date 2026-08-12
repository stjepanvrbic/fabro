/** Edge editing panel: label, condition, weight, fidelity, freeform, target. */

import type { WorkflowGraph } from "../model/graph";
import { START_ID } from "../model/graph";
import {
  deleteEdge,
  retargetEdge,
  updateEdge,
  type EditResult,
} from "../model/edit";
import { DANGER_TEXT_BUTTON_CLASS, WELL_SELECT_CLASS } from "../ui";
import AttrTable, { coerceAttrValue, formatAttrValue } from "./attr-table";
import { CommitInput, CommitSelect, Field } from "./fields";

const FIDELITY_OPTIONS = [
  { value: "", label: "default" },
  { value: "compact", label: "compact" },
  { value: "full", label: "full" },
  { value: "summary:high", label: "summary: high" },
  { value: "summary:medium", label: "summary: medium" },
  { value: "summary:low", label: "summary: low" },
  { value: "truncate", label: "truncate" },
] as const;

const NAMED_EDGE_ATTRS = [
  "label",
  "condition",
  "weight",
  "fidelity",
  "freeform",
] as const;

export default function EdgePanel({
  graph,
  index,
  onApply,
}: {
  graph: WorkflowGraph;
  index: number;
  onApply: (result: EditResult) => void;
}) {
  const edge = graph.edges[index];
  if (!edge) return null;
  const attrs = edge.attrs;

  const setAttr = (key: string, value: string | number | boolean | undefined) => {
    const next = { ...attrs };
    if (value === undefined || value === "") {
      delete next[key];
    } else {
      next[key] = value;
    }
    onApply(updateEdge(graph, index, next));
  };

  const attrString = (key: string): string => {
    const value = attrs[key];
    return value === undefined ? "" : formatAttrValue(value);
  };

  const targets = graph.nodes
    .filter((node) => node.id !== START_ID)
    .map((node) => ({ value: node.id, label: node.id }));

  return (
    <div className="space-y-3 p-3">
      <div className="font-mono text-[12.5px] text-fac-ink-2">
        {edge.from} <span className="text-fac-dim">→</span> {edge.to}
      </div>
      <Field label="target">
        <select
          aria-label="Edge target"
          className={WELL_SELECT_CLASS}
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
      </Field>
      <Field label="label">
        <CommitInput
          key={`${index}:label:${attrString("label")}`}
          ariaLabel="Edge label"
          value={attrString("label")}
          placeholder="[K] Verdict label"
          onCommit={(next) => setAttr("label", next)}
        />
      </Field>
      <Field label="condition">
        <CommitInput
          key={`${index}:condition:${attrString("condition")}`}
          ariaLabel="Edge condition"
          mono
          value={attrString("condition")}
          placeholder="outcome=succeeded"
          onCommit={(next) => setAttr("condition", next)}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="weight">
          <CommitInput
            key={`${index}:weight:${attrString("weight")}`}
            ariaLabel="Edge weight"
            mono
            value={attrString("weight")}
            placeholder="0"
            onCommit={(next) =>
              setAttr("weight", next === "" ? undefined : coerceAttrValue(next))
            }
          />
        </Field>
        <Field label="fidelity">
          <CommitSelect
            ariaLabel="Edge fidelity"
            value={attrString("fidelity")}
            options={FIDELITY_OPTIONS}
            onCommit={(next) => setAttr("fidelity", next)}
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-[12.5px] text-fac-ink-2">
        <input
          type="checkbox"
          checked={attrs.freeform === true}
          onChange={(event) =>
            setAttr("freeform", event.target.checked ? true : undefined)
          }
          className="size-3.5 accent-fac-go"
        />
        Freeform edge (unmatched gate text routes here)
      </label>

      <AttrTable
        label="other attributes"
        attrs={attrs}
        omit={NAMED_EDGE_ATTRS}
        onSet={(key, value) => setAttr(key, value)}
        onRemove={(key) => setAttr(key, undefined)}
      />

      <div className="flex justify-end border-t border-fac-line pt-3">
        <button
          type="button"
          onClick={() => onApply(deleteEdge(graph, index))}
          className={DANGER_TEXT_BUTTON_CLASS}
        >
          Delete edge
        </button>
      </div>
    </div>
  );
}
