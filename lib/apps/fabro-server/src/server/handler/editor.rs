//! Repo-backed workflow file editing for the workflow editor.
//!
//! All operations target a repo on the server host, named by an absolute
//! `repo` path that must contain `.fabro/project.toml`. Saving writes the
//! workflow file(s), stages exactly those paths, and creates one commit;
//! pushing is a separate explicit operation. Conflict detection is a
//! compare-and-swap on the git blob oid of the graph file.

use std::collections::BTreeMap;
use std::path::{Component, Path as FsPath, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use axum::extract::Query;
use fabro_agent::skills;
use fabro_config::project::{WorkflowLocation, WorkflowSource, list_workflows_detailed};
use fabro_graphviz::parser;
use fabro_store::KeyedMutex;
use fabro_validate::Severity;
use serde::Deserialize;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::{fs, task, time};

use super::super::{
    ApiError, AppState, EditorDiagnostic, EditorDiagnosticSeverity, EditorPushResponse,
    EditorRepoStatusResponse, EditorSkill, EditorSkillListResponse, EditorValidateRequest,
    EditorValidateResponse, EditorWorkflowFileResponse, EditorWorkflowListResponse,
    EditorWorkflowSaveRequest, EditorWorkflowSaveResponse, EditorWorkflowSummary,
    EditorWorkflowSummarySource, IntoResponse, Json, RequiredUser, Response, Router, State,
    StatusCode, get, post,
};

const GIT_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_PUSH_TIMEOUT: Duration = Duration::from_mins(1);

/// Serializes saves per repo so the read-hash/write/commit sequence cannot
/// interleave with another save against the same repo.
static SAVE_LOCKS: LazyLock<KeyedMutex<PathBuf>> = LazyLock::new(KeyedMutex::new);

pub(super) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/editor/workflows", get(list_workflows))
        .route(
            "/editor/workflow",
            get(get_workflow_file).put(save_workflow_file),
        )
        .route("/editor/workflow/validate", post(validate_source))
        .route("/editor/repo/status", get(repo_status))
        .route("/editor/repo/push", post(push_repo))
        .route("/editor/skills", get(list_skills))
}

#[derive(Deserialize)]
struct RepoQuery {
    repo: String,
}

#[derive(Deserialize)]
struct RepoFileQuery {
    repo: String,
    path: String,
}

/// Resolve and authorize the target repo: absolute, existing, and a fabro
/// project. This is the trust boundary for every editor operation.
async fn resolve_repo(repo: &str) -> Result<PathBuf, ApiError> {
    let path = PathBuf::from(repo);
    if !path.is_absolute() {
        return Err(ApiError::bad_request("repo must be an absolute path"));
    }
    let canonical = fs::canonicalize(&path)
        .await
        .map_err(|_| ApiError::bad_request(format!("repo path does not exist: {repo}")))?;
    let marker = canonical.join(".fabro").join("project.toml");
    if !fs::try_exists(&marker).await.unwrap_or(false) {
        return Err(ApiError::not_found(
            "not a fabro project: missing .fabro/project.toml",
        ));
    }
    Ok(canonical)
}

/// Validate a repo-relative file path: relative, and no parent traversal.
fn resolve_repo_file(repo: &FsPath, relative: &str) -> Result<PathBuf, ApiError> {
    let rel = FsPath::new(relative);
    if rel.is_absolute() {
        return Err(ApiError::bad_request("path must be repo-relative"));
    }
    for component in rel.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            _ => {
                return Err(ApiError::bad_request(
                    "path may not traverse outside the repo",
                ));
            }
        }
    }
    Ok(repo.join(rel))
}

struct GitFailure {
    stderr: String,
}

