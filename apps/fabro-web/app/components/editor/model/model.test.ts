import { describe, expect, test } from "bun:test";

import {
  addEdge,
  addNode,
  deleteEdge,
  deleteNode,
  renameNode,
  retargetEdge,
  setFreeformEdge,
  setGraphAttr,
  updateEdge,
  updateNode,
} from "./edit";
import { createEmptyGraph, goalOf, isLossy, lossyDescription, rankdirOf } from "./graph";
import type { WorkflowGraph } from "./graph";
import { parseWorkflow } from "./parse";
import { serializeWorkflow } from "./serialize";

/** From `.fabro/workflows/interview` — parallel edges and a freeform edge. */
const INTERVIEW_DOT = `digraph Interview {
    graph [goal="Run a progressive human interview and summarize the answers"]
    rankdir=LR

    start [shape=Mdiamond, label="Start"]
    exit  [shape=Msquare, label="Exit"]

    yes_no [
        shape=hexagon,
        label="Is this interview workflow easy to follow so far?",
        question_type="yes_no"
    ]
    summarize [
        shape=tab,
        label="Summarize Interview",
        fidelity="summary:high",
        prompt="Summarize the interview."
    ]

    start -> yes_no

    yes_no -> summarize [label="[Y] Yes"]
    yes_no -> summarize [label="[N] No"]

    yes_no -> summarize [freeform=true]
    summarize -> exit
}
`;

/** From `.fabro/workflows/implement-issue` — stylesheet and dotted keys. */
const IMPLEMENT_ISSUE_DOT = `digraph ImplementIssue {
    graph [
        goal="Implement a GitHub issue",
        model_stylesheet="
            * { model: claude-opus-4-7; }
        "
    ]
    rankdir=LR

    start [shape=Mdiamond, label="Start"]
    exit  [shape=Msquare, label="Exit"]

    plan [label="Plan", prompt="Write plan.md.\\n\\nRespond with the location."]

    implement [label="Implement", shape=house, stack.child_workflow="fabro/workflows/implement-plan/workflow.fabro", manager.max_cycles=100]

    start -> plan
    plan -> implement [fidelity="summary:high"]
    implement -> exit
}
`;

function mustParse(source: string): WorkflowGraph {
  const result = parseWorkflow(source);
  if (!result.ok) {
    throw new Error(`fixture should parse: ${result.error}`);
  }
  return result.graph;
}

/** Strip the lossy counters, which describe the source text, not the graph. */
function semantics(graph: WorkflowGraph) {
  const { lossy: _lossy, ...rest } = graph;
  return rest;
}

