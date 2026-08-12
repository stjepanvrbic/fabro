//! Endpoint tests for the workflow editor: repo-backed listing, reading,
//! save-as-commit with conflict detection, validation, push, and skills.

#![expect(
    clippy::disallowed_methods,
    reason = "test fixtures do their git and file setup synchronously"
)]

use std::path::Path;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use tempfile::TempDir;
use tower::ServiceExt;

use crate::helpers::{api, response_json, response_status, test_app_state};

const HELLO_DOT: &str = r#"digraph Hello {
    graph [goal="Say hello"]
    rankdir=LR

    start [shape=Mdiamond, label="Start"]
    exit  [shape=Msquare, label="Exit"]

    greet [label="Greet", prompt="Say hello."]

    start -> greet -> exit
}
"#;

fn git(repo: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("git should spawn");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn write(repo: &Path, relative: &str, content: &str) {
    let path = repo.join(relative);
    std::fs::create_dir_all(path.parent().expect("file paths have parents"))
        .expect("create parent dirs");
    std::fs::write(path, content).expect("write fixture file");
}

/// A git repo that is a fabro project with one `hello` workflow, committed.
fn project_repo() -> TempDir {
    let dir = TempDir::new().expect("create temp repo");
    let repo = dir.path();
    git(repo, &["init", "-b", "main"]);
    git(repo, &["config", "user.name", "Editor Test"]);
    git(repo, &["config", "user.email", "editor@test"]);
    write(repo, ".fabro/project.toml", "_version = 1\n");
    write(repo, ".fabro/workflows/hello/workflow.fabro", HELLO_DOT);
    write(
        repo,
        ".fabro/workflows/hello/workflow.toml",
        "_version = 1\n",
    );
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-m", "init"]);
    dir
}

/// A bare remote wired as `origin` with the current branch pushed and tracked.
fn add_origin(repo: &Path) -> TempDir {
    let remote = TempDir::new().expect("create bare remote");
    git(remote.path(), &["init", "--bare", "-b", "main"]);
    git(repo, &[
        "remote",
        "add",
        "origin",
        &remote.path().display().to_string(),
    ]);
    git(repo, &["push", "-u", "origin", "main"]);
    remote
}

fn get_request(path_and_query: &str) -> Request<Body> {
    Request::builder()
        .method(Method::GET)
        .uri(api(path_and_query))
        .body(Body::empty())
        .expect("request should build")
}

fn json_request(method: Method, path_and_query: &str, body: &serde_json::Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(api(path_and_query))
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::to_string(body).expect("request body should serialize"),
        ))
        .expect("request should build")
}

fn repo_query(repo: &Path) -> String {
    format!("repo={}", repo.display())
}

#[tokio::test]
async fn list_workflows_reports_project_workflows() {
    let app = fabro_server::test_support::build_test_router(test_app_state());
    let dir = project_repo();

    let response = app
        .oneshot(get_request(&format!(
            "/editor/workflows?{}",
            repo_query(dir.path())
        )))
        .await
        .expect("GET /editor/workflows should route");
    let body = response_json(response, StatusCode::OK, "GET /api/v1/editor/workflows").await;

    let hello = body["data"]
        .as_array()
        .expect("data should be an array")
        .iter()
        .find(|entry| entry["name"] == "hello")
        .expect("hello workflow should be discovered")
        .clone();
    assert_eq!(hello["source"], "project");
    assert_eq!(hello["path"], ".fabro/workflows/hello/workflow.fabro");
    assert_eq!(hello["goal"], "Say hello");
}

#[tokio::test]
async fn list_workflows_refuses_non_project_paths() {
    let app = fabro_server::test_support::build_test_router(test_app_state());
    let dir = TempDir::new().expect("create temp dir");

    let response = app
        .clone()
        .oneshot(get_request(&format!(
            "/editor/workflows?{}",
            repo_query(dir.path())
        )))
        .await
        .expect("GET /editor/workflows should route");
    response_status(response, StatusCode::NOT_FOUND, "non-project repo").await;

    let response = app
        .oneshot(get_request("/editor/workflows?repo=relative/path"))
        .await
        .expect("GET /editor/workflows should route");
    response_status(response, StatusCode::BAD_REQUEST, "relative repo path").await;
}

