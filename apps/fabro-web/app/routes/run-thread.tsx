import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { QuestionType } from "@qltysh/fabro-api-client";
import type {
  ApiQuestion,
  EventEnvelope,
  InterviewOption,
} from "@qltysh/fabro-api-client";

import { displayLabel } from "../components/interview-label";
import { ErrorState, LoadingState } from "../components/state";
import { ErrorMessage } from "../components/ui";
import { classNames } from "../lib/class-names";
import { useRun, useRunEventsList, useRunQuestions } from "../lib/queries";
import {
  useSubmitInterviewAnswer,
  type SubmitInterviewAnswerArg,
} from "../lib/mutations";

export const handle = { hideSteerBar: true };

/**
 * One thread per run: the chronological record of the run's human exchanges —
 * interview rounds (conversational asks included), gate verdicts, escalations,
 * steering, and thin lifecycle markers. It is a view over run events, never
 * agent memory. Full live agent output lives in the stage stream, not here.
 */
export default function RunThread() {
  const { id } = useParams();
  const runQuery = useRun(id, 5000);
  const eventsQuery = useRunEventsList(id);
  const questionsQuery = useRunQuestions(id, true);

  const items = useMemo(
    () => threadItems(eventsQuery.data ?? []),
    [eventsQuery.data],
  );

  if (eventsQuery.error) return <ErrorState description={String(eventsQuery.error)} />;
  if (!eventsQuery.data && eventsQuery.isLoading) return <LoadingState />;

  const status = runQuery.data?.lifecycle?.status?.kind ?? null;
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-1 flex-col">
      <ThreadHistory items={items} />
      <ThreadComposer
        runId={id!}
        runStatus={status}
        questions={questionsQuery.data ?? []}
      />
    </div>
  );
}

export type ThreadItem =
  | { kind: "ask"; seq: number; ts: string; stage: string; text: string;
      options: InterviewOption[]; questionType: string }
  | { kind: "answer"; seq: number; ts: string; stage: string; text: string;
      actor: string }
  | { kind: "steering"; seq: number; ts: string; stage: string; text: string;
      actor: string }
  | { kind: "marker"; seq: number; ts: string; text: string };

function actorName(event: EventEnvelope): string {
  const actor = event.actor as { login?: string; kind?: string } | null | undefined;
  return actor?.login ?? actor?.kind ?? "operator";
}

function property(event: EventEnvelope, key: string): unknown {
  return (event.properties as Record<string, unknown> | undefined)?.[key];
}

function text(event: EventEnvelope, key: string): string {
  const value = property(event, key);
  return typeof value === "string" ? value : "";
}

/**
 * Project run events onto the thread: human touchpoints only. Everything the
 * operator said or was asked appears; agent work stays in the stage stream.
 * Lifecycle markers are thin — stage boundaries and the run's start and end.
 */
