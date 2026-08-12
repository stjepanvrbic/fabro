/**
 * Parse Graphviz DOT into a `WorkflowGraph`.
 *
 * Grown from the playground parser with what real repo workflows need:
 * every graph attribute is kept in order (goal, model_stylesheet, rankdir,
 * anything else), parallel edges and self-loops survive, subgraph bodies are
 * flattened into the graph exactly like the server's semantic pass, and the
 * constructs a canonical rewrite would drop (comments, subgraph grouping,
 * node/edge default statements) are counted so the editor can state the
 * consequence before the first visual edit.
 */

import type { AttrValue, Node, Shape } from "../../playground/state/draft";
import { ALL_SHAPES, DEFAULT_NAME } from "../../playground/state/draft";
import type { EditorEdge, WorkflowGraph } from "./graph";

export type EditorParseResult =
  | { ok: true; graph: WorkflowGraph }
  | { ok: false; error: string; line: number; column: number };

interface State {
  src: string;
  pos: number;
  comments: number;
}

const SHAPE_SET = new Set(ALL_SHAPES as readonly string[]);

export function parseWorkflow(src: string): EditorParseResult {
  const state: State = { src, pos: 0, comments: 0 };
  skipWs(state);
  if (!tryConsume(state, "digraph")) {
    return fail("expected `digraph` keyword at start of file", state);
  }

  skipWs(state);
  let digraphName: string | null = null;
  if (state.src[state.pos] !== "{") {
    digraphName = parseIdent(state) ?? parseString(state);
  }
  skipWs(state);
  if (!consumeChar(state, "{")) {
    return fail("expected `{` after digraph header", state);
  }

  const graph: WorkflowGraph = {
    name: digraphName ? toSnakeCase(digraphName) : DEFAULT_NAME,
    graphAttrs: [],
    nodes: [],
    edges: [],
    lossy: { comments: 0, subgraphs: 0, defaultStatements: 0 },
  };

  const body = parseStatements(state, graph, /* insideSubgraph */ false);
  if (!body.ok) return body;
  graph.lossy.comments = state.comments;
  return { ok: true, graph };
}

function parseStatements(
  state: State,
  graph: WorkflowGraph,
  insideSubgraph: boolean,
): EditorParseResult {
  while (true) {
    skipWs(state);
    if (state.pos >= state.src.length) {
      return fail("unexpected end of input before closing `}`", state);
    }
    if (consumeChar(state, "}")) {
      return { ok: true, graph };
    }

    if (tryConsume(state, "subgraph")) {
      graph.lossy.subgraphs += 1;
      skipWs(state);
      if (state.src[state.pos] !== "{") {
        parseIdent(state) ?? parseString(state);
      }
      skipWs(state);
      if (!consumeChar(state, "{")) {
        return fail("expected `{` after subgraph header", state);
      }
      // Flatten the body into the graph, the way the engine's semantic
      // pass does. The grouping itself is what the lossy flag records.
      const body = parseStatements(state, graph, true);
      if (!body.ok) return body;
      consumeStatementEnd(state);
      continue;
    }

    if (tryConsume(state, "graph") && isAttrOrEnd(state)) {
      if (state.src[state.pos] === "[") {
        const attrs = parseAttrEntries(state);
        if (!attrs) return fail("malformed attribute list", state);
        for (const [key, value] of attrs) {
          setGraphAttr(graph, key, value);
        }
      }
      consumeStatementEnd(state);
      continue;
    }
    if (
      (tryConsume(state, "node") && isAttrOrEnd(state)) ||
      (tryConsume(state, "edge") && isAttrOrEnd(state))
    ) {
      graph.lossy.defaultStatements += 1;
      if (state.src[state.pos] === "[" && !parseAttrEntries(state)) {
        return fail("malformed attribute list", state);
      }
      consumeStatementEnd(state);
      continue;
    }

    const bare = tryParseBareAssignment(state);
    if (bare) {
      setGraphAttr(graph, bare[0], bare[1]);
      continue;
    }

    const id = parseIdent(state) ?? parseString(state);
    if (!id) {
      return fail("unexpected token", state);
    }
    skipWs(state);

    if (peek(state, "->")) {
      let from = id;
      while (peek(state, "->")) {
        state.pos += 2;
        skipWs(state);
        const to = parseIdent(state) ?? parseString(state);
        if (!to) {
          return fail("expected target node after `->`", state);
        }
        const edge: EditorEdge = { from, to, attrs: {} };
        skipWs(state);
        if (!peek(state, "->") && state.src[state.pos] === "[") {
          const attrs = parseAttrEntries(state);
          if (!attrs) return fail("malformed attribute list", state);
          for (const [key, value] of attrs) {
            edge.attrs[key] = value;
          }
        }
        graph.edges.push(edge);
        from = to;
        skipWs(state);
      }
      consumeStatementEnd(state);
      continue;
    }

    // Node declaration. A repeated declaration merges onto the earlier one,
    // matching Graphviz semantics.
    let entries: [string, AttrValue][] = [];
    if (state.src[state.pos] === "[") {
      const parsed = parseAttrEntries(state);
      if (!parsed) return fail("malformed attribute list", state);
      entries = parsed;
    }
    const attrs: Record<string, AttrValue> = {};
    for (const [key, value] of entries) {
      attrs[key] = value;
    }
    const existing = graph.nodes.find((node) => node.id === id);
    if (existing) {
      mergeNode(existing, attrs);
    } else {
      graph.nodes.push(buildNode(id, attrs));
    }
    consumeStatementEnd(state);
  }
  // insideSubgraph is only used for symmetry of the recursive call.
  void insideSubgraph;
}

