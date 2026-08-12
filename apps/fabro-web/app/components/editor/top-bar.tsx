/**
 * The editor's top bar: identity, honest state facts, and the two explicit
 * acts — Save (a commit) and Push. Save is the surface's one filled-green
 * go action; the commit message is edited inline, no modal. Amber never
 * appears here; red is reserved for failures and validation errors.
 */

import { useState } from "react";
import { ArrowUpTrayIcon, CheckIcon } from "@heroicons/react/16/solid";

import type { EditorRepoStatusResponse } from "@qltysh/fabro-api-client";
import { GHOST_BUTTON_CLASS, GO_BUTTON_CLASS, WELL_INPUT_CLASS } from "./ui";

export type SaveState =
  | { kind: "idle" }
  | { kind: "committing" }
  | { kind: "committed"; sha: string }
  | { kind: "failed"; message: string };

export type PushState =
  | { kind: "idle" }
  | { kind: "pushing" }
  | { kind: "pushed"; count: number }
  | { kind: "failed"; message: string };

export default function TopBar({
  repo,
  path,
  dirty,
  parseOk,
  errorCount,
  warningCount,
  validating,
  saveState,
  pushState,
  repoStatus,
  defaultCommitMessage,
  onSave,
  onPush,
  onClose,
}: {
  repo: string;
  path: string;
  dirty: boolean;
  parseOk: boolean;
  errorCount: number;
  warningCount: number;
  validating: boolean;
  saveState: SaveState;
  pushState: PushState;
  repoStatus: EditorRepoStatusResponse | undefined;
  defaultCommitMessage: string;
  onSave: (commitMessage: string) => void;
  onPush: () => void;
  onClose: () => void;
}) {
  const [message, setMessage] = useState("");
  const commitMessage = message.trim() || defaultCommitMessage;
  const blocked = !parseOk || errorCount > 0;
  const canSave = dirty && !blocked && saveState.kind !== "committing";
  const ahead = repoStatus?.ahead ?? 0;

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-1 py-1">
      <div className="min-w-0">
        <div className="truncate font-mono text-[11px] text-fac-muted" title={repo}>
          {repo}
        </div>
        <div className="truncate font-mono text-[13px] font-medium text-fac-ink" title={path}>
          {path}
        </div>
      </div>

      <div
        className="flex items-center gap-3 text-[12px]"
        role="status"
        aria-live="polite"
      >
        {dirty ? (
          <span className="text-fac-ink-2">unsaved changes</span>
        ) : saveState.kind === "committed" ? (
          <span className="text-fac-go-text">
            committed {saveState.sha.slice(0, 7)}
          </span>
        ) : null}
        {!parseOk ? (
          <span className="font-semibold text-fac-red">parse error</span>
        ) : errorCount > 0 ? (
          <span className="font-semibold text-fac-red">
            {errorCount} {errorCount === 1 ? "error" : "errors"}
          </span>
        ) : validating ? (
          <span className="text-fac-dim">validating…</span>
        ) : (
          <span className="text-fac-go-text">valid</span>
        )}
        {warningCount > 0 && parseOk && (
          <span className="text-fac-muted">
            {warningCount} {warningCount === 1 ? "warning" : "warnings"}
          </span>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2">
        {saveState.kind === "failed" && (
          <span className="max-w-72 truncate text-[12px] text-fac-red" title={saveState.message}>
            {saveState.message}
          </span>
        )}
        {pushState.kind === "failed" && (
          <span className="max-w-72 truncate text-[12px] text-fac-red" title={pushState.message}>
            {pushState.message}
          </span>
        )}
        {dirty && (
          <input
            type="text"
            aria-label="Commit message"
            placeholder={defaultCommitMessage}
            className={`${WELL_INPUT_CLASS} w-64`}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && canSave) onSave(commitMessage);
              event.stopPropagation();
            }}
          />
        )}
        <button
          type="button"
          onClick={() => onSave(commitMessage)}
          disabled={!canSave}
          title={
            blocked
              ? "Fix the errors first — saving commits to the repo"
              : "Commit the file to the repo"
          }
          className={GO_BUTTON_CLASS}
        >
          <CheckIcon className="size-4" />
          {saveState.kind === "committing" ? "Committing…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onPush}
          disabled={pushState.kind === "pushing" || (ahead === 0 && repoStatus?.has_upstream === true)}
          title={
            repoStatus?.has_upstream === false
              ? "First push publishes the branch to origin"
              : `Push ${ahead} ${ahead === 1 ? "commit" : "commits"} to origin`
          }
          className={GHOST_BUTTON_CLASS}
        >
          <ArrowUpTrayIcon className="size-3.5" />
          {pushState.kind === "pushing"
            ? "Pushing…"
            : repoStatus?.has_upstream === false
              ? "Push · publish branch"
              : `Push · ${ahead} ahead`}
        </button>
        <button type="button" onClick={onClose} className={GHOST_BUTTON_CLASS}>
          Close
        </button>
      </div>
    </header>
  );
}
