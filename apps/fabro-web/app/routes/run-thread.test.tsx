import { describe, expect, test } from "bun:test";
import type { EventEnvelope } from "@qltysh/fabro-api-client";

import { threadItems } from "./run-thread";

let seq = 0;
function event(
  name: string,
  properties: Record<string, unknown> = {},
  extra: Partial<EventEnvelope> = {},
): EventEnvelope {
  seq += 1;
  return {
    seq,
    id: `evt-${seq}`,
    ts: `2026-08-12T00:00:${String(seq).padStart(2, "0")}Z`,
    run_id: "run-1",
    event: name,
    properties,
    ...extra,
  } as EventEnvelope;
}

describe("threadItems", () => {
  test("projects human touchpoints and thin lifecycle markers only", () => {
    const items = threadItems([
      event("run.started"),
      event("stage.started", {}, { node_id: "plan", node_label: "Plan" }),
      event("agent.message", { text: "agent noise" }),
      event("interview.started", {
        question: "Which color?",
        stage: "plan",
        question_type: "freeform",
      }),
      event("interview.completed", {
        question: "Which color?",
        answer: "blue",
      }, { actor: { kind: "user", login: "sv" } as EventEnvelope["actor"] }),
      event("agent.steering.injected", { text: "focus on tests" }, {
        node_id: "plan",
        actor: { kind: "user", login: "sv" } as EventEnvelope["actor"],
      }),
      event("run.completed"),
    ]);

    expect(items.map((item) => item.kind)).toEqual([
      "marker", "marker", "ask", "answer", "steering", "marker",
    ]);
    const ask = items[2];
    expect(ask.kind === "ask" && ask.text).toBe("Which color?");
    expect(ask.kind === "ask" && ask.stage).toBe("plan");
    const answer = items[3];
    expect(answer.kind === "answer" && answer.text).toBe("blue");
    expect(answer.kind === "answer" && answer.actor).toBe("sv");
    const steering = items[4];
    expect(steering.kind === "steering" && steering.text).toBe("focus on tests");
  });

  test("gate questions carry their options; interruptions become markers", () => {
    const items = threadItems([
      event("interview.started", {
        question: "Proceed?",
        stage: "approve",
        question_type: "multiple_choice",
        options: [
          { key: "A", label: "[A] Approve" },
          { key: "R", label: "[R] Reject" },
        ],
      }),
      event("interview.interrupted", { question: "Proceed?" }),
    ]);
    const ask = items[0];
    expect(ask.kind === "ask" && ask.options.map((option) => option.key)).toEqual([
      "A",
      "R",
    ]);
    expect(items[1].kind).toBe("marker");
    expect(items[1].text).toContain("interrupted");
  });

  test("agent-only events never reach the thread", () => {
    const items = threadItems([
      event("agent.tool.started", { tool: "Write" }),
      event("agent.message", { text: "thinking" }),
      event("checkpoint.completed", {}),
      event("git.commit", {}),
    ]);
    expect(items).toEqual([]);
  });
});
