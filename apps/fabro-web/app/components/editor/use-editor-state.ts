/**
 * Editor state: the source text is the single authority. The canvas and
 * inspector operate on the parse of that text; a visual edit re-renders the
 * canonical form back into the text. Undo and redo are snapshots of the
 * text, so they cover visual and source edits alike.
 */

import { useCallback, useMemo, useReducer } from "react";

import type { EditResult } from "./model/edit";
import type { WorkflowGraph } from "./model/graph";
import { isLossy } from "./model/graph";
import { parseWorkflow, type EditorParseResult } from "./model/parse";
import { serializeWorkflow } from "./model/serialize";

export type Selection =
  | { kind: "graph" }
  | { kind: "node"; id: string }
  | { kind: "edge"; index: number };

const HISTORY_LIMIT = 200;

export type EditorState = {
  past: string[];
  source: string;
  future: string[];
  /** The text the last open or save left on disk. */
  savedSource: string;
  baseOid: string | null;
  selection: Selection;
  /** Set once the operator confirms the canonical-rewrite consequence. */
  lossyAccepted: boolean;
  /** Source node of a pending click-click connect, or null. */
  connectFrom: string | null;
  /** One-line refusal from the last visual edit, or null. */
  editError: string | null;
};

type Action =
  | { type: "source-edited"; source: string }
  | { type: "visual-edit"; result: EditResult }
  | { type: "select"; selection: Selection }
  | { type: "accept-lossy" }
  | { type: "connect-start"; from: string }
  | { type: "connect-cancel" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "saved"; baseOid: string }
  | { type: "clear-edit-error" };

function pushHistory(state: EditorState, source: string): EditorState {
  const past = [...state.past, state.source].slice(-HISTORY_LIMIT);
  return { ...state, past, source, future: [], editError: null };
}

function reducer(state: EditorState, action: Action): EditorState {
  switch (action.type) {
    case "source-edited":
      if (action.source === state.source) return state;
      return pushHistory(state, action.source);
    case "visual-edit": {
      if (action.result.ok === false) {
        return { ...state, editError: action.result.error };
      }
      const source = serializeWorkflow(action.result.graph);
      return pushHistory({ ...state, connectFrom: null }, source);
    }
    case "select":
      return { ...state, selection: action.selection, connectFrom: null };
    case "accept-lossy":
      return { ...state, lossyAccepted: true };
    case "connect-start":
      return { ...state, connectFrom: action.from };
    case "connect-cancel":
      return { ...state, connectFrom: null };
    case "undo": {
      const previous = state.past[state.past.length - 1];
      if (previous === undefined) return state;
      return {
        ...state,
        past: state.past.slice(0, -1),
        source: previous,
        future: [state.source, ...state.future],
        editError: null,
      };
    }
    case "redo": {
      const [next, ...rest] = state.future;
      if (next === undefined) return state;
      return {
        ...state,
        past: [...state.past, state.source],
        source: next,
        future: rest,
        editError: null,
      };
    }
    case "saved":
      return { ...state, savedSource: state.source, baseOid: action.baseOid };
    case "clear-edit-error":
      return { ...state, editError: null };
  }
}

export type EditorHandle = {
  state: EditorState;
  /** Parse of the current source. */
  parse: EditorParseResult;
  /** The graph when the source parses; null in source-only mode. */
  graph: WorkflowGraph | null;
  dirty: boolean;
  /** True when a visual edit would rewrite constructs the file carries. */
  needsLossyConfirm: boolean;
  canUndo: boolean;
  canRedo: boolean;
  editSource: (source: string) => void;
  /** Apply a visual edit; refusals land in `state.editError`. */
  applyEdit: (result: EditResult) => void;
  select: (selection: Selection) => void;
  acceptLossy: () => void;
  connectStart: (from: string) => void;
  connectCancel: () => void;
  undo: () => void;
  redo: () => void;
  markSaved: (baseOid: string) => void;
  clearEditError: () => void;
};

export function useEditorState(
  initialSource: string,
  initialBaseOid: string | null,
): EditorHandle {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    past: [],
    source: initialSource,
    future: [],
    savedSource: initialSource,
    baseOid: initialBaseOid,
    selection: { kind: "graph" } as Selection,
    lossyAccepted: false,
    connectFrom: null,
    editError: null,
  }));

  const parse = useMemo(() => parseWorkflow(state.source), [state.source]);
  const graph = parse.ok ? parse.graph : null;

  const editSource = useCallback(
    (source: string) => dispatch({ type: "source-edited", source }),
    [],
  );
  const applyEdit = useCallback(
    (result: EditResult) => dispatch({ type: "visual-edit", result }),
    [],
  );
  const select = useCallback(
    (selection: Selection) => dispatch({ type: "select", selection }),
    [],
  );
  const acceptLossy = useCallback(() => dispatch({ type: "accept-lossy" }), []);
  const connectStart = useCallback(
    (from: string) => dispatch({ type: "connect-start", from }),
    [],
  );
  const connectCancel = useCallback(
    () => dispatch({ type: "connect-cancel" }),
    [],
  );
  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);
  const markSaved = useCallback(
    (baseOid: string) => dispatch({ type: "saved", baseOid }),
    [],
  );
  const clearEditError = useCallback(
    () => dispatch({ type: "clear-edit-error" }),
    [],
  );

  return {
    state,
    parse,
    graph,
    dirty: state.source !== state.savedSource,
    needsLossyConfirm:
      graph !== null && isLossy(graph) && !state.lossyAccepted,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    editSource,
    applyEdit,
    select,
    acceptLossy,
    connectStart,
    connectCancel,
    undo,
    redo,
    markSaved,
    clearEditError,
  };
}