function setGraphAttr(graph: WorkflowGraph, key: string, value: AttrValue): void {
  const index = graph.graphAttrs.findIndex(([k]) => k === key);
  if (index >= 0) {
    graph.graphAttrs[index] = [key, value];
  } else {
    graph.graphAttrs.push([key, value]);
  }
}

function buildNode(id: string, attrs: Record<string, AttrValue>): Node {
  const shape = coerceShape(attrs, id);
  const label = typeof attrs.label === "string" ? attrs.label : id;
  const node: Node = { id, label, shape };
  if (typeof attrs.prompt === "string") node.prompt = attrs.prompt;
  const rest = { ...attrs };
  delete rest.shape;
  delete rest.label;
  delete rest.prompt;
  if (Object.keys(rest).length > 0) node.attrs = rest;
  return node;
}

function mergeNode(node: Node, attrs: Record<string, AttrValue>): void {
  if (typeof attrs.shape === "string") {
    const lower = attrs.shape.toLowerCase();
    if (SHAPE_SET.has(lower)) node.shape = lower as Shape;
  }
  if (typeof attrs.label === "string") node.label = attrs.label;
  if (typeof attrs.prompt === "string") node.prompt = attrs.prompt;
  const rest = { ...attrs };
  delete rest.shape;
  delete rest.label;
  delete rest.prompt;
  if (Object.keys(rest).length > 0) {
    node.attrs = { ...node.attrs, ...rest };
  }
}

function coerceShape(attrs: Record<string, AttrValue>, nodeId: string): Shape {
  const raw = attrs.shape;
  if (typeof raw !== "string") {
    if (typeof attrs.type !== "string" && attrs.script !== undefined) {
      return "parallelogram";
    }
    if (nodeId === "start") return "mdiamond";
    if (nodeId === "exit") return "msquare";
    return "box";
  }
  const lower = raw.toLowerCase();
  if (SHAPE_SET.has(lower)) return lower as Shape;
  return "box";
}

function skipWs(state: State): void {
  while (state.pos < state.src.length) {
    const c = state.src[state.pos]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      state.pos++;
      continue;
    }
    if (c === "/" && state.src[state.pos + 1] === "/") {
      state.comments += 1;
      while (state.pos < state.src.length && state.src[state.pos] !== "\n") {
        state.pos++;
      }
      continue;
    }
    if (c === "/" && state.src[state.pos + 1] === "*") {
      state.comments += 1;
      state.pos += 2;
      while (
        state.pos + 1 < state.src.length &&
        !(state.src[state.pos] === "*" && state.src[state.pos + 1] === "/")
      ) {
        state.pos++;
      }
      state.pos += 2;
      continue;
    }
    if (c === "#") {
      state.comments += 1;
      while (state.pos < state.src.length && state.src[state.pos] !== "\n") {
        state.pos++;
      }
      continue;
    }
    break;
  }
}

