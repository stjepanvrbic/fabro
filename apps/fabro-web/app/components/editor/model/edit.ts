/**
 * Pure edit operations over a `WorkflowGraph`.
 *
 * Every operation returns a new graph or a single-line refusal; nothing
 * throws and nothing partially mutates. The only hard structural guards are
 * the ones the server's lint rules make errors — nothing into `start`,
 * nothing out of `exit`, reserved terminal ids — everything else (parallel
 * edges, self-loops, loops back to earlier nodes) is legal in the workflow
 * language and stays editable; validation diagnostics carry the rest.
 */

import type { AttrValue, Node, Shape } from "../../playground/state/draft";
import { isValidNodeId } from "../../playground/state/draft";
import type { EditorEdge, WorkflowGraph } from "./graph";
import { EXIT_ID, START_ID } from "./graph";

export type EditResult =
  | { ok: true; graph: WorkflowGraph }
  | { ok: false; error: string };

function ok(graph: WorkflowGraph): EditResult {
  return { ok: true, graph };
}

function fail(error: string): EditResult {
  return { ok: false, error };
}

function findNode(graph: WorkflowGraph, id: string): Node | undefined {
  return graph.nodes.find((node) => node.id === id);
}

const RESERVED: readonly string[] = [START_ID, EXIT_ID];

export function setWorkflowName(graph: WorkflowGraph, name: string): EditResult {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    return fail(`Workflow name "${name}" must be snake_case.`);
  }
  return ok({ ...graph, name });
}

/** Set (or with `undefined`, remove) one graph attribute. */
export function setGraphAttr(
  graph: WorkflowGraph,
  key: string,
  value: AttrValue | undefined,
): EditResult {
  if (key.trim().length === 0) {
    return fail("Attribute keys must not be empty.");
  }
  const attrs = graph.graphAttrs.filter(([k]) => k !== key);
  if (value !== undefined) {
    const index = graph.graphAttrs.findIndex(([k]) => k === key);
    if (index >= 0) {
      attrs.splice(index, 0, [key, value]);
    } else {
      attrs.push([key, value]);
    }
  }
  return ok({ ...graph, graphAttrs: attrs });
}

export function addNode(
  graph: WorkflowGraph,
  id: string,
  shape: Shape,
): EditResult {
  if (RESERVED.includes(id)) {
    return fail(`Node id "${id}" is reserved.`);
  }
  if (!isValidNodeId(id)) {
    return fail(`Node id "${id}" must be snake_case.`);
  }
  if (findNode(graph, id)) {
    return fail(`Node "${id}" already exists.`);
  }
  if (shape === "mdiamond" || shape === "msquare") {
    return fail("Start and exit already exist.");
  }
  const label = id
    .split("_")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
  return ok({ ...graph, nodes: [...graph.nodes, { id, label, shape }] });
}

export type NodeUpdate = {
  label?: string;
  shape?: Shape;
  prompt?: string | undefined;
  attrs?: Record<string, AttrValue>;
};

export function updateNode(
  graph: WorkflowGraph,
  id: string,
  update: NodeUpdate,
): EditResult {
  const existing = findNode(graph, id);
  if (!existing) {
    return fail(`Node "${id}" does not exist.`);
  }
  if (RESERVED.includes(id) && update.shape !== undefined) {
    return fail("Start and exit keep their shapes.");
  }
  if (update.shape === "mdiamond" || update.shape === "msquare") {
    return fail("Start and exit already exist.");
  }
  const updated: Node = { ...existing };
  if (update.label !== undefined) updated.label = update.label;
  if (update.shape !== undefined) updated.shape = update.shape;
  if ("prompt" in update) {
    if (update.prompt === undefined || update.prompt === "") {
      delete updated.prompt;
    } else {
      updated.prompt = update.prompt;
    }
  }
  if (update.attrs !== undefined) {
    if (Object.keys(update.attrs).length === 0) {
      delete updated.attrs;
    } else {
      updated.attrs = { ...update.attrs };
    }
  }
  return ok({
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === id ? updated : node)),
  });
}

