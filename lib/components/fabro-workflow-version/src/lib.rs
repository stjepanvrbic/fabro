use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::fmt;
use std::marker::PhantomData;

use fabro_config::{EnvironmentDockerfileLayer, EnvironmentImageLayer, SettingsLayer};
use fabro_graphviz::graph::Graph;
use fabro_graphviz::parser;
use fabro_graphviz::static_reference::{
    AttributeScope, ReferenceKind, StaticReferenceError, reference_kind_for_attribute,
};
use fabro_template::{
    BundleTemplateStore, TemplateDiscoveryError, TemplateSource, discover_static_dependency_closure,
};
use fabro_types::{ManifestPath, WorkflowPath, WorkflowPathParseError, WorkflowVersionId};
use serde::de::{Error as _, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

pub const MAX_WORKFLOW_VERSION_FILES: usize = 512;
pub const MAX_WORKFLOW_VERSION_FILE_BYTES: usize = 512 * 1024;
pub const MAX_WORKFLOW_VERSION_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum WorkflowVersionError {
    #[error("workflow version has {actual} files; maximum is {maximum}")]
    TooManyFiles { actual: usize, maximum: usize },
    #[error("workflow file `{path}` is {actual} bytes; maximum is {maximum}")]
    FileTooLarge {
        path:    WorkflowPath,
        actual:  usize,
        maximum: usize,
    },
    #[error("workflow version is {actual} canonical bytes; maximum is {maximum}")]
    VersionTooLarge { actual: usize, maximum: usize },
    #[error("entrypoint `{path}` is not present in workflow files")]
    MissingEntrypoint { path: WorkflowPath },
    #[error("workflow paths collide: `{first}` and `{second}`")]
    PathCollision {
        first:  WorkflowPath,
        second: WorkflowPath,
    },
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
    #[error("failed to serialize canonical workflow version")]
    Serialization {
        #[source]
        source: serde_json::Error,
    },
}

impl WorkflowVersionError {
    #[must_use]
    pub fn missing_dependencies(&self) -> Option<&[WorkflowPath]> {
        match self {
            Self::DependencyMismatch { missing, .. } => Some(missing),
            _ => None,
        }
    }

    #[must_use]
    pub fn unused_dependencies(&self) -> Option<&[WorkflowPath]> {
        match self {
            Self::DependencyMismatch { unused, .. } => Some(unused),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WorkflowVersion {
    entrypoint:   WorkflowPath,
    files:        BTreeMap<WorkflowPath, String>,
    dependencies: BTreeMap<WorkflowPath, WorkflowVersionId>,
}

impl WorkflowVersion {
    pub fn new(
        entrypoint: WorkflowPath,
        files: BTreeMap<WorkflowPath, String>,
        dependencies: BTreeMap<WorkflowPath, WorkflowVersionId>,
    ) -> Result<Self, WorkflowVersionError> {
        let version = Self {
            entrypoint,
            files,
            dependencies,
        };
        version.validate()?;
        Ok(version)
    }

    #[must_use]
    pub fn entrypoint(&self) -> &WorkflowPath {
        &self.entrypoint
    }

    #[must_use]
    pub fn files(&self) -> &BTreeMap<WorkflowPath, String> {
        &self.files
    }

    #[must_use]
    pub fn dependencies(&self) -> &BTreeMap<WorkflowPath, WorkflowVersionId> {
        &self.dependencies
    }

    pub fn validate(&self) -> Result<(), WorkflowVersionError> {
        self.canonical_bytes().map(|_| ())
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>, WorkflowVersionError> {
        self.validate_structure()?;
        let bytes = serde_json::to_vec(self)
            .map_err(|source| WorkflowVersionError::Serialization { source })?;
        if bytes.len() > MAX_WORKFLOW_VERSION_BYTES {
            return Err(WorkflowVersionError::VersionTooLarge {
                actual:  bytes.len(),
                maximum: MAX_WORKFLOW_VERSION_BYTES,
            });
        }
        Ok(bytes)
    }

    fn validate_structure(&self) -> Result<(), WorkflowVersionError> {
        if self.files.len() > MAX_WORKFLOW_VERSION_FILES {
            return Err(WorkflowVersionError::TooManyFiles {
                actual:  self.files.len(),
                maximum: MAX_WORKFLOW_VERSION_FILES,
            });
        }
        for (path, content) in &self.files {
            if content.len() > MAX_WORKFLOW_VERSION_FILE_BYTES {
                return Err(WorkflowVersionError::FileTooLarge {
                    path:    path.clone(),
                    actual:  content.len(),
                    maximum: MAX_WORKFLOW_VERSION_FILE_BYTES,
                });
            }
        }
        if !self.files.contains_key(&self.entrypoint) {
            return Err(WorkflowVersionError::MissingEntrypoint {
                path: self.entrypoint.clone(),
            });
        }
        self.validate_path_collisions()?;
        self.validate_config()?;
        self.validate_graph_closure()
    }

    fn validate_path_collisions(&self) -> Result<(), WorkflowVersionError> {
        let file_paths = self.files.keys().collect::<Vec<_>>();
        for (index, first) in file_paths.iter().enumerate() {
            for second in &file_paths[index + 1..] {
                if first.is_ancestor_of(second) || second.is_ancestor_of(first) {
                    return Err(WorkflowVersionError::PathCollision {
                        first:  (*first).clone(),
                        second: (*second).clone(),
                    });
                }
            }
        }

        let dependency_paths = self.dependencies.keys().collect::<Vec<_>>();
        for (index, first) in dependency_paths.iter().enumerate() {
            for second in &dependency_paths[index + 1..] {
                if first.is_ancestor_of(second) || second.is_ancestor_of(first) {
                    return Err(WorkflowVersionError::PathCollision {
                        first:  (*first).clone(),
                        second: (*second).clone(),
                    });
                }
            }
        }

        for file in &file_paths {
            for dependency in &dependency_paths {
                if file == dependency
                    || file.is_ancestor_of(dependency)
                    || dependency.is_ancestor_of(file)
                {
                    return Err(WorkflowVersionError::PathCollision {
                        first:  (*file).clone(),
                        second: (*dependency).clone(),
                    });
                }
            }
        }
        Ok(())
    }

    fn validate_config(&self) -> Result<(), WorkflowVersionError> {
        let config_path = WorkflowPath::new("workflow.toml")
            .expect("the static workflow config path must be valid");
        let Some(source) = self.files.get(&config_path) else {
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
            let configured =
                Self::resolve_reference(&config_path, ReferenceKind::FileInline, configured)?;
            if configured != self.entrypoint {
                return Err(WorkflowVersionError::ConfigEntrypointMismatch {
                    configured,
                    entrypoint: self.entrypoint.clone(),
                });
            }
        }

        for environment in layer.environments.values() {
            self.validate_dockerfile(&config_path, environment.image.as_ref())?;
        }
        if let Some(image) = layer
            .run
            .as_ref()
            .and_then(|run| run.environment.as_ref())
            .and_then(|environment| environment.image.as_ref())
        {
            self.validate_dockerfile(&config_path, Some(image))?;
        }
        Ok(())
    }

    fn validate_dockerfile(
        &self,
        config_path: &WorkflowPath,
        image: Option<&EnvironmentImageLayer>,
    ) -> Result<(), WorkflowVersionError> {
        let Some(EnvironmentDockerfileLayer::Path { path }) =
            image.and_then(|image| image.dockerfile.as_ref())
        else {
            return Ok(());
        };
        ReferenceKind::Dockerfile.validate(path).map_err(|source| {
            WorkflowVersionError::StaticReference {
                path: config_path.clone(),
                source,
            }
        })?;
        let target = Self::resolve_reference(config_path, ReferenceKind::Dockerfile, path)?;
        self.require_file(config_path, ReferenceKind::Dockerfile, target)
            .map(|_| ())
    }

    fn validate_graph_closure(&self) -> Result<(), WorkflowVersionError> {
        let template_store = self.template_store();
        let template_root = ManifestPath::from_wire(".")
            .expect("the template package root must be a valid manifest path");
        let mut queue = VecDeque::from([self.entrypoint.clone()]);
        let mut visited = BTreeSet::new();
        let mut child_workflows = BTreeSet::new();

        while let Some(path) = queue.pop_front() {
            if !visited.insert(path.clone()) {
                continue;
            }
            let source =
                self.files
                    .get(&path)
                    .ok_or_else(|| WorkflowVersionError::MissingFile {
                        path:   path.clone(),
                        kind:   ReferenceKind::Import,
                        target: path.clone(),
                    })?;
            let graph =
                parser::parse(source).map_err(|source| WorkflowVersionError::GraphParse {
                    path: path.clone(),
                    source,
                })?;

            self.validate_graph_goal(&path, &graph, &template_store, &template_root)?;
            self.validate_graph_nodes(
                &path,
                &graph,
                &template_store,
                &template_root,
                &mut queue,
                &mut child_workflows,
            )?;
        }

        let configured = self.dependencies.keys().cloned().collect::<BTreeSet<_>>();
        if child_workflows != configured {
            return Err(WorkflowVersionError::DependencyMismatch {
                missing: child_workflows.difference(&configured).cloned().collect(),
                unused:  configured.difference(&child_workflows).cloned().collect(),
            });
        }
        Ok(())
    }

    fn validate_graph_goal(
        &self,
        graph_path: &WorkflowPath,
        graph: &Graph,
        template_store: &BundleTemplateStore,
        template_root: &ManifestPath,
    ) -> Result<(), WorkflowVersionError> {
        let goal = graph.goal();
        if goal.is_empty() {
            return Ok(());
        }
        if let Some(reference) = goal.strip_prefix('@') {
            ReferenceKind::GraphGoalFile
                .validate(reference)
                .map_err(|source| WorkflowVersionError::StaticReference {
                    path: graph_path.clone(),
                    source,
                })?;
            let target =
                Self::resolve_reference(graph_path, ReferenceKind::GraphGoalFile, reference)?;
            let content =
                self.require_file(graph_path, ReferenceKind::GraphGoalFile, target.clone())?;
            return Self::validate_template(&target, content, template_store, template_root);
        }
        Self::validate_template(graph_path, goal, template_store, template_root)
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "Graph validation threads one explicit closure accumulator through node attributes."
    )]
    fn validate_graph_nodes(
        &self,
        graph_path: &WorkflowPath,
        graph: &Graph,
        template_store: &BundleTemplateStore,
        template_root: &ManifestPath,
        imports: &mut VecDeque<WorkflowPath>,
        child_workflows: &mut BTreeSet<WorkflowPath>,
    ) -> Result<(), WorkflowVersionError> {
        for node in graph.nodes.values() {
            for (key, value) in &node.attrs {
                let Some(value) = value.as_str() else {
                    continue;
                };
                let Some(kind) = reference_kind_for_attribute(AttributeScope::Node, key, value)
                else {
                    continue;
                };
                kind.validate(value)
                    .map_err(|source| WorkflowVersionError::StaticReference {
                        path: graph_path.clone(),
                        source,
                    })?;

                match kind {
                    ReferenceKind::Import => {
                        let target = Self::resolve_reference(graph_path, kind, value)?;
                        self.require_file(graph_path, kind, target.clone())?;
                        imports.push_back(target);
                    }
                    ReferenceKind::ChildWorkflow => {
                        let target = Self::resolve_reference(graph_path, kind, value)?;
                        child_workflows.insert(target);
                    }
                    ReferenceKind::FileInline => {
                        let reference = value.strip_prefix('@').ok_or_else(|| {
                            WorkflowVersionError::MissingFile {
                                path: graph_path.clone(),
                                kind,
                                target: graph_path.clone(),
                            }
                        })?;
                        let target = Self::resolve_reference(graph_path, kind, reference)?;
                        let content = self.require_file(graph_path, kind, target.clone())?;
                        if key == "prompt" {
                            Self::validate_template(
                                &target,
                                content,
                                template_store,
                                template_root,
                            )?;
                        }
                    }
                    ReferenceKind::Dockerfile | ReferenceKind::GraphGoalFile => {}
                }
            }

            if let Some(prompt) = node.prompt().filter(|prompt| !prompt.starts_with('@')) {
                Self::validate_template(graph_path, prompt, template_store, template_root)?;
            }
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

    fn template_store(&self) -> BundleTemplateStore {
        BundleTemplateStore::new(
            self.files
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

    fn require_file(
        &self,
        path: &WorkflowPath,
        kind: ReferenceKind,
        target: WorkflowPath,
    ) -> Result<&str, WorkflowVersionError> {
        self.files.get(&target).map(String::as_str).ok_or_else(|| {
            WorkflowVersionError::MissingFile {
                path: path.clone(),
                kind,
                target,
            }
        })
    }
}

fn manifest_path(path: &WorkflowPath) -> ManifestPath {
    ManifestPath::from_wire(path.as_str())
        .expect("validated workflow paths must also be valid manifest paths")
}

impl<'de> Deserialize<'de> for WorkflowVersion {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            entrypoint:   WorkflowPath,
            files:        UniqueBTreeMap<WorkflowPath, String>,
            dependencies: UniqueBTreeMap<WorkflowPath, WorkflowVersionId>,
        }

        let wire = Wire::deserialize(deserializer)?;
        Self::new(wire.entrypoint, wire.files.0, wire.dependencies.0).map_err(D::Error::custom)
    }
}

struct UniqueBTreeMap<K, V>(BTreeMap<K, V>);

impl<'de, K, V> Deserialize<'de> for UniqueBTreeMap<K, V>
where
    K: Deserialize<'de> + Ord + fmt::Display,
    V: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct MapVisitor<K, V>(PhantomData<(K, V)>);

        impl<'de, K, V> Visitor<'de> for MapVisitor<K, V>
        where
            K: Deserialize<'de> + Ord + fmt::Display,
            V: Deserialize<'de>,
        {
            type Value = UniqueBTreeMap<K, V>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a map with unique keys")
            }

            fn visit_map<A>(self, mut access: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut values = BTreeMap::new();
                while let Some((key, value)) = access.next_entry::<K, V>()? {
                    if values.insert(key, value).is_some() {
                        return Err(A::Error::custom("duplicate workflow map key"));
                    }
                }
                Ok(UniqueBTreeMap(values))
            }
        }

        deserializer.deserialize_map(MapVisitor(PhantomData))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use fabro_types::{RunBlobId, WorkflowPath, WorkflowVersionId};

    use super::{
        MAX_WORKFLOW_VERSION_BYTES, MAX_WORKFLOW_VERSION_FILE_BYTES, MAX_WORKFLOW_VERSION_FILES,
        WorkflowVersion, WorkflowVersionError,
    };

    fn path(value: &str) -> WorkflowPath {
        value.parse().unwrap()
    }

    fn dependency_id(value: &[u8]) -> WorkflowVersionId {
        RunBlobId::new(value).into()
    }

    fn version_with(
        files: impl IntoIterator<Item = (&'static str, &'static str)>,
        dependencies: impl IntoIterator<Item = (&'static str, WorkflowVersionId)>,
    ) -> Result<WorkflowVersion, WorkflowVersionError> {
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
    }

    #[test]
    fn canonical_bytes_have_fixed_field_and_map_order() {
        let version = WorkflowVersion::new(
            path("workflow.fabro"),
            BTreeMap::from([
                (path("z.txt"), "Z".to_string()),
                (
                    path("workflow.fabro"),
                    "digraph W { start [shape=Mdiamond] exit [shape=Msquare] start -> exit }"
                        .to_string(),
                ),
                (path("a.txt"), "A".to_string()),
            ]),
            BTreeMap::new(),
        )
        .unwrap();

        assert_eq!(
            String::from_utf8(version.canonical_bytes().unwrap()).unwrap(),
            r#"{"entrypoint":"workflow.fabro","files":{"a.txt":"A","workflow.fabro":"digraph W { start [shape=Mdiamond] exit [shape=Msquare] start -> exit }","z.txt":"Z"},"dependencies":{}}"#
        );
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

        assert_eq!(version.dependencies().len(), 1);
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

        assert_eq!(version.entrypoint(), &path("workflow.fabro"));
    }

    #[test]
    fn rejects_path_collisions_and_large_files() {
        let collision = version_with(
            [
                ("workflow.fabro", "digraph W {}"),
                ("assets", "file"),
                ("assets/item.txt", "nested"),
            ],
            [],
        )
        .unwrap_err();
        assert!(matches!(
            collision,
            WorkflowVersionError::PathCollision { .. }
        ));

        let mut files = BTreeMap::from([(path("workflow.fabro"), "digraph W {}".to_string())]);
        files.insert(
            path("large.txt"),
            "x".repeat(MAX_WORKFLOW_VERSION_FILE_BYTES + 1),
        );
        let large =
            WorkflowVersion::new(path("workflow.fabro"), files, BTreeMap::new()).unwrap_err();
        assert!(matches!(large, WorkflowVersionError::FileTooLarge { .. }));
    }

    #[test]
    fn enforces_file_count_file_size_and_canonical_size_boundaries() {
        let mut files = BTreeMap::from([(path("workflow.fabro"), "digraph W {}".to_string())]);
        for index in 0..MAX_WORKFLOW_VERSION_FILES - 1 {
            files.insert(path(&format!("file-{index:03}.txt")), String::new());
        }
        assert!(
            WorkflowVersion::new(path("workflow.fabro"), files.clone(), BTreeMap::new()).is_ok()
        );
        files.insert(path("too-many.txt"), String::new());
        assert!(matches!(
            WorkflowVersion::new(path("workflow.fabro"), files, BTreeMap::new()).unwrap_err(),
            WorkflowVersionError::TooManyFiles { .. }
        ));

        let exact_file = BTreeMap::from([
            (path("workflow.fabro"), "digraph W {}".to_string()),
            (
                path("payload.txt"),
                "x".repeat(MAX_WORKFLOW_VERSION_FILE_BYTES),
            ),
        ]);
        assert!(
            WorkflowVersion::new(path("workflow.fabro"), exact_file.clone(), BTreeMap::new())
                .is_ok()
        );
        let mut oversized_file = exact_file;
        oversized_file
            .get_mut(&path("payload.txt"))
            .unwrap()
            .push('x');
        assert!(matches!(
            WorkflowVersion::new(path("workflow.fabro"), oversized_file, BTreeMap::new())
                .unwrap_err(),
            WorkflowVersionError::FileTooLarge { .. }
        ));

        let mut exact_version_files =
            BTreeMap::from([(path("workflow.fabro"), "digraph W {}".to_string())]);
        for index in 0..4 {
            exact_version_files.insert(path(&format!("payload-{index}.txt")), String::new());
        }
        let empty = WorkflowVersion::new(
            path("workflow.fabro"),
            exact_version_files.clone(),
            BTreeMap::new(),
        )
        .unwrap();
        let remaining = MAX_WORKFLOW_VERSION_BYTES - empty.canonical_bytes().unwrap().len();
        let per_file = remaining / 4;
        let remainder = remaining % 4;
        for index in 0..4 {
            let length = per_file + usize::from(index < remainder);
            assert!(length <= MAX_WORKFLOW_VERSION_FILE_BYTES);
            exact_version_files.insert(path(&format!("payload-{index}.txt")), "x".repeat(length));
        }
        let exact_version = WorkflowVersion::new(
            path("workflow.fabro"),
            exact_version_files.clone(),
            BTreeMap::new(),
        )
        .unwrap();
        assert_eq!(
            exact_version.canonical_bytes().unwrap().len(),
            MAX_WORKFLOW_VERSION_BYTES
        );
        exact_version_files
            .get_mut(&path("payload-0.txt"))
            .unwrap()
            .push('x');
        assert!(matches!(
            WorkflowVersion::new(path("workflow.fabro"), exact_version_files, BTreeMap::new())
                .unwrap_err(),
            WorkflowVersionError::VersionTooLarge { .. }
        ));
    }

    #[test]
    fn rejects_escaping_and_dynamic_template_references() {
        let escaping = WorkflowVersion::new(
            path("workflow.fabro"),
            BTreeMap::from([(
                path("workflow.fabro"),
                r#"digraph W { imported [import="../outside.fabro"] }"#.to_string(),
            )]),
            BTreeMap::new(),
        )
        .unwrap_err();
        assert!(matches!(
            escaping,
            WorkflowVersionError::InvalidReference { .. }
        ));

        let dynamic = WorkflowVersion::new(
            path("workflow.fabro"),
            BTreeMap::from([(
                path("workflow.fabro"),
                r#"digraph W { step [prompt="{% include template_name %}"] }"#.to_string(),
            )]),
            BTreeMap::new(),
        )
        .unwrap_err();
        assert!(matches!(dynamic, WorkflowVersionError::Template { .. }));
    }

    #[test]
    fn deserialize_rejects_unknown_fields_and_duplicate_keys() {
        let unknown = r#"{
            "entrypoint":"workflow.fabro",
            "files":{"workflow.fabro":"digraph W {}"},
            "dependencies":{},
            "metadata":{}
        }"#;
        assert!(serde_json::from_str::<WorkflowVersion>(unknown).is_err());

        let duplicate = r#"{
            "entrypoint":"workflow.fabro",
            "files":{"workflow.fabro":"digraph W {}","workflow.fabro":"digraph X {}"},
            "dependencies":{}
        }"#;
        assert!(serde_json::from_str::<WorkflowVersion>(duplicate).is_err());
    }
}
