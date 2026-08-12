import { describe, expect, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";

import { parseWorkflow } from "./model/parse";
import type { WorkflowGraph } from "./model/graph";
import NodePanel from "./inspector/node-panel";
import SkillPicker from "./inspector/skill-picker";
import SourcePane from "./source-pane";
import TopBar from "./top-bar";

function render(node: React.ReactNode): TestRenderer.ReactTestRenderer {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(node);
  });
  return tree!;
}

function textOf(tree: TestRenderer.ReactTestRenderer): string {
  const walk = (
    node: ReturnType<TestRenderer.ReactTestRenderer["toJSON"]>,
  ): string => {
    if (!node) return "";
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(walk).join(" ");
    return (node.children ?? []).map(walk).join(" ");
  };
  return walk(tree.toJSON()).replace(/\s+/g, " ");
}

function instanceText(instance: TestRenderer.ReactTestInstance): string {
  const parts: string[] = [];
  for (const child of instance.children) {
    if (typeof child === "string") parts.push(child);
    else parts.push(instanceText(child));
  }
  return parts.join("");
}

const GATE_DOT = `digraph Gate {
    graph [goal="g"]
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    approve [shape=hexagon, label="Approve plan?"]
    revise [label="Revise", prompt="Revise the plan."]
    start -> approve
    approve -> exit [label="[A] Approve"]
    approve -> revise [label="[R] Revise"]
    approve -> revise [freeform=true]
    revise -> approve
}`;

function gateGraph(): WorkflowGraph {
  const result = parseWorkflow(GATE_DOT);
  if (!result.ok) throw new Error(result.error);
  return result.graph;
}

const noop = () => {};

describe("TopBar", () => {
  const base = {
    repo: "/home/op/factory",
    path: ".fabro/workflows/dev/workflow.fabro",
    validating: false,
    saveState: { kind: "idle" } as const,
    pushState: { kind: "idle" } as const,
    repoStatus: {
      branch: "main",
      ahead: 2,
      behind: 0,
      has_upstream: true,
    },
    defaultCommitMessage: "Edit dev workflow",
    onSave: noop,
    onPush: noop,
    onClose: noop,
  };

  test("states its facts: unsaved changes, errors, push count", () => {
    const tree = render(
      <TopBar
        {...base}
        dirty
        parseOk
        errorCount={2}
        warningCount={1}
      />,
    );
    const text = textOf(tree);
    expect(text).toContain("unsaved changes");
    expect(text).toContain("2 errors");
    expect(text).toContain("1 warning");
    expect(text).toContain("Push · 2 ahead");
  });

  test("save is blocked while the source has errors", () => {
    const tree = render(
      <TopBar {...base} dirty parseOk errorCount={1} warningCount={0} />,
    );
    const save = tree.root
      .findAllByType("button")
      .find((button) => instanceText(button).includes("Save"))!;
    expect(save.props.disabled).toBe(true);
  });

  test("a clean, valid file reads as valid with nothing to save", () => {
    const tree = render(
      <TopBar
        {...base}
        dirty={false}
        parseOk
        errorCount={0}
        warningCount={0}
        saveState={{ kind: "committed", sha: "abc1234def" }}
      />,
    );
    const text = textOf(tree);
    expect(text).toContain("valid");
    expect(text).toContain("committed abc1234");
    expect(text).not.toContain("unsaved changes");
  });
});

describe("NodePanel gate section", () => {
  test("lists verdict edges and the freeform toggle from the graph", () => {
    const graph = gateGraph();
    const node = graph.nodes.find((candidate) => candidate.id === "approve")!;
    const tree = render(
      <NodePanel
        graph={graph}
        node={node}
        skills={[]}
        onApply={noop}
        onConnectStart={noop}
      />,
    );
    const inputs = tree.root.findAllByType("input");
    const verdictValues = inputs
      .map((input) => input.props.value)
      .filter((value) => typeof value === "string");
    expect(verdictValues).toContain("[A] Approve");
    expect(verdictValues).toContain("[R] Revise");
    const freeform = inputs.find((input) => input.props.type === "checkbox")!;
    expect(freeform.props.checked).toBe(true);
    expect(textOf(tree)).toContain("question");
  });
});

describe("SourcePane", () => {
  test("a parse failure names the line and keeps the text editable", () => {
    const source = "digraph Broken {\n  start [shape=Mdiamond\n}";
    const parse = parseWorkflow(source);
    const tree = render(
      <SourcePane
        source={source}
        onEdit={noop}
        parse={parse}
        diagnostics={[]}
        tomlPath={null}
        tomlSource={null}
      />,
    );
    expect(textOf(tree)).toContain("Parse error at line");
    const textarea = tree.root.findByType("textarea");
    expect(textarea.props.value).toBe(source);
  });

  test("diagnostics render rule, severity, and node anchor", () => {
    const parse = parseWorkflow(GATE_DOT);
    const tree = render(
      <SourcePane
        source={GATE_DOT}
        onEdit={noop}
        parse={parse}
        diagnostics={[
          {
            rule: "reachability",
            severity: "warning",
            message: "Node is unreachable from start",
            node_id: "revise",
          },
        ]}
        tomlPath={null}
        tomlSource={null}
      />,
    );
    const text = textOf(tree);
    expect(text).toContain("reachability");
    expect(text).toContain("warning");
    expect(text).toContain("revise");
  });
});

describe("SkillPicker", () => {
  test("filters and picks a slash command", () => {
    let picked: string | null = null;
    const skills = [
      { name: "tdd", description: "Test-driven development", source: "/s" },
      { name: "grilling", description: "Stress-test a plan", source: "/s" },
    ];
    const tree = render(
      <SkillPicker
        skills={skills}
        open
        onOpen={noop}
        onClose={noop}
        onPick={(command) => {
          picked = command;
        }}
      />,
    );
    act(() => {
      tree.root
        .findByType("input")
        .props.onChange({ target: { value: "grill" } });
    });
    const options = tree.root
      .findAllByType("button")
      .filter((button) => instanceText(button).includes("grilling"));
    expect(options.length).toBe(1);
    act(() => {
      options[0]!.props.onClick();
    });
    expect(picked).toBe("/grilling ");
  });
});