/** Rename a node and rewire every edge that references it. */
export function renameNode(
  graph: WorkflowGraph,
  id: string,
  newId: string,
): EditResult {
  if (id === newId) return ok(graph);
  if (RESERVED.includes(id) || RESERVED.includes(newId)) {
    return fail("Start and exit keep their ids.");
  }
  if (!isValidNodeId(newId)) {
    return fail(`Node id "${newId}" must be snake_case.`);
  }
  if (!findNode(graph, id)) {
    return fail(`Node "${id}" does not exist.`);
  }
  if (findNode(graph, newId)) {
    return fail(`Node "${newId}" already exists.`);
  }
  return ok({
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === id ? { ...node, id: newId } : node,
    ),
    edges: graph.edges.map((edge) => ({
      ...edge,
      from: edge.from === id ? newId : edge.from,
      to: edge.to === id ? newId : edge.to,
    })),
  });
}

export function deleteNode(graph: WorkflowGraph, id: string): EditResult {
  if (RESERVED.includes(id)) {
    return fail("Start and exit cannot be deleted.");
  }
  if (!findNode(graph, id)) {
    return fail(`Node "${id}" does not exist.`);
  }
  return ok({
    ...graph,
    nodes: graph.nodes.filter((node) => node.id !== id),
    edges: graph.edges.filter((edge) => edge.from !== id && edge.to !== id),
  });
}

export function addEdge(
  graph: WorkflowGraph,
  from: string,
  to: string,
): EditResult {
  if (!findNode(graph, from)) {
    return fail(`Node "${from}" does not exist.`);
  }
  if (!findNode(graph, to)) {
    return fail(`Node "${to}" does not exist.`);
  }
  if (from === EXIT_ID) {
    return fail(`"exit" cannot have outgoing edges.`);
  }
  if (to === START_ID) {
    return fail(`"start" cannot have incoming edges.`);
  }
  return ok({ ...graph, edges: [...graph.edges, { from, to, attrs: {} }] });
}

export function updateEdge(
  graph: WorkflowGraph,
  index: number,
  attrs: Record<string, AttrValue>,
): EditResult {
  const edge = graph.edges[index];
  if (!edge) {
    return fail("The edge no longer exists.");
  }
  const next: EditorEdge = { ...edge, attrs: { ...attrs } };
  return ok({
    ...graph,
    edges: graph.edges.map((e, i) => (i === index ? next : e)),
  });
}

/** Point an existing edge at a different target node. */
export function retargetEdge(
  graph: WorkflowGraph,
  index: number,
  to: string,
): EditResult {
  const edge = graph.edges[index];
  if (!edge) {
    return fail("The edge no longer exists.");
  }
  if (!findNode(graph, to)) {
    return fail(`Node "${to}" does not exist.`);
  }
  if (to === START_ID) {
    return fail(`"start" cannot have incoming edges.`);
  }
  return ok({
    ...graph,
    edges: graph.edges.map((e, i) => (i === index ? { ...e, to } : e)),
  });
}

export function deleteEdge(graph: WorkflowGraph, index: number): EditResult {
  if (!graph.edges[index]) {
    return fail("The edge no longer exists.");
  }
  return ok({
    ...graph,
    edges: graph.edges.filter((_, i) => i !== index),
  });
}

/**
 * Set or clear the gate's freeform edge. A human gate accepts at most one
 * `freeform=true` outgoing edge; its target is where unmatched text routes.
 */
export function setFreeformEdge(
  graph: WorkflowGraph,
  gateId: string,
  target: string | null,
): EditResult {
  if (!findNode(graph, gateId)) {
    return fail(`Node "${gateId}" does not exist.`);
  }
  const withoutFreeform = graph.edges.filter(
    (edge) => !(edge.from === gateId && edge.attrs.freeform === true),
  );
  if (target === null) {
    return ok({ ...graph, edges: withoutFreeform });
  }
  if (!findNode(graph, target)) {
    return fail(`Node "${target}" does not exist.`);
  }
  if (target === START_ID) {
    return fail(`"start" cannot have incoming edges.`);
  }
  return ok({
    ...graph,
    edges: [
      ...withoutFreeform,
      { from: gateId, to: target, attrs: { freeform: true } },
    ],
  });
}