export function threadItems(events: EventEnvelope[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  for (const event of events) {
    const base = { seq: event.seq, ts: event.ts };
    const stage = event.node_id ?? "";
    switch (event.event) {
      case "interview.started":
        items.push({
          ...base, kind: "ask", stage: text(event, "stage") || stage,
          text: text(event, "question"),
          options: (property(event, "options") as InterviewOption[]) ?? [],
          questionType: text(event, "question_type"),
        });
        break;
      case "interview.completed":
        items.push({
          ...base, kind: "answer", stage: text(event, "stage") || stage,
          text: text(event, "answer"), actor: actorName(event),
        });
        break;
      case "interview.timeout":
      case "interview.interrupted":
        items.push({
          ...base, kind: "marker",
          text: `Question ${event.event === "interview.timeout" ? "timed out" : "interrupted"}: ${text(event, "question")}`,
        });
        break;
      case "agent.steering.injected":
        items.push({
          ...base, kind: "steering", stage,
          text: text(event, "text"), actor: actorName(event),
        });
        break;
      case "run.started":
        items.push({ ...base, kind: "marker", text: "Run started" });
        break;
      case "run.completed":
        items.push({ ...base, kind: "marker", text: "Run completed" });
        break;
      case "run.failed":
        items.push({ ...base, kind: "marker", text: "Run failed" });
        break;
      case "stage.started":
        items.push({
          ...base, kind: "marker",
          text: `Stage ${event.node_label ?? event.node_id ?? ""} started`,
        });
        break;
      default:
        break;
    }
  }
  return items;
}

function ThreadHistory({ items }: { items: ThreadItem[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [items.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto py-4">
      {items.length === 0 && (
        <p className="py-8 text-center text-sm text-fg-muted">
          Nothing has needed you yet. Questions, verdicts, escalations, and
          steering will appear here.
        </p>
      )}
      {items.map((item) => (
        <ThreadRow key={item.seq} item={item} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

function ThreadRow({ item }: { item: ThreadItem }) {
  switch (item.kind) {
    case "marker":
      return (
        <div className="flex items-center gap-3 px-2 text-xs text-fg-muted">
          <span className="h-px flex-1 bg-line" />
          <span>{item.text}</span>
          <span className="h-px flex-1 bg-line" />
        </div>
      );
    case "ask":
      return (
        <div className="mr-12 rounded-xl bg-panel px-4 py-3 outline-1 -outline-offset-1 outline-line">
          <div className="mb-1 font-mono text-[0.6875rem] tracking-wide text-fg-muted uppercase">
            {item.stage}
          </div>
          <p className="text-sm/6 whitespace-pre-wrap text-fg">{item.text}</p>
          {item.options.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {item.options.map((option) => (
                <span
                  key={option.key}
                  className="rounded-full bg-panel-alt px-2.5 py-0.5 text-xs text-fg-2"
                >
                  {displayLabel(option.label)}
                </span>
              ))}
            </div>
          )}
        </div>
      );
    case "answer":
      return (
        <div className="ml-12 self-end rounded-xl bg-teal-500/10 px-4 py-3 outline-1 -outline-offset-1 outline-teal-500/30">
          <div className="mb-1 font-mono text-[0.6875rem] tracking-wide text-fg-muted uppercase">
            {item.actor}
          </div>
          <p className="text-sm/6 whitespace-pre-wrap text-fg">{item.text}</p>
        </div>
      );
    case "steering":
      return (
        <div className="ml-12 self-end rounded-xl bg-panel-alt px-4 py-3 outline-1 -outline-offset-1 outline-line">
          <div className="mb-1 font-mono text-[0.6875rem] tracking-wide text-fg-muted uppercase">
            {item.actor} steered {item.stage}
          </div>
          <p className="text-sm/6 whitespace-pre-wrap text-fg">{item.text}</p>
        </div>
      );
  }
}

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "archived"]);

/**
 * The strict composer: it targets exactly one recipient. With pending
 * questions it answers the selected one (a selector appears when several wait
 * in parallel); a gate's options render as verdict buttons with an optional
 * message. With nothing to receive it is disabled and says why.
 */
function ThreadComposer({
  runId,
  runStatus,
  questions,
}: {
  runId: string;
  runStatus: string | null;
  questions: ApiQuestion[];
}) {
  const [targetId, setTargetId] = useState<string | null>(null);
  const submitMutation = useSubmitInterviewAnswer(runId);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const target =
    questions.find((question) => question.id === targetId) ?? questions[0] ?? null;

  const submit = async (answer: SubmitInterviewAnswerArg["answer"]) => {
    if (!target) return;
    setError(null);
    try {
      await submitMutation.trigger({ questionId: target.id, answer });
      setMessage("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Answer failed");
    }
  };

  if (!target) {
    const reason = runStatus && TERMINAL_STATUSES.has(runStatus)
      ? "This run is finished — nothing can receive a message."
      : "No one is waiting on you — the agents are working.";
    return (
      <div className="border-t border-line py-3">
        <input
          type="text"
          disabled
          placeholder={reason}
          className="w-full rounded-lg bg-panel px-3 py-2 text-sm text-fg-muted outline-1 -outline-offset-1 outline-line"
        />
      </div>
    );
  }

  const hasOptions = target.options.length > 0;
  const submitting = submitMutation.isMutating;
  return (
    <div className="flex flex-col gap-2 border-t border-line py-3">
      {questions.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
          <span>Answering:</span>
          {questions.map((question) => (
            <button
              key={question.id}
              type="button"
              onClick={() => setTargetId(question.id)}
              className={classNames(
                "rounded-full px-2.5 py-0.5 outline-1 -outline-offset-1",
                question.id === target.id
                  ? "bg-amber-500/15 text-fg outline-amber-500/40"
                  : "bg-panel text-fg-2 outline-line hover:text-fg",
              )}
            >
              {question.stage}
            </button>
          ))}
        </div>
      )}
      <p className="text-sm/6 text-fg-2">{target.text}</p>
      {hasOptions && (
        <div className="flex flex-wrap gap-1.5">
          {target.options.map((option) => (
            <button
              key={option.key}
              type="button"
              disabled={submitting}
              onClick={() =>
                void submit({
                  kind: "selected",
                  option_key: option.key,
                  ...(message.trim() ? { text: message.trim() } : {}),
                })
              }
              className="rounded-lg bg-panel px-3 py-1.5 text-sm text-fg outline-1 -outline-offset-1 outline-line hover:bg-panel-alt disabled:opacity-50"
            >
              {displayLabel(option.label)}
            </button>
          ))}
        </div>
      )}
      {(target.allow_freeform ||
        target.question_type === QuestionType.FREEFORM ||
        hasOptions) && (
        <form
          className="flex gap-2"
          onSubmit={(submitEvent) => {
            submitEvent.preventDefault();
            if (!message.trim()) return;
            // With options shown, plain text is the freeform path; without
            // options the text IS the answer.
            void submit({ kind: "text", text: message.trim() });
          }}
        >
          <input
            type="text"
            value={message}
            onChange={(changeEvent) => setMessage(changeEvent.target.value)}
            disabled={submitting}
            placeholder={
              hasOptions
                ? "Optional message — attach to a verdict button, or press Enter to send as freeform"
                : "Reply to the agent…"
            }
            className="w-full rounded-lg bg-panel px-3 py-2 text-sm text-fg outline-1 -outline-offset-1 outline-line placeholder:text-fg-muted"
          />
        </form>
      )}
      {error && <ErrorMessage message={error} />}
    </div>
  );
}
