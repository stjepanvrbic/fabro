/**
 * The editor's entry surface: name a repo (recents remembered locally),
 * pick a discovered workflow, open any workflow file by path, or start a
 * new workflow from a blank start-to-exit skeleton.
 */

import { useState } from "react";
import { DocumentPlusIcon, FolderOpenIcon } from "@heroicons/react/24/outline";

import { ApiError } from "~/lib/api-client";
import { useEditorWorkflows } from "~/lib/editor-queries";
import { isValidNodeId } from "./model/graph";
import { FIELD_LABEL_CLASS, GHOST_BUTTON_CLASS, GO_BUTTON_CLASS, WELL_INPUT_CLASS } from "./ui";

const RECENT_REPOS_KEY = "fabro:editor:recent-repos:v1";
const RECENT_LIMIT = 6;

export function recentRepos(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_REPOS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export function rememberRepo(repo: string): void {
  try {
    const next = [repo, ...recentRepos().filter((entry) => entry !== repo)];
    window.localStorage.setItem(
      RECENT_REPOS_KEY,
      JSON.stringify(next.slice(0, RECENT_LIMIT)),
    );
  } catch {
    // Recents are a convenience; a full or blocked storage loses nothing real.
  }
}

export default function Browser({
  repo,
  onRepoChange,
  onOpen,
  onCreate,
}: {
  repo: string | null;
  onRepoChange: (repo: string | null) => void;
  onOpen: (path: string) => void;
  onCreate: (name: string) => void;
}) {
  const [repoInput, setRepoInput] = useState(repo ?? "");
  const [pathInput, setPathInput] = useState("");
  const [newName, setNewName] = useState("");
  const workflows = useEditorWorkflows(repo);
  const recents = recentRepos().filter((entry) => entry !== repo);

  const repoError =
    workflows.error instanceof ApiError ? workflows.error.message : null;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="space-y-2">
        <div className={FIELD_LABEL_CLASS}>target repo</div>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = repoInput.trim();
            onRepoChange(value.length > 0 ? value : null);
          }}
        >
          <input
            type="text"
            aria-label="Repo path"
            placeholder="/absolute/path/to/repo"
            className={`${WELL_INPUT_CLASS} font-mono`}
            value={repoInput}
            onChange={(event) => setRepoInput(event.target.value)}
          />
          <button type="submit" className={GHOST_BUTTON_CLASS}>
            <FolderOpenIcon className="size-4" />
            Open repo
          </button>
        </form>
        {recents.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11.5px] text-fac-dim">recent:</span>
            {recents.map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => {
                  setRepoInput(entry);
                  onRepoChange(entry);
                }}
                className="rounded-full bg-fac-hover px-2.5 py-1 font-mono text-[11px] text-fac-ink-2 transition-colors hover:bg-fac-line-strong hover:text-fac-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fac-ink/60"
              >
                {entry}
              </button>
            ))}
          </div>
        )}
        {repoError && (
          <p className="text-[12.5px] text-fac-red">{repoError}</p>
        )}
      </div>

      {repo && !repoError && (
        <>
          <div className="space-y-2">
            <div className={FIELD_LABEL_CLASS}>workflows</div>
            {workflows.isLoading && (
              <p className="text-[13px] text-fac-dim">Reading the repo…</p>
            )}
            {workflows.data && workflows.data.data.length === 0 && (
              <p className="text-[13px] leading-relaxed text-fac-muted">
                No workflows discovered — discovery lists{" "}
                <span className="font-mono text-[12px]">
                  .fabro/workflows/&lt;name&gt;/
                </span>{" "}
                directories with a workflow.toml. Start one below, or open a
                file by path.
              </p>
            )}
            <ul className="space-y-1.5">
              {workflows.data?.data.map((workflow) => (
                <li key={`${workflow.source}:${workflow.name}`}>
                  <button
                    type="button"
                    onClick={() => onOpen(workflow.path)}
                    className="fac-card block w-full px-4 py-3 text-left transition-colors hover:border-fac-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fac-ink/60"
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="font-mono text-[13px] font-medium text-fac-ink">
                        {workflow.name}
                      </span>
                      <span className="text-[10.5px] uppercase tracking-wider text-fac-dim">
                        {workflow.source}
                      </span>
                    </span>
                    {workflow.goal && (
                      <span className="mt-0.5 block truncate text-[12.5px] text-fac-muted">
                        {workflow.goal}
                      </span>
                    )}
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-fac-dim">
                      {workflow.path}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (pathInput.trim()) onOpen(pathInput.trim());
              }}
            >
              <div className={FIELD_LABEL_CLASS}>open any workflow file</div>
              <input
                type="text"
                aria-label="Workflow file path"
                placeholder=".fabro/workflows/name/workflow.fabro"
                className={`${WELL_INPUT_CLASS} font-mono`}
                value={pathInput}
                onChange={(event) => setPathInput(event.target.value)}
              />
              <button
                type="submit"
                disabled={pathInput.trim().length === 0}
                className={GHOST_BUTTON_CLASS}
              >
                Open file
              </button>
            </form>

            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (isValidNodeId(newName)) onCreate(newName);
              }}
            >
              <div className={FIELD_LABEL_CLASS}>new workflow</div>
              <input
                type="text"
                aria-label="New workflow name"
                placeholder="snake_case_name"
                className={`${WELL_INPUT_CLASS} font-mono`}
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
              />
              <button
                type="submit"
                disabled={!isValidNodeId(newName)}
                className={GO_BUTTON_CLASS}
              >
                <DocumentPlusIcon className="size-4" />
                Start from blank
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
