use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context as _, Result, anyhow};
use fabro_api::types;
use fabro_config::project::WorkflowLocation;
use fabro_config::{EnvironmentDockerfileLayer, EnvironmentImageLayer, SettingsLayer};
use fabro_graphviz::graph::AttrValue;
use fabro_graphviz::parser;
use fabro_graphviz::static_reference::{self, AttributeScope, ReferenceKind};
use fabro_template::{
    BundleTemplateStore, FilesystemTemplateStore, RecordingTemplateStore, TemplateContext,
    TemplateDependencyClosure, TemplateRenderMode, TemplateSource,
};
use fabro_types::ManifestPath;

use crate::{manifest_path_from_absolute, normalize_absolute_path};

pub(super) struct WorkflowBundler<'a> {
    cwd:               &'a Path,
    inputs:            &'a HashMap<String, toml::Value>,
    template_store:    FilesystemTemplateStore,
    workflows:         HashMap<String, types::ManifestWorkflow>,
    visited_workflows: HashSet<String>,
}

impl<'a> WorkflowBundler<'a> {
    pub(super) fn new(cwd: &'a Path, inputs: &'a HashMap<String, toml::Value>) -> Self {
        Self {
            cwd,
            inputs,
            template_store: FilesystemTemplateStore::new(cwd),
            workflows: HashMap::new(),
            visited_workflows: HashSet::new(),
        }
    }

    pub(super) fn bundle(
        mut self,
        workflow: &Path,
        project_config: Option<(&ManifestPath, &str)>,
    ) -> Result<HashMap<String, types::ManifestWorkflow>> {
        let root_key = self.collect_workflow_entry(workflow, self.cwd)?;

        if let Some((config_path, source)) = project_config {
            let mut root = self
                .workflows
                .remove(&root_key)
                .ok_or_else(|| anyhow!("root workflow missing from manifest bundle"))?;
            self.collect_config_dockerfile(config_path, source, &mut root.files)?;
            self.workflows.insert(root_key, root);
        }

        Ok(self.workflows)
    }

    /// Collects the workflow at `location` and returns its manifest key.
    fn collect_workflow_location(&mut self, location: &WorkflowLocation) -> Result<String> {
        let dot_path = manifest_path_from_absolute(&location.graph, self.cwd)?;
        let dot_key = dot_path.to_string();
        if !self.visited_workflows.insert(dot_key.clone()) {
            return Ok(dot_key);
        }

        let source = std::fs::read_to_string(&location.graph)
            .with_context(|| format!("Failed to read {}", location.graph.display()))?;
        let config = if let Some(workflow_toml_path) = location.toml.as_ref() {
            Some(types::ManifestWorkflowConfig {
                path:   manifest_path_from_absolute(workflow_toml_path, self.cwd)?.to_string(),
                source: std::fs::read_to_string(workflow_toml_path)
                    .with_context(|| format!("Failed to read {}", workflow_toml_path.display()))?,
            })
        } else {
            None
        };

        let scan = WorkflowScanInput {
            absolute_dot_path: location.graph.clone(),
            dot_path,
            source: source.clone(),
        };
        let mut files = HashMap::new();
        let mut visited_imports = HashSet::new();
        if let Some(config) = config.as_ref() {
            let config_path = ManifestPath::from_wire(&config.path)
                .ok_or_else(|| anyhow!("invalid manifest workflow config path: {}", config.path))?;
            self.collect_config_dockerfile(&config_path, &config.source, &mut files)?;
        }
        self.collect_workflow_files(&scan, &mut files, &mut visited_imports)?;

        self.workflows
            .insert(dot_key.clone(), types::ManifestWorkflow {
                config,
                files,
                source,
            });

        Ok(dot_key)
    }

