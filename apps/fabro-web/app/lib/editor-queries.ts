/**
 * Server reads and writes for the workflow editor: repo workflow discovery,
 * file open, save-as-commit, validation, repo status, push, and skills.
 */

import useSWR, { useSWRConfig, type SWRConfiguration } from "swr";
import useSWRMutation from "swr/mutation";
import type {
  EditorPushResponse,
  EditorRepoStatusResponse,
  EditorSkillListResponse,
  EditorValidateResponse,
  EditorWorkflowFileResponse,
  EditorWorkflowListResponse,
  EditorWorkflowSaveResponse,
} from "@qltysh/fabro-api-client";

import { useDebouncedValue } from "~/hooks/effects";
import { apiData, editorApi } from "./api-client";
import { queryKeys } from "./query-keys";

const immutableOptions: SWRConfiguration = {
  revalidateIfStale: false,
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
};

export function useEditorWorkflows(repo: string | null) {
  return useSWR<EditorWorkflowListResponse>(
    repo ? queryKeys.editor.workflows(repo) : null,
    () => apiData(() => editorApi.listEditorWorkflows(repo!)),
  );
}

/**
 * The opened file is read once; a running editor must never have its buffer
 * clobbered by a background revalidation. Saves refresh it explicitly.
 */
export function useEditorWorkflowFile(repo: string | null, path: string | null) {
  return useSWR<EditorWorkflowFileResponse>(
    repo && path ? queryKeys.editor.workflowFile(repo, path) : null,
    () => apiData(() => editorApi.retrieveEditorWorkflowFile(repo!, path!)),
    immutableOptions,
  );
}

export function useEditorRepoStatus(repo: string | null) {
  return useSWR<EditorRepoStatusResponse>(
    repo ? queryKeys.editor.repoStatus(repo) : null,
    () => apiData(() => editorApi.retrieveEditorRepoStatus(repo!)),
    { refreshInterval: 15_000 },
  );
}

export function useEditorSkills(repo: string | null) {
  return useSWR<EditorSkillListResponse>(
    repo ? queryKeys.editor.skills(repo) : null,
    () => apiData(() => editorApi.listEditorSkills(repo!)),
    immutableOptions,
  );
}

const VALIDATE_DEBOUNCE_MS = 400;

/**
 * Continuous validation of the source being edited: debounced, previous
 * result kept while the next one loads so the diagnostics never flicker.
 */
export function useWorkflowValidation(source: string | null) {
  const debounced = useDebouncedValue(source, VALIDATE_DEBOUNCE_MS);
  return useSWR<EditorValidateResponse>(
    debounced === null ? null : queryKeys.editor.validate(debounced),
    () =>
      apiData(() =>
        editorApi.validateEditorWorkflowSource({ source: debounced! }),
      ),
    { ...immutableOptions, keepPreviousData: true },
  );
}

export type SaveWorkflowArg = {
  fabro_source: string;
  toml_source?: string;
  base_oid?: string;
  commit_message: string;
};

export function useSaveWorkflow(repo: string | null, path: string | null) {
  const { mutate } = useSWRConfig();
  return useSWRMutation<EditorWorkflowSaveResponse, Error, string | null, SaveWorkflowArg>(
    repo && path ? `editor-save:${repo}:${path}` : null,
    async (_key, { arg }) => {
      const response = await apiData(() =>
        editorApi.saveEditorWorkflowFile({
          repo: repo!,
          path: path!,
          fabro_source: arg.fabro_source,
          toml_source: arg.toml_source ?? null,
          base_oid: arg.base_oid ?? null,
          commit_message: arg.commit_message,
        }),
      );
      await mutate(queryKeys.editor.repoStatus(repo!));
      await mutate(queryKeys.editor.workflows(repo!));
      return response;
    },
  );
}

export function usePushRepo(repo: string | null) {
  const { mutate } = useSWRConfig();
  return useSWRMutation<EditorPushResponse, Error, string | null>(
    repo ? `editor-push:${repo}` : null,
    async () => {
      const response = await apiData(() => editorApi.pushEditorRepo(repo!));
      await mutate(queryKeys.editor.repoStatus(repo!));
      return response;
    },
  );
}
