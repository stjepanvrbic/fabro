//! Semantic validation for immutable workflow versions.
//!
//! The wire type ([`fabro_types::WorkflowVersion`]) enforces structural
//! invariants at construction. This crate owns the expensive semantic
//! validation — graph closure, config, and template checks — behind the
//! [`ValidatedWorkflowVersion`] newtype, and the content-addressed
//! [`WorkflowVersionStore`] that only accepts and returns validated versions.

use std::collections::{BTreeSet, HashMap, VecDeque};

use fabro_config::{EnvironmentDockerfileLayer, EnvironmentImageLayer, SettingsLayer};
use fabro_graphviz::parser;
use fabro_template::{
    BundleTemplateStore, GraphReference, GraphReferenceError, StaticReferenceError,
    TemplateDiscoveryError, TemplateSource, discover_static_dependency_closure,
    validate_static_reference, visit_graph_references,
};
use fabro_types::graph::ReferenceKind;
use fabro_types::{ManifestPath, WorkflowPath, WorkflowPathParseError, WorkflowVersion};
use thiserror::Error;

mod store;

pub use store::{WorkflowVersionStore, WorkflowVersionStoreError};

#[derive(Debug, Error)]
pub enum WorkflowVersionError {
    #[error("workflow graph `{path}` is invalid")]
    GraphParse {
        path:   WorkflowPath,
        #[source]
        source: fabro_graphviz::Error,
    },
    #[error("invalid {kind} in `{path}`: `{reference}`")]
    InvalidReference {
        path:      WorkflowPath,
        kind:      ReferenceKind,
        reference: String,
        #[source]
        source:    WorkflowPathParseError,
    },
    #[error("invalid static reference in `{path}`")]
    StaticReference {
        path:   WorkflowPath,
        #[source]
        source: StaticReferenceError,
    },
    #[error("{kind} in `{path}` references missing file `{target}`")]
    MissingFile {
        path:   WorkflowPath,
        kind:   ReferenceKind,
        target: WorkflowPath,
    },
    #[error("template dependencies for `{path}` are invalid")]
    Template {
        path:   WorkflowPath,
        #[source]
        source: Box<TemplateDiscoveryError>,
    },
    #[error("workflow.toml is invalid")]
    Config {
        #[source]
        source: fabro_config::ParseError,
    },
    #[error(
        "workflow.toml selects graph `{configured}`, but the version entrypoint is `{entrypoint}`"
    )]
    ConfigEntrypointMismatch {
        configured: WorkflowPath,
        entrypoint: WorkflowPath,
    },
    #[error("workflow dependencies do not match child workflow references")]
    DependencyMismatch {
        missing: Vec<WorkflowPath>,
        unused:  Vec<WorkflowPath>,
    },
}

/// A workflow version whose graph, config, and template content passed
/// semantic validation.
///
/// This is the only door: functions that require a semantically valid
/// version take this type, and the only way to obtain one is [`Self::new`]
/// (or loading through [`WorkflowVersionStore`], which validates on read).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedWorkflowVersion(WorkflowVersion);

impl ValidatedWorkflowVersion {
    pub fn new(version: WorkflowVersion) -> Result<Self, WorkflowVersionError> {
        validate_config(&version)?;
        validate_graph_closure(&version)?;
        Ok(Self(version))
    }

    #[must_use]
    pub fn version(&self) -> &WorkflowVersion {
        &self.0
    }

    #[must_use]
    pub fn into_version(self) -> WorkflowVersion {
        self.0
    }
}

fn validate_config(version: &WorkflowVersion) -> Result<(), WorkflowVersionError> {
    let config_path =
        WorkflowPath::new("workflow.toml").expect("the static workflow config path must be valid");
    let Some(source) = version.files().get(&config_path) else {
        return Ok(());
    };
    let layer = source
        .parse::<SettingsLayer>()
        .map_err(|source| WorkflowVersionError::Config { source })?;

    if let Some(configured) = layer
        .workflow
        .as_ref()
        .and_then(|workflow| workflow.graph.as_deref())
    {
        let configured = resolve_reference(&config_path, ReferenceKind::FileInline, configured)?;
        if configured != *version.entrypoint() {
            return Err(WorkflowVersionError::ConfigEntrypointMismatch {
                configured,
                entrypoint: version.entrypoint().clone(),
            });
        }
    }

    for image in layer.environment_images() {
        validate_dockerfile(version, &config_path, image)?;
    }
    Ok(())
}

fn validate_dockerfile(
    version: &WorkflowVersion,
    config_path: &WorkflowPath,
    image: &EnvironmentImageLayer,
) -> Result<(), WorkflowVersionError> {
    let Some(EnvironmentDockerfileLayer::Path { path }) = image.dockerfile.as_ref() else {
        return Ok(());
    };
    validate_static_reference(path, ReferenceKind::Dockerfile).map_err(|source| {
        WorkflowVersionError::StaticReference {
            path: config_path.clone(),
            source,
        }
    })?;
    let target = resolve_reference(config_path, ReferenceKind::Dockerfile, path)?;
    require_file(version, config_path, ReferenceKind::Dockerfile, target).map(|_| ())
}