    /// Relative workflow references with an extension are lexically
    /// normalized (`..` segments resolved without consulting the filesystem,
    /// `~` rejected) before resolution, so the file read matches the manifest
    /// key. Returns the collected workflow's manifest key.
    fn collect_workflow_entry(&mut self, workflow: &Path, resolve_from: &Path) -> Result<String> {
        let normalized_workflow = if workflow.extension().is_some() && workflow.is_relative() {
            normalize_absolute_path(resolve_from, &workflow.to_string_lossy()).ok_or_else(|| {
                anyhow!(
                    "unsupported manifest workflow reference: {}",
                    workflow.display()
                )
            })?
        } else {
            workflow.to_path_buf()
        };
        let location = WorkflowLocation::resolve(&normalized_workflow, resolve_from)?;
        self.collect_workflow_location(&location)
    }

    fn collect_workflow_files(
        &mut self,
        workflow: &WorkflowScanInput,
        files: &mut HashMap<String, types::ManifestFileEntry>,
        visited_imports: &mut HashSet<String>,
    ) -> Result<()> {
        let graph = parser::parse(&workflow.source)
            .with_context(|| format!("Failed to parse {}", workflow.absolute_dot_path.display()))?;
        let workflow_base_dir = workflow
            .absolute_dot_path
            .parent()
            .unwrap_or_else(|| Path::new("."));
        let workflow_template_root = manifest_parent_or_dot(&workflow.dot_path)?;

        if let Some(goal_ref) = graph.attrs.get("goal").and_then(AttrValue::as_str) {
            if goal_ref.starts_with('@') {
                let bundled = self.collect_bundled_file(
                    files,
                    workflow_base_dir,
                    goal_ref.trim_start_matches('@'),
                    types::ManifestFileRefType::FileInline,
                    manifest_attr_reference_kind(AttributeScope::Graph, "goal", goal_ref)?,
                    Some(workflow.dot_path.clone()),
                )?;
                self.collect_bundled_template_includes(files, &bundled, &workflow_template_root)?;
            } else {
                self.collect_template_include_files(
                    files,
                    TemplateSource::new(
                        workflow.dot_path.clone(),
                        workflow_template_root.clone(),
                        goal_ref.to_owned(),
                    ),
                    Some(&workflow.dot_path),
                )?;
            }
        }

        for node in graph.nodes.values() {
            if let Some(prompt_ref) = node.attrs.get("prompt").and_then(AttrValue::as_str) {
                if !prompt_ref.starts_with('@') {
                    self.collect_template_include_files(
                        files,
                        TemplateSource::new(
                            workflow.dot_path.clone(),
                            workflow_template_root.clone(),
                            prompt_ref.to_owned(),
                        ),
                        Some(&workflow.dot_path),
                    )?;
                }
            }

            for (name, value) in &node.attrs {
                let Some(value) = value.as_str() else {
                    continue;
                };
                let Some(ReferenceKind::FileInline) =
                    static_reference::reference_kind_for_attribute(
                        AttributeScope::Node,
                        name,
                        value,
                    )
                else {
                    continue;
                };
                let reference = value.strip_prefix('@').ok_or_else(|| {
                    anyhow!("file inline reference must start with '@': {name}={value}")
                })?;
                let bundled = self.collect_bundled_file(
                    files,
                    workflow_base_dir,
                    reference,
                    types::ManifestFileRefType::FileInline,
                    ReferenceKind::FileInline,
                    Some(workflow.dot_path.clone()),
                )?;

                if name == "prompt" {
                    self.collect_bundled_template_includes(
                        files,
                        &bundled,
                        &workflow_template_root,
                    )?;
                }
            }

            if let Some(import_ref) = node.attrs.get("import").and_then(AttrValue::as_str) {
                let imported = self.collect_bundled_file(
                    files,
                    workflow_base_dir,
                    import_ref,
                    types::ManifestFileRefType::Import,
                    manifest_attr_reference_kind(AttributeScope::Node, "import", import_ref)?,
                    Some(workflow.dot_path.clone()),
                )?;
                let import_key = imported.path.to_string();
                if visited_imports.insert(import_key) {
                    let imported_source = std::fs::read_to_string(&imported.absolute_path)
                        .with_context(|| {
                            format!("Failed to read {}", imported.absolute_path.display())
                        })?;
                    let imported_scan = WorkflowScanInput {
                        absolute_dot_path: imported.absolute_path,
                        dot_path:          imported.path,
                        source:            imported_source,
                    };
                    self.collect_workflow_files(&imported_scan, files, visited_imports)?;
                }
            }

            if let Some(child_ref) = node
                .attrs
                .get("stack.child_workflow")
                .and_then(AttrValue::as_str)
            {
                manifest_attr_reference_kind(
                    AttributeScope::Node,
                    "stack.child_workflow",
                    child_ref,
                )?
                .validate(child_ref)
                .map_err(anyhow::Error::new)?;
                self.collect_workflow_entry(Path::new(child_ref), workflow_base_dir)?;
            }
        }

        Ok(())
    }

