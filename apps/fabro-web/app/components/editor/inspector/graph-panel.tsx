/**
 * Graph panel — shown when nothing is selected: workflow name, goal,
 * direction, model stylesheet, and every other graph attribute.
 */

import type { WorkflowGraph } from "../model/graph";
import { goalOf, graphAttr, rankdirOf } from "../model/graph";
import {
  setGraphAttr,
  setWorkflowName,
  type EditResult,
} from "../model/edit";
import AttrTable from "./attr-table";
import { CommitInput, CommitSelect, CommitTextarea, Field } from "./fields";

const NAMED_GRAPH_ATTRS = ["goal", "rankdir", "model_stylesheet"] as const;

export default function GraphPanel({
  graph,
  onApply,
}: {
  graph: WorkflowGraph;
  onApply: (result: EditResult) => void;
}) {
  const stylesheet = graphAttr(graph, "model_stylesheet");
  const attrs = Object.fromEntries(graph.graphAttrs);

  return (
    <div className="space-y-3 p-3">
      <Field label="workflow name">
        <CommitInput
          key={`name:${graph.name}`}
          ariaLabel="Workflow name"
          mono
          value={graph.name}
          onCommit={(next) => onApply(setWorkflowName(graph, next))}
        />
      </Field>
      <Field label="goal">
        <CommitTextarea
          key={`goal:${goalOf(graph)}`}
          ariaLabel="Workflow goal"
          rows={3}
          value={goalOf(graph)}
          placeholder="What a run of this workflow accomplishes."
          onCommit={(next) => onApply(setGraphAttr(graph, "goal", next))}
        />
      </Field>
      <Field label="direction">
        <CommitSelect
          ariaLabel="Layout direction"
          value={rankdirOf(graph)}
          options={[
            { value: "LR", label: "left to right" },
            { value: "TB", label: "top to bottom" },
          ]}
          onCommit={(next) => onApply(setGraphAttr(graph, "rankdir", next))}
        />
      </Field>
      <Field label="model stylesheet">
        <CommitTextarea
          key={`stylesheet:${typeof stylesheet === "string" ? stylesheet : ""}`}
          ariaLabel="Model stylesheet"
          rows={5}
          value={typeof stylesheet === "string" ? stylesheet : ""}
          placeholder={"* { model: claude-sonnet-4-5; }\n.coding { reasoning_effort: high; }"}
          onCommit={(next) =>
            onApply(
              setGraphAttr(
                graph,
                "model_stylesheet",
                next === "" ? undefined : next,
              ),
            )
          }
        />
      </Field>

      <AttrTable
        label="other graph attributes"
        attrs={attrs}
        omit={NAMED_GRAPH_ATTRS}
        onSet={(key, value) => onApply(setGraphAttr(graph, key, value))}
        onRemove={(key) => onApply(setGraphAttr(graph, key, undefined))}
      />
    </div>
  );
}