#[tokio::test]
async fn get_workflow_file_returns_sources_and_base_oid() {
    let app = fabro_server::test_support::build_test_router(test_app_state());
    let dir = project_repo();

    let response = app
        .oneshot(get_request(&format!(
            "/editor/workflow?{}&path=.fabro/workflows/hello/workflow.fabro",
            repo_query(dir.path())
        )))
        .await
        .expect("GET /editor/workflow should route");
    let body = response_json(response, StatusCode::OK, "GET /api/v1/editor/workflow").await;

    assert_eq!(body["fabro_source"], HELLO_DOT);
    assert_eq!(body["toml_path"], ".fabro/workflows/hello/workflow.toml");
    assert_eq!(body["toml_source"], "_version = 1\n");
    let expected_oid = git(dir.path(), &[
        "hash-object",
        ".fabro/workflows/hello/workflow.fabro",
    ]);
    assert_eq!(body["base_oid"], expected_oid);
}

#[tokio::test]
async fn get_workflow_file_refuses_traversal() {
    let app = fabro_server::test_support::build_test_router(test_app_state());
    let dir = project_repo();

    let response = app
        .oneshot(get_request(&format!(
            "/editor/workflow?{}&path=../outside.fabro",
            repo_query(dir.path())
        )))
        .await
        .expect("GET /editor/workflow should route");
    response_status(response, StatusCode::BAD_REQUEST, "traversal path").await;
}

#[tokio::test]
async fn save_commits_exactly_the_workflow_files() {
    let app = fabro_server::test_support::build_test_router(test_app_state());
    let dir = project_repo();
    let repo = dir.path();

    // Unrelated staged work must never ride along with a save.
    write(repo, "unrelated.txt", "staged but not saved\n");
    git(repo, &["add", "unrelated.txt"]);

    let base_oid = git(repo, &[
        "hash-object",
        ".fabro/workflows/hello/workflow.fabro",
    ]);
    let new_source = HELLO_DOT.replace("Say hello.", "Say hello twice.");
    let response = app
        .oneshot(json_request(
            Method::PUT,
            "/editor/workflow",
            &serde_json::json!({
                "repo": repo.display().to_string(),
                "path": ".fabro/workflows/hello/workflow.fabro",
                "fabro_source": new_source,
                "base_oid": base_oid,
                "commit_message": "Edit hello workflow"
            }),
        ))
        .await
        .expect("PUT /editor/workflow should route");
    let body = response_json(response, StatusCode::OK, "PUT /api/v1/editor/workflow").await;

    assert_eq!(body["committed"], true);
    assert_eq!(body["commit_sha"], git(repo, &["rev-parse", "HEAD"]));
    assert_eq!(
        git(repo, &["log", "-1", "--format=%s"]),
        "Edit hello workflow"
    );
    let committed_files = git(repo, &["show", "--name-only", "--format=", "HEAD"]);
    assert_eq!(committed_files, ".fabro/workflows/hello/workflow.fabro");
    let staged = git(repo, &["diff", "--cached", "--name-only"]);
    assert_eq!(
        staged, "unrelated.txt",
        "unrelated staged work must survive"
    );
    assert_eq!(
        std::fs::read_to_string(repo.join(".fabro/workflows/hello/workflow.fabro"))
            .expect("saved file should read"),
        new_source
    );
}

#[tokio::test]
async fn save_with_stale_base_refuses() {
    let app = fabro_server::test_support::build_test_router(test_app_state());
    let dir = project_repo();
    let repo = dir.path();

    let base_oid = git(repo, &[
        "hash-object",
        ".fabro/workflows/hello/workflow.fabro",
    ]);
    let on_disk = HELLO_DOT.replace("Say hello.", "Changed behind the editor's back.");
    write(repo, ".fabro/workflows/hello/workflow.fabro", &on_disk);

    let response = app
        .oneshot(json_request(
            Method::PUT,
            "/editor/workflow",
            &serde_json::json!({
                "repo": repo.display().to_string(),
                "path": ".fabro/workflows/hello/workflow.fabro",
                "fabro_source": HELLO_DOT,
                "base_oid": base_oid,
                "commit_message": "Edit hello workflow"
            }),
        ))
        .await
        .expect("PUT /editor/workflow should route");
    response_status(response, StatusCode::CONFLICT, "stale base oid").await;

    assert_eq!(
        std::fs::read_to_string(repo.join(".fabro/workflows/hello/workflow.fabro"))
            .expect("file should read"),
        on_disk,
        "a refused save must not touch the file"
    );
}