function parseIdent(state: State): string | null {
  skipWs(state);
  const start = state.pos;
  const first = state.src[state.pos];
  if (!first || !/[a-zA-Z_]/.test(first)) return null;
  state.pos++;
  while (
    state.pos < state.src.length &&
    /[a-zA-Z0-9_.]/.test(state.src[state.pos]!)
  ) {
    state.pos++;
  }
  return state.src.slice(start, state.pos);
}

function parseString(state: State): string | null {
  skipWs(state);
  if (state.src[state.pos] !== '"') return null;
  state.pos++;
  let result = "";
  while (state.pos < state.src.length) {
    const c = state.src[state.pos]!;
    if (c === "\\") {
      const next = state.src[state.pos + 1];
      if (next === '"') {
        result += '"';
        state.pos += 2;
      } else if (next === "\\") {
        result += "\\";
        state.pos += 2;
      } else if (next === "n") {
        result += "\n";
        state.pos += 2;
      } else if (next === "t") {
        result += "\t";
        state.pos += 2;
      } else if (next === "r") {
        result += "\r";
        state.pos += 2;
      } else {
        result += c;
        state.pos += 1;
      }
    } else if (c === '"') {
      state.pos++;
      const save = state.pos;
      skipWs(state);
      if (state.src[state.pos] === "+") {
        state.pos++;
        const more = parseString(state);
        if (more === null) {
          state.pos = save;
          return result;
        }
        return result + more;
      }
      state.pos = save;
      return result;
    } else {
      result += c;
      state.pos++;
    }
  }
  return null;
}

function parseAttrValue(state: State): AttrValue | null {
  skipWs(state);
  if (state.src[state.pos] === '"') {
    return parseString(state);
  }
  const start = state.pos;
  while (
    state.pos < state.src.length &&
    /[a-zA-Z0-9_\-.]/.test(state.src[state.pos]!)
  ) {
    state.pos++;
  }
  if (state.pos === start) return null;
  const raw = state.src.slice(start, state.pos);
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

/** Attribute list as ordered entries; later duplicates win. */
function parseAttrEntries(state: State): [string, AttrValue][] | null {
  skipWs(state);
  if (state.src[state.pos] !== "[") return null;
  state.pos++;
  const out: [string, AttrValue][] = [];
  while (true) {
    skipWs(state);
    if (state.pos >= state.src.length) return null;
    if (state.src[state.pos] === "]") {
      state.pos++;
      return out;
    }
    const key = parseIdent(state);
    if (!key) return null;
    skipWs(state);
    if (state.src[state.pos] !== "=") return null;
    state.pos++;
    const value = parseAttrValue(state);
    if (value === null) return null;
    out.push([key, value]);
    skipWs(state);
    if (state.src[state.pos] === "," || state.src[state.pos] === ";") {
      state.pos++;
    }
  }
}

function tryConsume(state: State, word: string): boolean {
  skipWs(state);
  if (state.src.slice(state.pos, state.pos + word.length) !== word) return false;
  const after = state.src[state.pos + word.length];
  if (after && /[a-zA-Z0-9_]/.test(after)) return false;
  state.pos += word.length;
  return true;
}

function consumeChar(state: State, ch: string): boolean {
  skipWs(state);
  if (state.src[state.pos] !== ch) return false;
  state.pos++;
  return true;
}

function consumeStatementEnd(state: State): void {
  skipWs(state);
  if (state.src[state.pos] === ";") state.pos++;
}

function peek(state: State, str: string): boolean {
  skipWs(state);
  return state.src.slice(state.pos, state.pos + str.length) === str;
}

function isAttrOrEnd(state: State): boolean {
  skipWs(state);
  const c = state.src[state.pos];
  return c === "[" || c === ";" || c === "}" || c === undefined;
}

function tryParseBareAssignment(state: State): [string, AttrValue] | null {
  const save = state.pos;
  skipWs(state);
  const ident = parseIdent(state);
  if (!ident) {
    state.pos = save;
    return null;
  }
  skipWs(state);
  if (state.src[state.pos] !== "=") {
    state.pos = save;
    return null;
  }
  state.pos++;
  const value = parseAttrValue(state);
  consumeStatementEnd(state);
  if (value === null) {
    state.pos = save;
    return null;
  }
  return [ident, value];
}

function fail(message: string, state: State): EditorParseResult {
  const lines = state.src.slice(0, state.pos).split("\n");
  const line = lines.length;
  const column = lines[lines.length - 1]!.length + 1;
  return { ok: false, error: message, line, column };
}

function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}