fn validate_graph_closure(version: &WorkflowVersion) -> Result<(), WorkflowVersionError> {
    let template_store = template_store(version);
    let template_root = ManifestPath::from_wire(".")
        .expect("the template package root must be a valid manifest path");
    let mut queue = VecDeque::from([version.entrypoint().clone()]);
    let mut visited = BTreeSet::new();
    let mut child_workflows = BTreeSet::new();

    while let Some(path) = queue.pop_front() {
        if !visited.insert(path.clone()) {
            continue;
        }
        let source =
            version
                .files()
                .get(&path)
                .ok_or_else(|| WorkflowVersionError::MissingFile {
                    path:   path.clone(),
                    kind:   ReferenceKind::Import,
                    target: path.clone(),
                })?;
        let graph = parser::parse(source).map_err(|source| WorkflowVersionError::GraphParse {
            path: path.clone(),
            source,
        })?;

        visit_graph_references(&graph, |reference| match reference {
            GraphReference::GoalFile { reference } => {
                let target = resolve_reference(&path, ReferenceKind::GraphGoalFile, reference)?;
                let content =
                    require_file(version, &path, ReferenceKind::GraphGoalFile, target.clone())?;
                validate_template(&target, content, &template_store, &template_root)
            }
            GraphReference::GoalInline { content } | GraphReference::InlinePrompt { content } => {
                validate_template(&path, content, &template_store, &template_root)
            }
            GraphReference::Import { reference } => {
                let target = resolve_reference(&path, ReferenceKind::Import, reference)?;
                require_file(version, &path, ReferenceKind::Import, target.clone())?;
                queue.push_back(target);
                Ok(())
            }
            GraphReference::ChildWorkflow { reference } => {
                let target = resolve_reference(&path, ReferenceKind::ChildWorkflow, reference)?;
                child_workflows.insert(target);
                Ok(())
            }
            GraphReference::FileInline { key, reference } => {
                let target = resolve_reference(&path, ReferenceKind::FileInline, reference)?;
                let content =
                    require_file(version, &path, ReferenceKind::FileInline, target.clone())?;
                if key == "prompt" {
                    validate_template(&target, content, &template_store, &template_root)?;
                }
                Ok(())
            }
        })
        .map_err(|error| match error {
            GraphReferenceError::StaticReference(source) => WorkflowVersionError::StaticReference {
                path: path.clone(),
                source,
            },
            GraphReferenceError::Visit(error) => error,
        })?;
    }

    let configured = version
        .dependencies()
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    if child_workflows != configured {
        return Err(WorkflowVersionError::DependencyMismatch {
            missing: child_workflows.difference(&configured).cloned().collect(),
            unused:  configured.difference(&child_workflows).cloned().collect(),
        });
    }
    Ok(())
}

fn validate_template(
    path: &WorkflowPath,
    content: &str,
    store: &BundleTemplateStore,
    root: &ManifestPath,
) -> Result<(), WorkflowVersionError> {
    let manifest_path = manifest_path(path);
    discover_static_dependency_closure(
        [TemplateSource::new(manifest_path, root.clone(), content)],
        store,
    )
    .map_err(|source| WorkflowVersionError::Template {
        path:   path.clone(),
        source: Box::new(source),
    })?;
    Ok(())
}

fn template_store(version: &WorkflowVersion) -> BundleTemplateStore {
    BundleTemplateStore::new(
        version
            .files()
            .iter()
            .map(|(path, content)| (manifest_path(path), content.clone()))
            .collect::<HashMap<_, _>>(),
    )
}

fn resolve_reference(
    path: &WorkflowPath,
    kind: ReferenceKind,
    reference: &str,
) -> Result<WorkflowPath, WorkflowVersionError> {
    path.resolve_reference(reference)
        .map_err(|source| WorkflowVersionError::InvalidReference {
            path: path.clone(),
            kind,
            reference: reference.to_owned(),
            source,
        })
}

fn require_file<'version>(
    version: &'version WorkflowVersion,
    path: &WorkflowPath,
    kind: ReferenceKind,
    target: WorkflowPath,
) -> Result<&'version str, WorkflowVersionError> {
    version
        .files()
        .get(&target)
        .map(String::as_str)
        .ok_or_else(|| WorkflowVersionError::MissingFile {
            path: path.clone(),
            kind,
            target,
        })
}

fn manifest_path(path: &WorkflowPath) -> ManifestPath {
    ManifestPath::from_wire(path.as_str())
        .expect("validated workflow paths must also be valid manifest paths")
}

#[cfg(test)]
mod tests {
    use fabro_types::{RunBlobId, WorkflowPath, WorkflowVersion, WorkflowVersionId};

    use super::{ValidatedWorkflowVersion, WorkflowVersionError};

    fn path(value: &str) -> WorkflowPath {
        value.parse().unwrap()
    }