    fn collect_bundled_template_includes(
        &self,
        files: &mut HashMap<String, types::ManifestFileEntry>,
        bundled: &BundledFile,
        workflow_template_root: &ManifestPath,
    ) -> Result<()> {
        let source = std::fs::read_to_string(&bundled.absolute_path)
            .with_context(|| format!("Failed to read {}", bundled.absolute_path.display()))?;
        let template_root = template_root_for_bundled_file(&bundled.path, workflow_template_root)?;
        self.collect_template_include_files(
            files,
            TemplateSource::new(bundled.path.clone(), template_root, source),
            Some(&bundled.path),
        )
    }

    fn collect_template_include_files(
        &self,
        files: &mut HashMap<String, types::ManifestFileEntry>,
        source: TemplateSource,
        from: Option<&ManifestPath>,
    ) -> Result<()> {
        let source_path = source.path.clone();
        let closure =
            fabro_template::discover_static_dependency_closure([source], &self.template_store)
                .context("failed to discover template dependencies")?;
        self.verify_recorded_template_dependencies(&source_path, &closure, files, from)?;

        for (path, source) in closure.sources {
            if path == source_path {
                continue;
            }
            let key = path.to_string();
            files
                .entry(key)
                .or_insert_with(|| types::ManifestFileEntry {
                    content: source.content,
                    ref_:    types::ManifestFileRef {
                        from:     from.map(std::string::ToString::to_string),
                        original: path.to_string(),
                        type_:    types::ManifestFileRefType::FileInline,
                    },
                });
        }
        Ok(())
    }

    fn verify_recorded_template_dependencies(
        &self,
        source_path: &ManifestPath,
        closure: &TemplateDependencyClosure,
        files: &HashMap<String, types::ManifestFileEntry>,
        from: Option<&ManifestPath>,
    ) -> Result<()> {
        let Some(source) = closure.sources.get(source_path) else {
            return Ok(());
        };
        let mut bundled_files = closure
            .sources
            .iter()
            .map(|(path, source)| (path.clone(), source.content.clone()))
            .collect::<HashMap<_, _>>();
        for (path, entry) in files {
            if let Some(path) = ManifestPath::from_wire(path) {
                bundled_files.insert(path, entry.content.clone());
            }
        }
        let allowed = bundled_files.keys().cloned().collect();
        let store =
            RecordingTemplateStore::with_allowed(BundleTemplateStore::new(bundled_files), allowed);
        let context = TemplateContext::for_input_scan(self.inputs.clone());
        fabro_template::render_source(
            source,
            &context,
            Arc::new(store),
            TemplateRenderMode::Lenient,
        )
        .with_context(|| {
            let from =
                from.map_or_else(|| source_path.to_string(), std::string::ToString::to_string);
            format!("failed to verify template dependencies for {from}")
        })?;
        Ok(())
    }