#[tokio::test]
async fn save_creates_a_new_workflow_with_its_toml() {
    let app = fabro_server::test_support::build_test_router(test_app_state());
    let dir = project_repo();
    let repo = dir.path();

    let response = app
        .clone()
        .oneshot(json_request(
            Method::PUT,
            "/editor/workflow",
            &serde_json::json!({
                "repo": repo.display().to_string(),
                "path": ".fabro/workflows/fresh/workflow.fabro",
                "fabro_source": HELLO_DOT,
                "toml_source": "_version = 1\n",
                "commit_message": "Add fresh workflow"
            }),
        ))
        .await
        .expect("PUT /editor/workflow should route");
    let body = response_json(response, StatusCode::OK, "PUT /api/v1/editor/workflow").await;
    assert_eq!(body["committed"], true);

    let committed_files = git(repo, &["show", "--name-only", "--format=", "HEAD"]);
    assert_eq!(
        committed_files,
        ".fabro/workflows/fresh/workflow.fabro\n.fabro/workflows/fresh/workflow.toml"
    );

    let response = app
        .oneshot(get_request(&format!(
            "/editor/workflows?{}",
            repo_query(repo)
        )))
        .await
        .expect("GET /editor/workflows should route");
    let body = response_json(response, StatusCode::OK, "GET /api/v1/editor/workflows").await;
    assert!(
        body["data"]
            .as_array()
            .expect("data should be an array")
            .iter()
            .any(|entry| entry["name"] == "fresh"),
        "the new workflow should be discoverable"
    );
}

#[tokio::test]
async fn save_of_identical_content_creates_no_commit() {
    let app = fabro_server::test_support::build_test_router(test_app_state());
    let dir = project_repo();
    let repo = dir.path();

    let head_before = git(repo, &["rev-parse", "HEAD"]);
    let base_oid = git(repo, &[
        "hash-object",
        ".fabro/workflows/hello/workflow.fabro",
    ]);
    let response = app
        .oneshot(json_request(
            Method::PUT,
            "/editor/workflow",
            &serde_json::json!({
                "repo": repo.display().to_string(),
                "path": ".fabro/workflows/hello/workflow.fabro",
                "fabro_source": HELLO_DOT,
                "base_oid": base_oid,
                "commit_message": "No-op save"
            }),
        ))
        .await
        .expect("PUT /editor/workflow should route");
    let body = response_json(response, StatusCode::OK, "PUT /api/v1/editor/workflow").await;

    assert_eq!(body["committed"], false);
    assert_eq!(body["commit_sha"], head_before);
    assert_eq!(git(repo, &["rev-parse", "HEAD"]), head_before);
}

#[tokio::test]
async fn validate_reports_a_parse_failure_as_a_diagnostic() {
    let app = fabro_server::test_support::build_test_router(test_app_state());

    let response = app
        .oneshot(json_request(
            Method::POST,
            "/editor/workflow/validate",
            &serde_json::json!({ "source": "digraph Broken {" }),
        ))
        .await
        .expect("POST /editor/workflow/validate should route");
    let body = response_json(
        response,
        StatusCode::OK,
        "POST /api/v1/editor/workflow/validate",
    )
    .await;

    let diagnostics = body["diagnostics"].as_array().expect("diagnostics array");
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0]["rule"], "parse");
    assert_eq!(diagnostics[0]["severity"], "error");
}