    fn dependency_id(value: &[u8]) -> WorkflowVersionId {
        RunBlobId::new(value).into()
    }

    fn version_with(
        files: impl IntoIterator<Item = (&'static str, &'static str)>,
        dependencies: impl IntoIterator<Item = (&'static str, WorkflowVersionId)>,
    ) -> Result<ValidatedWorkflowVersion, WorkflowVersionError> {
        ValidatedWorkflowVersion::new(
            WorkflowVersion::new(
                path("workflow.fabro"),
                files
                    .into_iter()
                    .map(|(path_value, content)| (path(path_value), content.to_owned()))
                    .collect(),
                dependencies
                    .into_iter()
                    .map(|(path_value, id)| (path(path_value), id))
                    .collect(),
            )
            .expect("test fixtures must be structurally valid"),
        )
    }

    #[test]
    fn validates_imports_templates_file_refs_and_dependencies() {
        let version = version_with(
            [
                (
                    "workflow.fabro",
                    r#"digraph W {
                        graph [goal="@prompts/goal.md"]
                        start [shape=Mdiamond]
                        imported [import="graphs/imported.fabro"]
                        child [stack.child_workflow="children/check.fabro"]
                        exit [shape=Msquare]
                        start -> imported -> child -> exit
                    }"#,
                ),
                (
                    "graphs/imported.fabro",
                    r#"digraph I { step [prompt="{% include \"../prompts/partial.md\" %}"] }"#,
                ),
                ("prompts/goal.md", "{% include \"partial.md\" %}"),
                ("prompts/partial.md", "Do the work"),
            ],
            [("children/check.fabro", dependency_id(b"child"))],
        )
        .unwrap();

        assert_eq!(version.version().dependencies().len(), 1);
    }

    #[test]
    fn rejects_missing_and_unused_dependencies() {
        let error = version_with(
            [(
                "workflow.fabro",
                r#"digraph W { child [stack.child_workflow="child.fabro"] }"#,
            )],
            [("unused.fabro", dependency_id(b"unused"))],
        )
        .unwrap_err();

        let WorkflowVersionError::DependencyMismatch { missing, unused } = error else {
            panic!("expected dependency mismatch");
        };
        assert_eq!(missing, vec![path("child.fabro")]);
        assert_eq!(unused, vec![path("unused.fabro")]);
    }

    #[test]
    fn rejects_config_entrypoint_and_missing_dockerfile() {
        let error = version_with(
            [
                (
                    "workflow.fabro",
                    "digraph W { start [shape=Mdiamond] exit [shape=Msquare] start -> exit }",
                ),
                (
                    "workflow.toml",
                    "_version = 1\n[workflow]\ngraph = \"other.fabro\"\n",
                ),
            ],
            [],
        )
        .unwrap_err();
        assert!(matches!(
            error,
            WorkflowVersionError::ConfigEntrypointMismatch { .. }
        ));

        let missing_dockerfile = version_with(
            [
                ("workflow.fabro", "digraph W {}"),
                (
                    "workflow.toml",
                    "_version = 1\n[run.environment.image]\ndockerfile = { path = \"docker/Dockerfile\" }\n",
                ),
            ],
            [],
        )
        .unwrap_err();
        assert!(matches!(
            missing_dockerfile,
            WorkflowVersionError::MissingFile { .. }
        ));

        let invalid_config = version_with(
            [
                ("workflow.fabro", "digraph W {}"),
                ("workflow.toml", "not valid toml = ["),
            ],
            [],
        )
        .unwrap_err();
        assert!(matches!(
            invalid_config,
            WorkflowVersionError::Config { .. }
        ));
    }

    #[test]
    fn accepts_root_config_and_all_dockerfile_path_sources() {
        let version = version_with(
            [
                ("workflow.fabro", "digraph W {}"),
                (
                    "workflow.toml",
                    r#"_version = 1
[workflow]
graph = "workflow.fabro"

[environments.cloud]
provider = "daytona"

[environments.cloud.image]
dockerfile = { path = "docker/named.Dockerfile" }

[run.environment.image]
dockerfile = { path = "docker/run.Dockerfile" }
"#,
                ),
                ("docker/named.Dockerfile", "FROM alpine\n"),
                ("docker/run.Dockerfile", "FROM ubuntu\n"),
            ],
            [],
        )
        .unwrap();

        assert_eq!(version.version().entrypoint(), &path("workflow.fabro"));
    }

    #[test]
    fn rejects_escaping_and_dynamic_template_references() {
        let escaping = version_with(
            [(
                "workflow.fabro",
                r#"digraph W { imported [import="../outside.fabro"] }"#,
            )],
            [],
        )
        .unwrap_err();
        assert!(matches!(
            escaping,
            WorkflowVersionError::InvalidReference { .. }
        ));

        let dynamic = version_with(
            [(
                "workflow.fabro",
                r#"digraph W { step [prompt="{% include template_name %}"] }"#,
            )],
            [],
        )
        .unwrap_err();
        assert!(matches!(dynamic, WorkflowVersionError::Template { .. }));
    }
}