async fn run_git(repo: &FsPath, args: &[&str], timeout: Duration) -> Result<String, GitFailure> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = time::timeout(timeout, command.output())
        .await
        .map_err(|_| GitFailure {
            stderr: format!("git {} timed out", args.first().unwrap_or(&"")),
        })?
        .map_err(|err| GitFailure {
            stderr: format!("failed to spawn git: {err}"),
        })?;
    if !output.status.success() {
        return Err(GitFailure {
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Git blob oid of the given content, computed without touching the index.
async fn blob_oid(repo: &FsPath, content: &str) -> Result<String, GitFailure> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repo)
        .args(["hash-object", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|err| GitFailure {
        stderr: format!("failed to spawn git: {err}"),
    })?;
    let mut stdin = child.stdin.take().expect("stdin was piped");
    stdin
        .write_all(content.as_bytes())
        .await
        .map_err(|err| GitFailure {
            stderr: format!("failed to write to git hash-object: {err}"),
        })?;
    drop(stdin);
    let output = time::timeout(GIT_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| GitFailure {
            stderr: "git hash-object timed out".to_string(),
        })?
        .map_err(|err| GitFailure {
            stderr: format!("git hash-object failed: {err}"),
        })?;
    if !output.status.success() {
        return Err(GitFailure {
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// The graph file's own `goal` attribute, used when workflow.toml has none.
#[expect(
    clippy::disallowed_methods,
    reason = "workflow discovery does its sync file I/O inside spawn_blocking"
)]
fn graph_goal(graph: &FsPath) -> Option<String> {
    let source = std::fs::read_to_string(graph).ok()?;
    let parsed = parser::parse(&source).ok()?;
    let goal = parsed.goal();
    if goal.is_empty() {
        None
    } else {
        Some(goal.to_string())
    }
}

fn git_error(context: &str, failure: &GitFailure) -> ApiError {
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("{context}: {}", failure.stderr),
    )
}

async fn list_workflows(
    _auth: RequiredUser,
    State(_state): State<Arc<AppState>>,
    Query(query): Query<RepoQuery>,
) -> Response {
    let repo = match resolve_repo(&query.repo).await {
        Ok(repo) => repo,
        Err(err) => return err.into_response(),
    };
    let summaries = task::spawn_blocking(move || {
        let project_dir = repo.join(".fabro").join("workflows");
        let user_dir = fabro_util::Home::from_env().workflows_dir();
        let infos = list_workflows_detailed(Some(&project_dir), Some(&user_dir));
        infos
            .into_iter()
            .map(|info| {
                let (source, workflows_dir) = match info.source {
                    WorkflowSource::Project => (EditorWorkflowSummarySource::Project, &project_dir),
                    WorkflowSource::User => (EditorWorkflowSummarySource::User, &user_dir),
                };
                // The toml's `[workflow].graph` names the real graph file.
                let toml = workflows_dir.join(&info.name).join("workflow.toml");
                let graph = WorkflowLocation::resolve(&toml, &repo)
                    .map_or_else(|_| toml.with_file_name("workflow.fabro"), |loc| loc.graph);
                let goal = info.goal.or_else(|| graph_goal(&graph));
                let path = match source {
                    EditorWorkflowSummarySource::Project => graph
                        .strip_prefix(&repo)
                        .unwrap_or(&graph)
                        .display()
                        .to_string(),
                    EditorWorkflowSummarySource::User => graph.display().to_string(),
                };
                EditorWorkflowSummary {
                    name: info.name,
                    goal,
                    source,
                    path,
                }
            })
            .collect::<Vec<_>>()
    })
    .await;
    match summaries {
        Ok(data) => (StatusCode::OK, Json(EditorWorkflowListResponse { data })).into_response(),
        Err(err) => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("workflow discovery failed: {err}"),
        )
        .into_response(),
    }
}

async fn get_workflow_file(
    _auth: RequiredUser,
    State(_state): State<Arc<AppState>>,
    Query(query): Query<RepoFileQuery>,
) -> Response {
    let repo = match resolve_repo(&query.repo).await {
        Ok(repo) => repo,
        Err(err) => return err.into_response(),
    };
    let file = match resolve_repo_file(&repo, &query.path) {
        Ok(file) => file,
        Err(err) => return err.into_response(),
    };
    let fabro_source = match fs::read_to_string(&file).await {
        Ok(source) => source,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return ApiError::not_found(format!("file not found: {}", query.path)).into_response();
        }
        Err(err) => {
            return ApiError::bad_request(format!("cannot read {}: {err}", query.path))
                .into_response();
        }
    };
    let base_oid = match blob_oid(&repo, &fabro_source).await {
        Ok(oid) => oid,
        Err(failure) => return git_error("hashing failed", &failure).into_response(),
    };
    let toml_file = file.with_file_name("workflow.toml");
    let (toml_path, toml_source) = match fs::read_to_string(&toml_file).await {
        Ok(source) => {
            let rel = toml_file.strip_prefix(&repo).map_or_else(
                |_| toml_file.display().to_string(),
                |p| p.display().to_string(),
            );
            (Some(rel), Some(source))
        }
        Err(_) => (None, None),
    };
    (
        StatusCode::OK,
        Json(EditorWorkflowFileResponse {
            path: query.path,
            fabro_source,
            toml_path,
            toml_source,
            base_oid,
        }),
    )
        .into_response()
}

async fn save_workflow_file(
    _auth: RequiredUser,
    State(_state): State<Arc<AppState>>,
    Json(body): Json<EditorWorkflowSaveRequest>,
) -> Response {
    let repo = match resolve_repo(&body.repo).await {
        Ok(repo) => repo,
        Err(err) => return err.into_response(),
    };
    let file = match resolve_repo_file(&repo, &body.path) {
        Ok(file) => file,
        Err(err) => return err.into_response(),
    };
    if body.commit_message.trim().is_empty() {
        return ApiError::bad_request("commit_message must not be empty").into_response();
    }

    let _guard = SAVE_LOCKS.lock(repo.clone()).await;

    let on_disk = match fs::read_to_string(&file).await {
        Ok(content) => Some(content),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => {
            return ApiError::bad_request(format!("cannot read {}: {err}", body.path))
                .into_response();
        }
    };

    match (&on_disk, &body.base_oid) {
        (Some(content), Some(base)) => {
            let current = match blob_oid(&repo, content).await {
                Ok(oid) => oid,
                Err(failure) => return git_error("hashing failed", &failure).into_response(),
            };
            if &current != base {
                return ApiError::new(
                    StatusCode::CONFLICT,
                    format!("{} changed on disk since it was read", body.path),
                )
                .into_response();
            }
        }
        (Some(_), None) => {
            return ApiError::new(
                StatusCode::CONFLICT,
                format!("{} already exists; read it before saving", body.path),
            )
            .into_response();
        }
        (None, Some(_)) => {
            return ApiError::new(
                StatusCode::CONFLICT,
                format!("{} was deleted on disk since it was read", body.path),
            )
            .into_response();
        }
        (None, None) => {}
    }

    let toml_file = file.with_file_name("workflow.toml");
    let toml_unchanged = match &body.toml_source {
        None => true,
        Some(toml) => fs::read_to_string(&toml_file)
            .await
            .is_ok_and(|current| &current == toml),
    };
    if on_disk.as_deref() == Some(body.fabro_source.as_str()) && toml_unchanged {
        let head = match run_git(&repo, &["rev-parse", "HEAD"], GIT_TIMEOUT).await {
            Ok(sha) => sha,
            Err(failure) => return git_error("git rev-parse failed", &failure).into_response(),
        };
        let base_oid = body.base_oid.unwrap_or_default();
        return (
            StatusCode::OK,
            Json(EditorWorkflowSaveResponse {
                committed: false,
                commit_sha: head,
                base_oid,
            }),
        )
            .into_response();
    }

    if let Some(parent) = file.parent() {
        if let Err(err) = fs::create_dir_all(parent).await {
            return ApiError::bad_request(format!("cannot create {}: {err}", body.path))
                .into_response();
        }
    }
    if let Err(err) = fs::write(&file, &body.fabro_source).await {
        return ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("cannot write {}: {err}", body.path),
        )
        .into_response();
    }
    let mut staged = vec![body.path.clone()];
    if let Some(toml) = &body.toml_source {
        if let Err(err) = fs::write(&toml_file, toml).await {
            return ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("cannot write workflow.toml: {err}"),
            )
            .into_response();
        }
        let rel = toml_file.strip_prefix(&repo).map_or_else(
            |_| toml_file.display().to_string(),
            |p| p.display().to_string(),
        );
        staged.push(rel);
    }

    let mut add_args = vec!["add", "--"];
    add_args.extend(staged.iter().map(String::as_str));
    if let Err(failure) = run_git(&repo, &add_args, GIT_TIMEOUT).await {
        return git_error("file written but git add failed", &failure).into_response();
    }
    // Pathspec commit: records exactly the saved files, so unrelated changes
    // the operator has staged never ride along.
    let mut commit_args = vec!["commit", "-m", body.commit_message.as_str(), "--"];
    commit_args.extend(staged.iter().map(String::as_str));
    if let Err(failure) = run_git(&repo, &commit_args, GIT_TIMEOUT).await {
        return git_error("file written but git commit failed", &failure).into_response();
    }
    let commit_sha = match run_git(&repo, &["rev-parse", "HEAD"], GIT_TIMEOUT).await {
        Ok(sha) => sha,
        Err(failure) => return git_error("git rev-parse failed", &failure).into_response(),
    };
    let base_oid = match blob_oid(&repo, &body.fabro_source).await {
        Ok(oid) => oid,
        Err(failure) => return git_error("hashing failed", &failure).into_response(),
    };
    (
        StatusCode::OK,
        Json(EditorWorkflowSaveResponse {
            committed: true,
            commit_sha,
            base_oid,
        }),
    )
        .into_response()
}

