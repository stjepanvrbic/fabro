/**
 * Editor-canvas DOT renderer: the workflow graph themed for the factory's
 * warm charcoal world. Theming lives here only — the saved file comes from
 * `model/serialize.ts` and never carries these attributes.
 *
 * Node type stays encoded by the language's own shapes; validation errors
 * are the one color statement on the canvas (red, loud). Warnings stay off
 * the canvas — the validation chip and source pane carry them.
 */

import type { EditorEdge, WorkflowGraph } from "../model/graph";
import { rankdirOf } from "../model/graph";

export const editorCanvasTheme = {
  nodeFill: "#232120",
  nodeBorder: "#3f3b38",
  nodeText: "#f0eeec",
  terminalText: "#cbc7c4",
  edge: "#55504c",
  edgeText: "#969290",
  errorFill: "#261a18",
  errorBorder: "#e0756c",
  errorText: "#e0756c",
} as const;

export type CanvasDiagnostics = {
  /** Node ids with at least one error. */
  errorNodes: ReadonlySet<string>;
  /** Edge indexes with at least one error. */
  errorEdges: ReadonlySet<number>;
};

function escapeDot(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function dotShape(shape: string): string {
  if (shape === "mdiamond") return "Mdiamond";
  if (shape === "msquare") return "Msquare";
  return shape;
}

function nodeLine(
  node: WorkflowGraph["nodes"][number],
  diagnostics: CanvasDiagnostics,
): string {
  const isTerminal = node.shape === "mdiamond" || node.shape === "msquare";
  const hasError = diagnostics.errorNodes.has(node.id);
  const parts = [
    `shape=${dotShape(node.shape)}`,
    `label="${escapeDot(node.label)}"`,
  ];
  if (hasError) {
    parts.push(
      `fillcolor="${editorCanvasTheme.errorFill}"`,
      `color="${editorCanvasTheme.errorBorder}"`,
      `fontcolor="${editorCanvasTheme.errorText}"`,
      "penwidth=1.8",
    );
  } else if (isTerminal) {
    parts.push(`fontcolor="${editorCanvasTheme.terminalText}"`);
  }
  return `    ${node.id} [${parts.join(", ")}]`;
}

function edgeLine(
  edge: EditorEdge,
  index: number,
  diagnostics: CanvasDiagnostics,
): string {
  const parts: string[] = [];
  const label = edge.attrs.label;
  if (typeof label === "string" && label.length > 0) {
    parts.push(`label="${escapeDot(label)}"`);
  } else if (edge.attrs.freeform === true) {
    parts.push('label="freeform"', "style=dashed");
  } else if (typeof edge.attrs.condition === "string") {
    parts.push(`label="${escapeDot(edge.attrs.condition)}"`);
  }
  if (diagnostics.errorEdges.has(index)) {
    parts.push(
      `color="${editorCanvasTheme.errorBorder}"`,
      `fontcolor="${editorCanvasTheme.errorText}"`,
      "penwidth=1.8",
    );
  }
  const body = parts.length > 0 ? ` [${parts.join(", ")}]` : "";
  return `    ${edge.from} -> ${edge.to}${body}`;
}

export function renderEditorCanvasDot(
  graph: WorkflowGraph,
  diagnostics: CanvasDiagnostics,
): string {
  const lines: string[] = [];
  lines.push("digraph EditorCanvas {");
  lines.push(`    rankdir=${rankdirOf(graph)}`);
  lines.push('    bgcolor="transparent"');
  lines.push("    pad=0.5");
  lines.push("    node [");
  lines.push('        fontname="Poppins, ui-sans-serif, system-ui"');
  lines.push("        fontsize=12");
  lines.push(`        fontcolor="${editorCanvasTheme.nodeText}"`);
  lines.push(`        color="${editorCanvasTheme.nodeBorder}"`);
  lines.push(`        fillcolor="${editorCanvasTheme.nodeFill}"`);
  lines.push("        style=filled");
  lines.push("        penwidth=1.2");
  lines.push("    ]");
  lines.push("    edge [");
  lines.push('        fontname="Poppins, ui-sans-serif, system-ui"');
  lines.push("        fontsize=10");
  lines.push(`        fontcolor="${editorCanvasTheme.edgeText}"`);
  lines.push(`        color="${editorCanvasTheme.edge}"`);
  lines.push("        arrowsize=0.7");
  lines.push("        penwidth=1.2");
  lines.push("    ]");
  lines.push("");
  for (const node of graph.nodes) {
    lines.push(nodeLine(node, diagnostics));
  }
  lines.push("");
  graph.edges.forEach((edge, index) => {
    lines.push(edgeLine(edge, index, diagnostics));
  });
  lines.push("}");
  return lines.join("\n");
}