describe("parseWorkflow", () => {
  test("keeps parallel edges between the same pair", () => {
    const graph = mustParse(INTERVIEW_DOT);
    const verdicts = graph.edges.filter(
      (edge) => edge.from === "yes_no" && edge.to === "summarize",
    );
    expect(verdicts.length).toBe(3);
    expect(verdicts[0]!.attrs.label).toBe("[Y] Yes");
    expect(verdicts[1]!.attrs.label).toBe("[N] No");
    expect(verdicts[2]!.attrs.freeform).toBe(true);
  });

  test("keeps every graph attribute in order", () => {
    const graph = mustParse(IMPLEMENT_ISSUE_DOT);
    expect(graph.graphAttrs.map(([key]) => key)).toEqual([
      "goal",
      "model_stylesheet",
      "rankdir",
    ]);
    expect(goalOf(graph)).toBe("Implement a GitHub issue");
    expect(String(graph.graphAttrs[1]![1])).toContain("claude-opus-4-7");
    expect(rankdirOf(graph)).toBe("LR");
  });

  test("parses dotted attribute keys", () => {
    const graph = mustParse(IMPLEMENT_ISSUE_DOT);
    const implement = graph.nodes.find((node) => node.id === "implement")!;
    expect(implement.shape).toBe("house");
    expect(implement.attrs?.["stack.child_workflow"]).toBe(
      "fabro/workflows/implement-plan/workflow.fabro",
    );
    expect(implement.attrs?.["manager.max_cycles"]).toBe(100);
  });

  test("counts comments as a lossy construct", () => {
    const source = `digraph C {
        graph [goal="g"]
        // why this node exists
        start [shape=Mdiamond]
        exit [shape=Msquare]
        start -> exit
    }`;
    const graph = mustParse(source);
    expect(graph.lossy.comments).toBe(1);
    expect(isLossy(graph)).toBe(true);
    expect(lossyDescription(graph.lossy)).toBe("1 comment");
  });

  test("flattens subgraphs and counts them", () => {
    const source = `digraph S {
        graph [goal="g"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        subgraph cluster_impl {
            plan [label="Plan", prompt="p"]
            implement [label="Implement", prompt="i"]
        }
        start -> plan -> implement -> exit
    }`;
    const graph = mustParse(source);
    expect(graph.lossy.subgraphs).toBe(1);
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "start",
      "exit",
      "plan",
      "implement",
    ]);
    expect(graph.edges.length).toBe(3);
  });

  test("counts node and edge default statements", () => {
    const source = `digraph D {
        graph [goal="g"]
        node [fidelity="full"]
        edge [weight=2]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        start -> exit
    }`;
    const graph = mustParse(source);
    expect(graph.lossy.defaultStatements).toBe(2);
  });

  test("reports parse failures with line and column", () => {
    const result = parseWorkflow("digraph Broken {\n  start [shape=Mdiamond\n}");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.line).toBeGreaterThan(1);
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  test("merges repeated node declarations", () => {
    const source = `digraph M {
        graph [goal="g"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        work [label="Work"]
        work [prompt="do the work"]
        start -> work -> exit
    }`;
    const graph = mustParse(source);
    const work = graph.nodes.find((node) => node.id === "work")!;
    expect(work.label).toBe("Work");
    expect(work.prompt).toBe("do the work");
  });
});

describe("serializeWorkflow", () => {
  test("round-trips the interview fixture semantically", () => {
    const first = mustParse(INTERVIEW_DOT);
    const second = mustParse(serializeWorkflow(first));
    expect(semantics(second)).toEqual(semantics(first));
    expect(second.lossy).toEqual({
      comments: 0,
      subgraphs: 0,
      defaultStatements: 0,
    });
  });

  test("round-trips the implement-issue fixture semantically", () => {
    const first = mustParse(IMPLEMENT_ISSUE_DOT);
    const second = mustParse(serializeWorkflow(first));
    expect(semantics(second)).toEqual(semantics(first));
  });

  test("renders goal first and rankdir as a bare assignment", () => {
    const graph = mustParse(IMPLEMENT_ISSUE_DOT);
    const rendered = serializeWorkflow(graph);
    expect(rendered).toContain("    graph [\n        goal=");
    expect(rendered).toContain("\n    rankdir=LR\n");
  });

  test("a canonical file round-trips to identical text", () => {
    const graph = mustParse(INTERVIEW_DOT);
    const once = serializeWorkflow(graph);
    const twice = serializeWorkflow(mustParse(once));
    expect(twice).toBe(once);
  });
});