async fn validate_source(
    _auth: RequiredUser,
    State(_state): State<Arc<AppState>>,
    Json(body): Json<EditorValidateRequest>,
) -> Response {
    let diagnostics = match parser::parse(&body.source) {
        Err(err) => vec![EditorDiagnostic {
            rule:      "parse".to_string(),
            severity:  EditorDiagnosticSeverity::Error,
            message:   err.to_string(),
            node_id:   None,
            edge_from: None,
            edge_to:   None,
            line:      None,
            column:    None,
        }],
        Ok(graph) => fabro_validate::validate(&graph, &[])
            .into_iter()
            .map(|diagnostic| {
                let (edge_from, edge_to) = match diagnostic.edge {
                    Some((from, to)) => (Some(from), Some(to)),
                    None => (None, None),
                };
                EditorDiagnostic {
                    rule: diagnostic.rule,
                    severity: match diagnostic.severity {
                        Severity::Error => EditorDiagnosticSeverity::Error,
                        Severity::Warning => EditorDiagnosticSeverity::Warning,
                        Severity::Info => EditorDiagnosticSeverity::Info,
                    },
                    message: diagnostic.message,
                    node_id: diagnostic.node_id,
                    edge_from,
                    edge_to,
                    line: diagnostic.line.map(i64::from),
                    column: diagnostic.column.map(i64::from),
                }
            })
            .collect(),
    };
    (StatusCode::OK, Json(EditorValidateResponse { diagnostics })).into_response()
}

