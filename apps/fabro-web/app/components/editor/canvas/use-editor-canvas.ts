/**
 * Synchronizes the editor's DOT with the imperative @viz-js SVG renderer,
 * and keeps the selection highlight applied to the rendered SVG's DOM.
 *
 * External systems: the Graphviz WASM renderer and the SVG element tree it
 * produces. Rendering replaces the container's children; the highlight
 * effect mutates inline styles on the current SVG and fully resets them
 * before each application, so re-runs and unmounts leave no residue.
 */

import { useCallback, useEffect, useRef } from "react";

import { useRenderedVizDiagram } from "~/hooks/use-rendered-viz-diagram";
import type { Selection } from "../use-editor-state";
import { editorCanvasTheme } from "./render-canvas";

const SELECT_STROKE = "#f0eeec";
const SELECT_GLOW = "drop-shadow(0 0 6px rgba(240, 238, 236, 0.35))";
/** Invisible widened stroke so thin edge paths are clickable. */
const EDGE_HIT_CLASS = "editor-edge-hit";

export function titleOf(group: Element): string | null {
  const title = group.querySelector(":scope > title");
  return title?.textContent?.trim() || null;
}

/**
 * Map a clicked `g.edge` group to its index in `graph.edges`. Parallel
 * edges share one `from->to` title; Graphviz emits them in input order, so
 * the nth group with a title maps to the nth edge with that pair.
 */
export function edgeIndexOf(
  svg: SVGSVGElement,
  group: Element,
  edges: readonly { from: string; to: string }[],
): number | null {
  const title = titleOf(group);
  if (!title) return null;
  const groups = [...svg.querySelectorAll("g.edge")].filter(
    (g) => titleOf(g) === title,
  );
  const occurrence = groups.indexOf(group);
  if (occurrence < 0) return null;
  let seen = 0;
  for (let index = 0; index < edges.length; index++) {
    const edge = edges[index]!;
    if (`${edge.from}->${edge.to}` === title) {
      if (seen === occurrence) return index;
      seen++;
    }
  }
  return null;
}

function prepareHitAreas(svg: SVGSVGElement): void {
  for (const group of svg.querySelectorAll<SVGGElement>("g.node, g.edge")) {
    group.style.cursor = "pointer";
  }
  for (const group of svg.querySelectorAll<SVGGElement>("g.edge")) {
    for (const path of group.querySelectorAll<SVGPathElement>(
      `:scope > path:not(.${EDGE_HIT_CLASS})`,
    )) {
      const hit = path.cloneNode(false) as SVGPathElement;
      hit.classList.add(EDGE_HIT_CLASS);
      hit.setAttribute("stroke", "transparent");
      hit.setAttribute("stroke-width", "12");
      hit.setAttribute("fill", "none");
      group.append(hit);
    }
  }
}

function applyHighlight(
  svg: SVGSVGElement,
  selection: Selection,
  edges: readonly { from: string; to: string }[],
): void {
  for (const group of svg.querySelectorAll<SVGGElement>("g.node")) {
    const isSelected =
      selection.kind === "node" && titleOf(group) === selection.id;
    for (const shape of group.querySelectorAll<SVGElement>(
      "polygon, ellipse, path",
    )) {
      if (isSelected) {
        shape.style.stroke = SELECT_STROKE;
        shape.style.strokeWidth = "2";
        shape.style.filter = SELECT_GLOW;
      } else {
        shape.style.stroke = "";
        shape.style.strokeWidth = "";
        shape.style.filter = "";
      }
    }
  }
  const selectedTitle =
    selection.kind === "edge" && edges[selection.index]
      ? `${edges[selection.index]!.from}->${edges[selection.index]!.to}`
      : null;
  let occurrence =
    selection.kind === "edge" && selectedTitle
      ? edges
          .slice(0, selection.index)
          .filter((edge) => `${edge.from}->${edge.to}` === selectedTitle)
          .length
      : -1;
  for (const group of svg.querySelectorAll<SVGGElement>("g.edge")) {
    let isSelected = false;
    if (selectedTitle && titleOf(group) === selectedTitle) {
      isSelected = occurrence === 0;
      occurrence--;
    }
    for (const shape of group.querySelectorAll<SVGElement>(
      `:scope > path:not(.${EDGE_HIT_CLASS}), :scope > polygon`,
    )) {
      if (isSelected) {
        shape.style.stroke = SELECT_STROKE;
        shape.style.strokeWidth = "2";
        shape.style.filter = SELECT_GLOW;
        if (shape.tagName === "polygon") shape.style.fill = SELECT_STROKE;
      } else {
        shape.style.stroke = "";
        shape.style.strokeWidth = "";
        shape.style.filter = "";
        shape.style.fill = "";
      }
    }
  }
}

export function useEditorCanvas(
  innerRef: { current: HTMLDivElement | null },
  dot: string,
  selection: Selection,
  edges: readonly { from: string; to: string }[],
): { svgRef: { current: SVGSVGElement | null }; error: string | null } {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const prepareSvg = useCallback((svg: SVGSVGElement) => {
    prepareHitAreas(svg);
  }, []);
  const error = useRenderedVizDiagram({
    buildDot: (identity: string) => identity,
    innerRef,
    identity: dot,
    prepareSvg,
    svgRef,
  });

  // Re-applied after every render and selection change; the render effect
  // replaces the SVG, so residue cannot survive either path.
  useEffect(() => {
    const svg = svgRef.current;
    if (svg) applyHighlight(svg, selection, edges);
  });

  return { svgRef, error };
}

export const editorCanvasColors = editorCanvasTheme;