describe("edit operations", () => {
  test("a new workflow is a runnable start-to-exit skeleton", () => {
    const graph = createEmptyGraph("fresh");
    expect(graph.nodes.map((node) => node.id)).toEqual(["start", "exit"]);
    expect(graph.edges).toEqual([{ from: "start", to: "exit", attrs: {} }]);
    const rendered = serializeWorkflow(graph);
    expect(mustParse(rendered).nodes.length).toBe(2);
  });

  test("rename rewires every referencing edge", () => {
    const graph = mustParse(INTERVIEW_DOT);
    const result = renameNode(graph, "summarize", "wrap_up");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.graph.edges.filter((edge) => edge.to === "wrap_up").length,
      ).toBe(3);
      expect(
        result.graph.edges.some(
          (edge) => edge.from === "summarize" || edge.to === "summarize",
        ),
      ).toBe(false);
    }
  });

  test("deleting a node removes its edges", () => {
    const graph = mustParse(INTERVIEW_DOT);
    const result = deleteNode(graph, "yes_no");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.graph.edges.some(
          (edge) => edge.from === "yes_no" || edge.to === "yes_no",
        ),
      ).toBe(false);
    }
  });

  test("self-loops and parallel edges are allowed", () => {
    const base = mustParse(INTERVIEW_DOT);
    const withLoop = addEdge(base, "yes_no", "yes_no");
    expect(withLoop.ok).toBe(true);
    const withParallel = addEdge(base, "yes_no", "summarize");
    expect(withParallel.ok).toBe(true);
  });

  test("edges into start and out of exit are refused", () => {
    const graph = mustParse(INTERVIEW_DOT);
    expect(addEdge(graph, "exit", "yes_no").ok).toBe(false);
    expect(addEdge(graph, "yes_no", "start").ok).toBe(false);
    expect(retargetEdge(graph, 0, "start").ok).toBe(false);
  });

  test("edge updates address one edge by index", () => {
    const graph = mustParse(INTERVIEW_DOT);
    const index = graph.edges.findIndex(
      (edge) => edge.attrs.label === "[N] No",
    );
    const result = updateEdge(graph, index, {
      label: "[N] Not yet",
      weight: 2,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.graph.edges[index]!.attrs).toEqual({
        label: "[N] Not yet",
        weight: 2,
      });
      const other = graph.edges.findIndex(
        (edge) => edge.attrs.label === "[Y] Yes",
      );
      expect(result.graph.edges[other]!.attrs.label).toBe("[Y] Yes");
    }
  });

  test("the freeform toggle keeps at most one freeform edge", () => {
    const graph = mustParse(INTERVIEW_DOT);
    const retargeted = setFreeformEdge(graph, "yes_no", "exit");
    expect(retargeted.ok).toBe(true);
    if (retargeted.ok) {
      const freeform = retargeted.graph.edges.filter(
        (edge) => edge.from === "yes_no" && edge.attrs.freeform === true,
      );
      expect(freeform.length).toBe(1);
      expect(freeform[0]!.to).toBe("exit");
    }
    const cleared = setFreeformEdge(graph, "yes_no", null);
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(
        cleared.graph.edges.some((edge) => edge.attrs.freeform === true),
      ).toBe(false);
    }
  });

  test("graph attributes edit in place and preserve order", () => {
    const graph = mustParse(IMPLEMENT_ISSUE_DOT);
    const updated = setGraphAttr(graph, "goal", "Implement two issues");
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.graph.graphAttrs.map(([key]) => key)).toEqual([
        "goal",
        "model_stylesheet",
        "rankdir",
      ]);
      expect(goalOf(updated.graph)).toBe("Implement two issues");
    }
    const removed = setGraphAttr(graph, "model_stylesheet", undefined);
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expect(
        removed.graph.graphAttrs.some(([key]) => key === "model_stylesheet"),
      ).toBe(false);
    }
  });

  test("node updates support prompts, attrs, and guarded shapes", () => {
    const graph = mustParse(INTERVIEW_DOT);
    const withPrompt = updateNode(graph, "yes_no", {
      prompt: "Ask nicely.",
      attrs: { question_type: "confirmation", timeout: "900s" },
    });
    expect(withPrompt.ok).toBe(true);
    if (withPrompt.ok) {
      const node = withPrompt.graph.nodes.find((n) => n.id === "yes_no")!;
      expect(node.prompt).toBe("Ask nicely.");
      expect(node.attrs).toEqual({
        question_type: "confirmation",
        timeout: "900s",
      });
    }
    expect(updateNode(graph, "start", { shape: "box" }).ok).toBe(false);
    expect(addNode(graph, "yes_no", "box").ok).toBe(false);
    const added = addNode(graph, "review_batch", "component");
    expect(added.ok).toBe(true);
    if (added.ok) {
      const node = added.graph.nodes.find((n) => n.id === "review_batch")!;
      expect(node.label).toBe("Review Batch");
    }
  });

  test("deleteEdge removes exactly the indexed edge", () => {
    const graph = mustParse(INTERVIEW_DOT);
    const before = graph.edges.length;
    const index = graph.edges.findIndex(
      (edge) => edge.attrs.label === "[Y] Yes",
    );
    const result = deleteEdge(graph, index);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.graph.edges.length).toBe(before - 1);
      expect(
        result.graph.edges.some((edge) => edge.attrs.label === "[Y] Yes"),
      ).toBe(false);
      expect(
        result.graph.edges.some((edge) => edge.attrs.label === "[N] No"),
      ).toBe(true);
    }
  });
});
