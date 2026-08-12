/**
 * Render a `WorkflowGraph` to canonical `.fabro` (Graphviz DOT) form — the
 * style this repo's own workflow files use: a `graph [...]` block for graph
 * attributes (goal first), `rankdir` as a bare assignment, terminals first
 * with aligned attribute brackets, then the other nodes, then one edge per
 * line in order.
 */

import type { AttrValue, Node, Shape } from "../../playground/state/draft";
import type { EditorEdge, WorkflowGraph } from "./graph";

function dotShape(shape: Shape): string {
  switch (shape) {
    case "mdiamond":
      return "Mdiamond";
    case "msquare":
      return "Msquare";
    default:
      return shape;
  }
}

function escapeDot(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function renderAttrValue(value: AttrValue): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : '"NaN"';
  }
  return `"${escapeDot(value)}"`;
}

function renderNode(node: Node): string {
  const parts: string[] = [`shape=${dotShape(node.shape)}`];
  if (node.label !== undefined) parts.push(`label=${renderAttrValue(node.label)}`);
  if (node.prompt !== undefined) parts.push(`prompt=${renderAttrValue(node.prompt)}`);
  if (node.attrs) {
    for (const [key, value] of Object.entries(node.attrs)) {
      parts.push(`${key}=${renderAttrValue(value)}`);
    }
  }
  return `${node.id} [${parts.join(", ")}]`;
}

function renderEdge(edge: EditorEdge): string {
  // Label first, then condition, then the rest, matching the repo style.
  const entries: [string, AttrValue][] = [];
  const { label, condition, ...rest } = edge.attrs;
  if (label !== undefined) entries.push(["label", label]);
  if (condition !== undefined) entries.push(["condition", condition]);
  for (const [key, value] of Object.entries(rest)) {
    entries.push([key, value]);
  }
  const base = `${edge.from} -> ${edge.to}`;
  if (entries.length === 0) return base;
  const body = entries
    .map(([key, value]) => `${key}=${renderAttrValue(value)}`)
    .join(", ");
  return `${base} [${body}]`;
}

function pascalCase(snake: string): string {
  return snake
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

function alignAfterId(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  const widest = lines.reduce((max, line) => {
    const idEnd = line.indexOf(" [");
    return idEnd > max ? idEnd : max;
  }, 0);
  return lines.map((line) => {
    const idEnd = line.indexOf(" [");
    if (idEnd === -1) return line;
    const pad = " ".repeat(widest - idEnd);
    return line.slice(0, idEnd) + pad + line.slice(idEnd);
  });
}

export function serializeWorkflow(graph: WorkflowGraph): string {
  const lines: string[] = [];
  const digraphName = pascalCase(graph.name) || "Workflow";

  lines.push(`digraph ${digraphName} {`);

  // `rankdir` renders as a bare assignment; everything else goes in the
  // graph block, goal first.
  const blockAttrs = graph.graphAttrs.filter(
    ([key, value]) => key !== "rankdir" && !(key === "goal" && value === ""),
  );
  blockAttrs.sort(([a], [b]) => Number(b === "goal") - Number(a === "goal"));
  if (blockAttrs.length === 1) {
    const [key, value] = blockAttrs[0]!;
    lines.push(`    graph [${key}=${renderAttrValue(value)}]`);
  } else if (blockAttrs.length > 1) {
    lines.push("    graph [");
    blockAttrs.forEach(([key, value], index) => {
      const comma = index < blockAttrs.length - 1 ? "," : "";
      lines.push(`        ${key}=${renderAttrValue(value)}${comma}`);
    });
    lines.push("    ]");
  }
  const rankdir = graph.graphAttrs.find(([key]) => key === "rankdir");
  lines.push(`    rankdir=${rankdir ? String(rankdir[1]) : "LR"}`);
  lines.push("");

  const terminalLines = graph.nodes
    .filter((n) => n.shape === "mdiamond" || n.shape === "msquare")
    .map(renderNode);
  for (const line of alignAfterId(terminalLines)) {
    lines.push(`    ${line}`);
  }

  const otherLines = graph.nodes
    .filter((n) => n.shape !== "mdiamond" && n.shape !== "msquare")
    .map(renderNode);
  if (otherLines.length > 0) {
    lines.push("");
    for (const line of alignAfterId(otherLines)) {
      lines.push(`    ${line}`);
    }
  }

  if (graph.edges.length > 0) {
    lines.push("");
    for (const edge of graph.edges) {
      lines.push(`    ${renderEdge(edge)}`);
    }
  }

  lines.push("}");
  lines.push("");
  return lines.join("\n");
}
