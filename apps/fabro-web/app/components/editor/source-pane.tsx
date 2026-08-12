/**
 * The source pane: the workflow file's text, always editable and always
 * lossless — edits here never rewrite anything the operator didn't type.
 * Diagnostics with a line number land under the text. workflow.toml rides
 * along read-only.
 */

import { useState } from "react";

import type { EditorDiagnostic } from "@qltysh/fabro-api-client";
import type { EditorParseResult } from "./model/parse";

const TAB_CLASS =
  "rounded-t-[10px] px-3 py-1.5 font-mono text-[11.5px] transition-colors " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fac-ink/60";

export default function SourcePane({
  source,
  onEdit,
  parse,
  diagnostics,
  tomlPath,
  tomlSource,
}: {
  source: string;
  onEdit: (next: string) => void;
  parse: EditorParseResult;
  diagnostics: readonly EditorDiagnostic[];
  tomlPath: string | null;
  tomlSource: string | null;
}) {
  const [tab, setTab] = useState<"fabro" | "toml">("fabro");
  const problems = diagnostics.filter(
    (diagnostic) => diagnostic.severity !== "info",
  );

  return (
    <div className="fac-card flex h-full min-h-0 flex-col overflow-hidden">
      <div
        role="tablist"
        aria-label="Workflow files"
        className="flex shrink-0 items-end gap-1 border-b border-fac-line px-2 pt-1.5"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "fabro"}
          onClick={() => setTab("fabro")}
          className={`${TAB_CLASS} ${
            tab === "fabro"
              ? "bg-fac-well text-fac-ink"
              : "text-fac-muted hover:text-fac-ink-2"
          }`}
        >
          workflow.fabro
        </button>
        {tomlSource !== null && (
          <button
            type="button"
            role="tab"
            aria-selected={tab === "toml"}
            onClick={() => setTab("toml")}
            className={`${TAB_CLASS} ${
              tab === "toml"
                ? "bg-fac-well text-fac-ink"
                : "text-fac-muted hover:text-fac-ink-2"
            }`}
            title={tomlPath ?? "workflow.toml"}
          >
            workflow.toml
          </button>
        )}
      </div>

      {tab === "fabro" ? (
        <>
          <textarea
            aria-label="Workflow source"
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-fac-well p-3 font-mono text-[12.5px] leading-relaxed text-fac-ink outline-none placeholder:text-fac-dim"
            value={source}
            onChange={(event) => onEdit(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
          {parse.ok === false && (
            <div className="shrink-0 border-t border-fac-red-line bg-fac-red-bg px-3 py-1.5 text-[12px] text-fac-red">
              Parse error at line {parse.line}, column {parse.column}:{" "}
              {parse.error}
            </div>
          )}
          {parse.ok && problems.length > 0 && (
            <ul
              aria-label="Validation problems"
              className="max-h-24 shrink-0 space-y-0.5 overflow-auto border-t border-fac-line bg-fac-well/60 px-3 py-1.5"
            >
              {problems.map((diagnostic, index) => (
                <li key={index} className="text-[12px]">
                  <span
                    className={
                      diagnostic.severity === "error"
                        ? "font-semibold text-fac-red"
                        : "text-fac-muted"
                    }
                  >
                    {diagnostic.severity}
                  </span>{" "}
                  <span className="font-mono text-fac-dim">
                    {diagnostic.rule}
                  </span>{" "}
                  <span className="text-fac-ink-2">{diagnostic.message}</span>
                  {diagnostic.node_id && (
                    <span className="font-mono text-fac-muted">
                      {" "}
                      · {diagnostic.node_id}
                    </span>
                  )}
                  {typeof diagnostic.line === "number" && (
                    <span className="tabular-nums text-fac-dim">
                      {" "}
                      · line {diagnostic.line}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto bg-fac-well p-3 font-mono text-[12.5px] leading-relaxed text-fac-ink-2">
          {tomlSource}
        </pre>
      )}
    </div>
  );
}