    fn collect_config_dockerfile(
        &self,
        config_path: &ManifestPath,
        source: &str,
        files: &mut HashMap<String, types::ManifestFileEntry>,
    ) -> Result<()> {
        let layer = source
            .parse::<SettingsLayer>()
            .context("Failed to parse run config TOML")?;
        let absolute_config_path = self.cwd.join(config_path.as_path());
        let base_dir = absolute_config_path
            .parent()
            .unwrap_or_else(|| Path::new("."));

        for environment in layer.environments.values() {
            self.collect_environment_dockerfile(
                files,
                base_dir,
                config_path,
                environment.image.as_ref(),
            )?;
        }
        if let Some(run_environment) = layer.run.as_ref().and_then(|run| run.environment.as_ref()) {
            self.collect_environment_dockerfile(
                files,
                base_dir,
                config_path,
                run_environment.image.as_ref(),
            )?;
        }
        Ok(())
    }

    fn collect_environment_dockerfile(
        &self,
        files: &mut HashMap<String, types::ManifestFileEntry>,
        base_dir: &Path,
        config_path: &ManifestPath,
        image: Option<&EnvironmentImageLayer>,
    ) -> Result<()> {
        let dockerfile = image.and_then(|image| image.dockerfile.as_ref());
        let Some(EnvironmentDockerfileLayer::Path { path }) = dockerfile else {
            return Ok(());
        };
        self.collect_bundled_file(
            files,
            base_dir,
            path,
            types::ManifestFileRefType::Dockerfile,
            ReferenceKind::Dockerfile,
            Some(config_path.clone()),
        )?;
        Ok(())
    }

    fn collect_bundled_file(
        &self,
        files: &mut HashMap<String, types::ManifestFileEntry>,
        base_dir: &Path,
        reference: &str,
        ref_type: types::ManifestFileRefType,
        reference_kind: ReferenceKind,
        from: Option<ManifestPath>,
    ) -> Result<BundledFile> {
        reference_kind
            .validate(reference)
            .map_err(anyhow::Error::new)?;

        let absolute_path = normalize_absolute_path(base_dir, reference)
            .ok_or_else(|| anyhow!("unsupported manifest reference: {reference}"))?;
        let path = manifest_path_from_absolute(&absolute_path, self.cwd)?;
        let key = path.to_string();
        if !files.contains_key(&key) {
            let content = std::fs::read_to_string(&absolute_path)
                .with_context(|| format!("Failed to read {}", absolute_path.display()))?;
            files.insert(key.clone(), types::ManifestFileEntry {
                content,
                ref_: types::ManifestFileRef {
                    from:     from.map(|value| value.to_string()),
                    original: reference.to_owned(),
                    type_:    ref_type,
                },
            });
        }

        Ok(BundledFile {
            absolute_path,
            path,
        })
    }
}

struct WorkflowScanInput {
    absolute_dot_path: PathBuf,
    dot_path:          ManifestPath,
    source:            String,
}

struct BundledFile {
    absolute_path: PathBuf,
    path:          ManifestPath,
}

fn manifest_parent_or_dot(path: &ManifestPath) -> Result<ManifestPath> {
    let parent = path.parent_or_dot().to_string_lossy();
    ManifestPath::from_wire(&parent)
        .ok_or_else(|| anyhow!("invalid manifest parent path for {path}: {parent}"))
}

fn template_root_for_bundled_file(
    path: &ManifestPath,
    workflow_template_root: &ManifestPath,
) -> Result<ManifestPath> {
    if manifest_path_is_within_root(path, workflow_template_root) {
        Ok(workflow_template_root.clone())
    } else {
        manifest_parent_or_dot(path)
    }
}

fn manifest_path_is_within_root(path: &ManifestPath, root: &ManifestPath) -> bool {
    if root.as_path().as_os_str().is_empty() {
        return !matches!(
            path.as_path().components().next(),
            Some(Component::ParentDir)
        );
    }
    path.starts_with(root)
}