/// Branch name, or `None` when HEAD is detached.
async fn current_branch(repo: &FsPath) -> Option<String> {
    run_git(
        repo,
        &["symbolic-ref", "--short", "-q", "HEAD"],
        GIT_TIMEOUT,
    )
    .await
    .ok()
    .filter(|branch| !branch.is_empty())
}

/// `(ahead, behind)` relative to the upstream, or `None` without an upstream.
async fn upstream_counts(repo: &FsPath) -> Option<(i64, i64)> {
    let counts = run_git(
        repo,
        &["rev-list", "--count", "--left-right", "@{upstream}...HEAD"],
        GIT_TIMEOUT,
    )
    .await
    .ok()?;
    let (behind, ahead) = counts.split_once('\t')?;
    Some((ahead.trim().parse().ok()?, behind.trim().parse().ok()?))
}

async fn repo_status(
    _auth: RequiredUser,
    State(_state): State<Arc<AppState>>,
    Query(query): Query<RepoQuery>,
) -> Response {
    let repo = match resolve_repo(&query.repo).await {
        Ok(repo) => repo,
        Err(err) => return err.into_response(),
    };
    let branch = current_branch(&repo).await;
    let counts = upstream_counts(&repo).await;
    let (ahead, behind) = counts.unwrap_or((0, 0));
    (
        StatusCode::OK,
        Json(EditorRepoStatusResponse {
            branch,
            ahead,
            behind,
            has_upstream: counts.is_some(),
        }),
    )
        .into_response()
}

