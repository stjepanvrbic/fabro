import { useCallback, useMemo, useRef, useState } from "react";
import { MinusIcon, PlusIcon } from "@heroicons/react/20/solid";

import type { WorkflowGraph } from "../model/graph";
import type { Selection } from "../use-editor-state";
import {
  renderEditorCanvasDot,
  type CanvasDiagnostics,
} from "./render-canvas";
import { edgeIndexOf, useEditorCanvas } from "./use-editor-canvas";

const ZOOM_STEPS = [25, 50, 75, 100, 150, 200];
const DEFAULT_ZOOM_INDEX = 3;

/**
 * The editor canvas: Graphviz auto-layout on the warm charcoal ground.
 * Layout is computed, never stored. Nodes and edges are selectable; in
 * connect mode the next node click completes the edge.
 */
export default function EditorCanvas({
  graph,
  diagnostics,
  selection,
  connectFrom,
  onSelect,
  onConnectTo,
}: {
  graph: WorkflowGraph;
  diagnostics: CanvasDiagnostics;
  selection: Selection;
  /** Pending click-click connect source, or null. */
  connectFrom: string | null;
  onSelect: (selection: Selection) => void;
  onConnectTo: (target: string) => void;
}) {
  const dot = useMemo(
    () => renderEditorCanvasDot(graph, diagnostics),
    [graph, diagnostics],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragState = useRef<{
    startX: number;
    startY: number;
    startPanX: number;
    startPanY: number;
    moved: boolean;
  } | null>(null);
  const zoom = ZOOM_STEPS[zoomIndex]!;

  const { svgRef, error } = useEditorCanvas(
    innerRef,
    dot,
    selection,
    graph.edges,
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if ((event.target as HTMLElement).closest("button")) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      dragState.current = {
        startX: event.clientX,
        startY: event.clientY,
        startPanX: pan.x,
        startPanY: pan.y,
        moved: false,
      };
    },
    [pan],
  );

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const drag = dragState.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) {
      drag.moved = true;
    }
    setPan({ x: drag.startPanX + dx, y: drag.startPanY + dy });
  }, []);

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragState.current;
      dragState.current = null;
      if (!drag || drag.moved) return;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const nodeGroup = hit?.closest("g.node");
      if (nodeGroup) {
        const title = nodeGroup.querySelector(":scope > title");
        const id = title?.textContent?.trim();
        if (id) {
          if (connectFrom) {
            onConnectTo(id);
          } else {
            onSelect({ kind: "node", id });
          }
        }
        return;
      }
      const edgeGroup = hit?.closest("g.edge");
      if (edgeGroup && svgRef.current) {
        const index = edgeIndexOf(svgRef.current, edgeGroup, graph.edges);
        if (index !== null) {
          onSelect({ kind: "edge", index });
          return;
        }
      }
      onSelect({ kind: "graph" });
    },
    [connectFrom, graph.edges, onConnectTo, onSelect, svgRef],
  );

  const fitToWindow = useCallback(() => {
    const svg = svgRef.current;
    const container = containerRef.current;
    if (!svg || !container) return;
    const svgW = svg.viewBox.baseVal.width || svg.getBoundingClientRect().width;
    const svgH =
      svg.viewBox.baseVal.height || svg.getBoundingClientRect().height;
    const padPx = 48;
    const fitPct =
      Math.min(
        (container.clientWidth - padPx) / svgW,
        (container.clientHeight - padPx) / svgH,
      ) * 100;
    let best = 0;
    for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
      if (ZOOM_STEPS[i]! <= fitPct) {
        best = i;
        break;
      }
    }
    setZoomIndex(best);
    setPan({ x: 0, y: 0 });
  }, [svgRef]);

  return (
    <div className="fac-card relative isolate flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
        <div className="flex items-center rounded-[10px] border border-fac-line-strong bg-fac-card/90 p-0.5">
          <button
            type="button"
            title="Fit to window"
            aria-label="Fit diagram to window"
            onClick={fitToWindow}
            className="flex size-7 items-center justify-center rounded text-fac-muted transition-colors hover:bg-fac-hover hover:text-fac-ink-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fac-ink"
          >
            <svg
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              className="size-3.5"
              aria-hidden="true"
            >
              <rect
                x="1"
                y="1"
                width="12"
                height="12"
                rx="1.5"
                strokeWidth="1.5"
                strokeDasharray="3 2"
              />
            </svg>
          </button>
        </div>
        <div className="flex items-center gap-0.5 rounded-[10px] border border-fac-line-strong bg-fac-card/90 p-0.5">
          <button
            type="button"
            title="Zoom out"
            aria-label="Zoom out"
            onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
            disabled={zoomIndex === 0}
            className="flex size-7 items-center justify-center rounded text-fac-muted transition-colors hover:bg-fac-hover hover:text-fac-ink-2 disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fac-ink"
          >
            <MinusIcon className="size-4" />
          </button>
          <span className="px-1 font-mono text-[11px] tabular-nums text-fac-muted">
            {zoom}%
          </span>
          <button
            type="button"
            title="Zoom in"
            aria-label="Zoom in"
            onClick={() =>
              setZoomIndex((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))
            }
            disabled={zoomIndex === ZOOM_STEPS.length - 1}
            className="flex size-7 items-center justify-center rounded text-fac-muted transition-colors hover:bg-fac-hover hover:text-fac-ink-2 disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fac-ink"
          >
            <PlusIcon className="size-4" />
          </button>
        </div>
      </div>

      {connectFrom && (
        <div
          className="absolute left-3 top-3 z-10 rounded-[10px] border border-fac-line-strong bg-fac-card/90 px-3 py-1.5 text-[12px] text-fac-ink-2"
          role="status"
        >
          Connecting from{" "}
          <span className="font-mono text-fac-ink">{connectFrom}</span> — click
          the target node, or press Esc.
        </div>
      )}

      {error ? (
        <p className="m-6 text-sm text-fac-red">{error}</p>
      ) : (
        <div
          ref={containerRef}
          className="flex flex-1 overflow-hidden p-6"
          style={{
            cursor: connectFrom
              ? "crosshair"
              : dragState.current
                ? "grabbing"
                : "grab",
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div
            ref={innerRef}
            className="m-auto"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom / 100})`,
              transformOrigin: "center center",
            }}
          >
            <p className="text-sm text-fac-muted">Loading canvas&hellip;</p>
          </div>
        </div>
      )}
    </div>
  );
}