#[tokio::test]
async fn validate_runs_the_lint_rules() {
    let app = fabro_server::test_support::build_test_router(test_app_state());

    let source = r#"digraph T {
        graph [goal="g"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        orphan [label="Orphan", prompt="unreachable"]
        start -> exit
    }"#;
    let response = app
        .oneshot(json_request(
            Method::POST,
            "/editor/workflow/validate",
            &serde_json::json!({ "source": source }),
        ))
        .await
        .expect("POST /editor/workflow/validate should route");
    let body = response_json(
        response,
        StatusCode::OK,
        "POST /api/v1/editor/workflow/validate",
    )
    .await;

    let reachability = body["diagnostics"]
        .as_array()
        .expect("diagnostics array")
        .iter()
        .find(|diagnostic| diagnostic["rule"] == "reachability")
        .expect("reachability diagnostic should be present")
        .clone();
    assert_eq!(reachability["severity"], "warning");
    assert_eq!(reachability["node_id"], "orphan");
}

#[tokio::test]
async fn repo_status_counts_commits_ahead_of_upstream() {
    let app = fabro_server::test_support::build_test_router(test_app_state());
    let dir = project_repo();
    let repo = dir.path();
    let _remote = add_origin(repo);

    write(
        repo,
        ".fabro/workflows/hello/workflow.fabro",
        "digraph H {}\n",
    );
    git(repo, &["commit", "-am", "ahead"]);

    let response = app
        .oneshot(get_request(&format!(
            "/editor/repo/status?{}",
            repo_query(repo)
        )))
        .await
        .expect("GET /editor/repo/status should route");
    let body = response_json(response, StatusCode::OK, "GET /api/v1/editor/repo/status").await;

    assert_eq!(body["branch"], "main");
    assert_eq!(body["ahead"], 1);
    assert_eq!(body["behind"], 0);
    assert_eq!(body["has_upstream"], true);
}

#[tokio::test]
async fn push_sends_the_current_branch() {
    let app = fabro_server::test_support::build_test_router(test_app_state());
    let dir = project_repo();
    let repo = dir.path();
    let remote = add_origin(repo);

    write(
        repo,
        ".fabro/workflows/hello/workflow.fabro",
        "digraph H {}\n",
    );
    git(repo, &["commit", "-am", "ahead"]);

    let response = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(api(&format!("/editor/repo/push?{}", repo_query(repo))))
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("POST /editor/repo/push should route");
    let body = response_json(response, StatusCode::OK, "POST /api/v1/editor/repo/push").await;

    assert_eq!(body["branch"], "main");
    assert_eq!(body["pushed_commits"], 1);
    assert_eq!(
        git(remote.path(), &["rev-parse", "main"]),
        git(repo, &["rev-parse", "HEAD"]),
        "the remote should have the pushed commit"
    );
}

#[tokio::test]
async fn push_without_origin_refuses() {
    let app = fabro_server::test_support::build_test_router(test_app_state());
    let dir = project_repo();

    let response = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(api(&format!(
                    "/editor/repo/push?{}",
                    repo_query(dir.path())
                )))
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("POST /editor/repo/push should route");
    response_status(response, StatusCode::CONFLICT, "push without origin").await;
}

#[tokio::test]
async fn skills_discovery_shadows_user_roots_with_repo_roots() {
    let app = fabro_server::test_support::build_test_router(test_app_state());
    let dir = project_repo();
    let repo = dir.path();

    write(
        repo,
        "skills/greet/SKILL.md",
        "---\nname: greet\ndescription: from repo skills\n---\nbody\n",
    );
    write(
        repo,
        ".fabro/skills/greet/SKILL.md",
        "---\nname: greet\ndescription: from fabro skills\n---\nbody\n",
    );
    write(
        repo,
        ".claude/skills/review/SKILL.md",
        "---\nname: review\ndescription: reviews changes\n---\nbody\n",
    );

    let response = app
        .oneshot(get_request(&format!("/editor/skills?{}", repo_query(repo))))
        .await
        .expect("GET /editor/skills should route");
    let body = response_json(response, StatusCode::OK, "GET /api/v1/editor/skills").await;

    let skills = body["data"].as_array().expect("data should be an array");
    let greet = skills
        .iter()
        .find(|skill| skill["name"] == "greet")
        .expect("greet skill should be discovered");
    assert_eq!(
        greet["description"], "from fabro skills",
        "the most repo-specific root wins a name collision"
    );
    assert!(
        skills.iter().any(|skill| skill["name"] == "review"),
        "repo .claude skills should be discovered"
    );
}