fn manifest_attr_reference_kind(
    scope: AttributeScope,
    key: &str,
    value: &str,
) -> Result<ReferenceKind> {
    static_reference::reference_kind_for_attribute(scope, key, value)
        .ok_or_else(|| anyhow!("unsupported manifest reference attribute: {key}={value}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::write_file;

    fn bundle_graph(cwd: &Path, graph: &Path) -> Result<HashMap<String, types::ManifestWorkflow>> {
        let inputs = HashMap::new();
        WorkflowBundler::new(cwd, &inputs).bundle(graph, None)
    }

    #[test]
    fn repeated_references_collect_one_file() {
        let temp = tempfile::tempdir().expect("temp directory should be created");
        let graph = temp.path().join("workflow.fabro");
        write_file(
            &graph,
            r#"digraph Root {
                start [shape=Mdiamond]
                first [prompt="@prompt.md"]
                second [prompt="@prompt.md"]
                exit [shape=Msquare]
                start -> first -> second -> exit
            }"#,
        );
        write_file(&temp.path().join("prompt.md"), "prompt\n");

        let workflows = bundle_graph(temp.path(), &graph).expect("workflow should bundle");

        assert_eq!(workflows["workflow.fabro"].files.len(), 1);
    }

    #[test]
    fn parse_errors_keep_the_graphviz_error_in_the_source_chain() {
        let temp = tempfile::tempdir().expect("temp directory should be created");
        let graph = temp.path().join("workflow.fabro");
        write_file(&graph, "not a graph");

        let error = bundle_graph(temp.path(), &graph).expect_err("invalid graph should fail");

        assert!(
            error
                .chain()
                .any(|cause| cause.downcast_ref::<fabro_graphviz::Error>().is_some()),
            "unexpected error chain: {error:#}"
        );
    }

    #[test]
    fn read_errors_keep_the_io_error_in_the_source_chain() {
        let temp = tempfile::tempdir().expect("temp directory should be created");
        let graph = temp.path().join("workflow.fabro");
        write_file(
            &graph,
            r#"digraph Root {
                start [shape=Mdiamond]
                work [prompt="@missing.md"]
                exit [shape=Msquare]
                start -> work -> exit
            }"#,
        );

        let error = bundle_graph(temp.path(), &graph).expect_err("missing file should fail");

        assert!(
            error
                .chain()
                .any(|cause| cause.downcast_ref::<std::io::Error>().is_some()),
            "unexpected error chain: {error:#}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn root_workflow_normalizes_parent_components_lexically_before_reading() {
        let temp = tempfile::tempdir().expect("temp directory should be created");
        let cwd = temp.path();
        let lexical_graph =
            "digraph Lexical { start [shape=Mdiamond] exit [shape=Msquare] start -> exit }";
        let symlinked_graph =
            "digraph Symlinked { start [shape=Mdiamond] exit [shape=Msquare] start -> exit }";
        write_file(&cwd.join("wf/workflow.fabro"), lexical_graph);
        write_file(&cwd.join("nested/wf/workflow.fabro"), symlinked_graph);
        std::fs::create_dir_all(cwd.join("nested/elsewhere"))
            .expect("symlink target should be created");
        // `link` points into `nested/`, so OS resolution of `link/..` lands in
        // `nested/` while lexical resolution lands in the invocation directory.
        std::os::unix::fs::symlink(cwd.join("nested/elsewhere"), cwd.join("link"))
            .expect("symlink should be created");

        let workflows = bundle_graph(cwd, Path::new("link/../wf/workflow.fabro"))
            .expect("workflow should bundle");

        // `link/..` must resolve lexically to `wf/workflow.fabro`, not through
        // the symlink to `nested/wf/workflow.fabro`, so the bundled source
        // matches the file the manifest key names.
        assert_eq!(workflows["wf/workflow.fabro"].source, lexical_graph);
    }

    #[test]
    fn root_workflow_rejects_tilde_relative_references() {
        let temp = tempfile::tempdir().expect("temp directory should be created");

        let error = bundle_graph(temp.path(), Path::new("~/workflow.fabro"))
            .expect_err("tilde reference should be rejected");

        assert!(
            error
                .to_string()
                .contains("unsupported manifest workflow reference"),
            "unexpected error: {error:#}"
        );
    }
}