async fn push_repo(
    _auth: RequiredUser,
    State(_state): State<Arc<AppState>>,
    Query(query): Query<RepoQuery>,
) -> Response {
    let repo = match resolve_repo(&query.repo).await {
        Ok(repo) => repo,
        Err(err) => return err.into_response(),
    };
    let Some(branch) = current_branch(&repo).await else {
        return ApiError::new(StatusCode::CONFLICT, "HEAD is detached; nothing to push")
            .into_response();
    };
    if run_git(&repo, &["remote", "get-url", "origin"], GIT_TIMEOUT)
        .await
        .is_err()
    {
        return ApiError::new(StatusCode::CONFLICT, "the repo has no origin remote")
            .into_response();
    }
    let counts = upstream_counts(&repo).await;
    let pushed_commits = counts.map_or(0, |(ahead, _)| ahead);
    let push_result = match counts {
        Some(_) => run_git(&repo, &["push", "origin", &branch], GIT_PUSH_TIMEOUT).await,
        None => run_git(&repo, &["push", "-u", "origin", &branch], GIT_PUSH_TIMEOUT).await,
    };
    if let Err(failure) = push_result {
        return ApiError::new(
            StatusCode::CONFLICT,
            format!("push rejected: {}", failure.stderr),
        )
        .into_response();
    }
    (
        StatusCode::OK,
        Json(EditorPushResponse {
            branch,
            pushed_commits,
        }),
    )
        .into_response()
}

/// Skill roots in precedence order: a later root wins a name collision, so
/// repo-local skills shadow user-global ones.
fn skill_roots(repo: &FsPath) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".claude").join("skills"));
        roots.push(home.join(".agents").join("skills"));
    }
    roots.push(repo.join("skills"));
    roots.push(repo.join(".claude").join("skills"));
    roots.push(repo.join(".fabro").join("skills"));
    roots
}

#[expect(
    clippy::disallowed_methods,
    reason = "skill discovery does its sync directory I/O inside spawn_blocking"
)]
async fn list_skills(
    _auth: RequiredUser,
    State(_state): State<Arc<AppState>>,
    Query(query): Query<RepoQuery>,
) -> Response {
    let repo = match resolve_repo(&query.repo).await {
        Ok(repo) => repo,
        Err(err) => return err.into_response(),
    };
    let skills = task::spawn_blocking(move || {
        let mut by_name: BTreeMap<String, EditorSkill> = BTreeMap::new();
        for root in skill_roots(&repo) {
            let Ok(entries) = std::fs::read_dir(&root) else {
                continue;
            };
            for entry in entries.flatten() {
                let skill_file = entry.path().join("SKILL.md");
                let Ok(content) = std::fs::read_to_string(&skill_file) else {
                    continue;
                };
                if let Ok(skill) = skills::parse_skill(&content) {
                    by_name.insert(skill.name.clone(), EditorSkill {
                        name:        skill.name,
                        description: skill.description,
                        source:      root.display().to_string(),
                    });
                }
            }
        }
        by_name.into_values().collect::<Vec<_>>()
    })
    .await;
    match skills {
        Ok(data) => (StatusCode::OK, Json(EditorSkillListResponse { data })).into_response(),
        Err(err) => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("skill discovery failed: {err}"),
        )
        .into_response(),
    }
}
