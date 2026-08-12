/**
 * The editor's workflow graph model.
 *
 * Richer than the playground's `WorkflowDraft`: graph attributes are kept in
 * order (goal, model_stylesheet, rankdir, and anything else), edges are
 * addressed by index so parallel edges and self-loops round-trip, and the
 * constructs the canonical serializer would rewrite (comments, subgraphs,
 * node/edge default statements) are counted so the editor can state the
 * consequence before the first visual edit.
 */

import type { AttrValue, Node, Shape } from "../../playground/state/draft";
import { isValidNodeId } from "../../playground/state/draft";

export type { AttrValue, Node, Shape };
export { isValidNodeId };

/** One edge. Identity is the index in `WorkflowGraph.edges`. */
export type EditorEdge = {
  from: string;
  to: string;
  attrs: Record<string, AttrValue>;
};

/** Constructs the canonical form rewrites or drops. */
export type LossyConstructs = {
  comments: number;
  subgraphs: number;
  defaultStatements: number;
};

export type WorkflowGraph = {
  /** The digraph name, PascalCase on disk. */
  name: string;
  /**
   * Graph attributes in source order: `goal`, `model_stylesheet`, `rankdir`,
   * and any other key. `rankdir` is stored here whether it appeared as a bare
   * assignment or inside `graph [...]`.
   */
  graphAttrs: [string, AttrValue][];
  nodes: Node[];
  edges: EditorEdge[];
  lossy: LossyConstructs;
};

export const START_ID = "start";
export const EXIT_ID = "exit";

export function graphAttr(
  graph: WorkflowGraph,
  key: string,
): AttrValue | undefined {
  const entry = graph.graphAttrs.find(([k]) => k === key);
  return entry?.[1];
}

export function goalOf(graph: WorkflowGraph): string {
  const goal = graphAttr(graph, "goal");
  return typeof goal === "string" ? goal : "";
}

export function rankdirOf(graph: WorkflowGraph): string {
  const rankdir = graphAttr(graph, "rankdir");
  return typeof rankdir === "string" ? rankdir : "LR";
}

export function isLossy(graph: WorkflowGraph): boolean {
  const { comments, subgraphs, defaultStatements } = graph.lossy;
  return comments > 0 || subgraphs > 0 || defaultStatements > 0;
}

/** Human sentence naming what a canonical rewrite would drop. */
export function lossyDescription(lossy: LossyConstructs): string {
  const parts: string[] = [];
  if (lossy.comments > 0) {
    parts.push(lossy.comments === 1 ? "1 comment" : `${lossy.comments} comments`);
  }
  if (lossy.subgraphs > 0) {
    parts.push(lossy.subgraphs === 1 ? "1 subgraph" : `${lossy.subgraphs} subgraphs`);
  }
  if (lossy.defaultStatements > 0) {
    parts.push(
      lossy.defaultStatements === 1
        ? "1 node/edge default statement"
        : `${lossy.defaultStatements} node/edge default statements`,
    );
  }
  return parts.join(" and ");
}

export function createEmptyGraph(name: string): WorkflowGraph {
  return {
    name,
    graphAttrs: [["goal", ""]],
    nodes: [
      { id: START_ID, label: "Start", shape: "mdiamond" },
      { id: EXIT_ID, label: "Exit", shape: "msquare" },
    ],
    edges: [{ from: START_ID, to: EXIT_ID, attrs: {} }],
    lossy: { comments: 0, subgraphs: 0, defaultStatements: 0 },
  };
}
