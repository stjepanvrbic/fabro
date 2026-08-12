/**
 * The workflow editor route. URL search params own the navigation state:
 * `repo` names the target repo, `path` the workflow file, `new=1` a blank
 * workflow that does not exist on disk yet.
 */

import { useSearchParams } from "react-router";

import Browser, { rememberRepo } from "~/components/editor/browser";
import Editor from "~/components/editor/editor";
import {
  createEmptyGraph,
  isValidNodeId,
} from "~/components/editor/model/graph";
import { serializeWorkflow } from "~/components/editor/model/serialize";
import { LoadingState } from "~/components/state";
import { ApiError } from "~/lib/api-client";
import { useEditorSkills, useEditorWorkflowFile } from "~/lib/editor-queries";

export const handle = { hideHeader: true, fullHeight: true, wide: true };

export function meta() {
  return [{ title: "Editor · Fabro" }];
}

export default function EditorRoute() {
  const [searchParams, setSearchParams] = useSearchParams();
  const repo = searchParams.get("repo");
  const path = searchParams.get("path");
  const isNew = searchParams.get("new") === "1";

  const file = useEditorWorkflowFile(repo, isNew ? null : path);
  const skills = useEditorSkills(repo);

  const setParams = (
    next: { repo?: string | null; path?: string | null; new?: boolean },
  ) => {
    const params = new URLSearchParams();
    const nextRepo = next.repo === undefined ? repo : next.repo;
    const nextPath = next.path === undefined ? path : next.path;
    if (nextRepo) params.set("repo", nextRepo);
    if (nextPath) params.set("path", nextPath);
    if (next.new) params.set("new", "1");
    setSearchParams(params);
  };

  if (!repo || !path) {
    return (
      <div className="fac-ground -mx-4 -my-6 h-[calc(100%+3rem)] overflow-auto font-[family-name:var(--font-poppins)] text-fac-ink sm:-mx-6 lg:-mx-8">
        <Browser
          repo={repo}
          onRepoChange={(nextRepo) => {
            if (nextRepo) rememberRepo(nextRepo);
            setParams({ repo: nextRepo, path: null });
          }}
          onOpen={(nextPath) => setParams({ path: nextPath })}
          onCreate={(name) => {
            if (!isValidNodeId(name)) return;
            setParams({
              path: `.fabro/workflows/${name}/workflow.fabro`,
              new: true,
            });
          }}
        />
      </div>
    );
  }

  const editorShell = (body: React.ReactNode) => (
    <div className="fac-ground -mx-4 -my-6 h-[calc(100%+3rem)] font-[family-name:var(--font-poppins)] text-fac-ink sm:-mx-6 lg:-mx-8">
      {body}
    </div>
  );

  if (isNew) {
    const name = path.split("/").at(-2) ?? "untitled";
    const source = serializeWorkflow(createEmptyGraph(name));
    return editorShell(
      <Editor
        key={`${repo}:${path}:new`}
        repo={repo}
        path={path}
        file={{
          path,
          fabro_source: source,
          toml_path: null,
          toml_source: null,
          base_oid: "",
        }}
        skills={skills.data?.data ?? []}
        onClose={() => setParams({ path: null })}
      />,
    );
  }

  if (file.error) {
    const message =
      file.error instanceof ApiError
        ? file.error.message
        : "The file could not be read.";
    return editorShell(
      <div className="flex h-full items-center justify-center p-6">
        <div className="fac-card max-w-md space-y-3 p-5 text-center">
          <p className="text-[13px] text-fac-red">{message}</p>
          <button
            type="button"
            onClick={() => setParams({ path: null })}
            className="text-[12.5px] text-fac-ink-2 underline underline-offset-4 hover:text-fac-ink"
          >
            Back to the workflow list
          </button>
        </div>
      </div>,
    );
  }

  if (!file.data) {
    return editorShell(<LoadingState label="Reading the workflow…" />);
  }

  return editorShell(
    <Editor
      key={`${repo}:${path}:${file.data.base_oid}`}
      repo={repo}
      path={path}
      file={file.data}
      skills={skills.data?.data ?? []}
      onClose={() => setParams({ path: null })}
    />,
  );
}
