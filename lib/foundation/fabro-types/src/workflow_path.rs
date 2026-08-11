use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const MAX_WORKFLOW_PATH_BYTES: usize = 240;
pub const MAX_WORKFLOW_PATH_COMPONENTS: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq, Error)]
#[error("invalid workflow path `{value}`: {reason}")]
pub struct WorkflowPathParseError {
    value:  String,
    reason: &'static str,
}

impl WorkflowPathParseError {
    fn new(value: &str, reason: &'static str) -> Self {
        Self {
            value: value.to_owned(),
            reason,
        }
    }

    #[must_use]
    pub fn value(&self) -> &str {
        &self.value
    }

    #[must_use]
    pub fn reason(&self) -> &'static str {
        self.reason
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(into = "String", try_from = "String")]
pub struct WorkflowPath(String);

impl WorkflowPath {
    pub fn new(value: impl Into<String>) -> Result<Self, WorkflowPathParseError> {
        let value = value.into();
        validate(&value)?;
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn parent(&self) -> Option<Self> {
        self.0
            .rsplit_once('/')
            .map(|(parent, _)| Self(parent.to_owned()))
    }

    #[must_use]
    pub fn is_ancestor_of(&self, other: &Self) -> bool {
        other.0.len() > self.0.len()
            && other.0.starts_with(self.0.as_str())
            && other.0.as_bytes()[self.0.len()] == b'/'
    }

    pub fn resolve_reference(&self, reference: &str) -> Result<Self, WorkflowPathParseError> {
        validate_reference_shape(reference)?;
        let mut components = self
            .0
            .rsplit_once('/')
            .map_or_else(Vec::new, |(parent, _)| {
                parent.split('/').collect::<Vec<_>>()
            });

        for component in reference.split('/') {
            match component {
                "" | "." => {}
                ".." => {
                    if components.pop().is_none() {
                        return Err(WorkflowPathParseError::new(
                            reference,
                            "reference escapes the workflow root",
                        ));
                    }
                }
                value => components.push(value),
            }
        }

        Self::new(components.join("/"))
    }
}

impl FromStr for WorkflowPath {
    type Err = WorkflowPathParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value)
    }
}

impl TryFrom<String> for WorkflowPath {
    type Error = WorkflowPathParseError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<WorkflowPath> for String {
    fn from(value: WorkflowPath) -> Self {
        value.0
    }
}

impl fmt::Display for WorkflowPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

fn validate(value: &str) -> Result<(), WorkflowPathParseError> {
    validate_reference_shape(value)?;
    if value
        .split('/')
        .any(|component| matches!(component, "." | ".."))
    {
        return Err(WorkflowPathParseError::new(
            value,
            "dot segments are not allowed in stored paths",
        ));
    }
    if value.split('/').count() > MAX_WORKFLOW_PATH_COMPONENTS {
        return Err(WorkflowPathParseError::new(
            value,
            "path has too many components",
        ));
    }
    if value.len() > MAX_WORKFLOW_PATH_BYTES {
        return Err(WorkflowPathParseError::new(value, "path is too long"));
    }
    Ok(())
}

fn validate_reference_shape(value: &str) -> Result<(), WorkflowPathParseError> {
    if value.is_empty() {
        return Err(WorkflowPathParseError::new(value, "path is empty"));
    }
    if value.starts_with('/') {
        return Err(WorkflowPathParseError::new(
            value,
            "absolute paths are not allowed",
        ));
    }
    if value.starts_with('~') {
        return Err(WorkflowPathParseError::new(
            value,
            "tilde-prefixed paths are not allowed",
        ));
    }
    if value.contains('\\') {
        return Err(WorkflowPathParseError::new(
            value,
            "backslashes are not allowed",
        ));
    }
    if value.ends_with('/') {
        return Err(WorkflowPathParseError::new(
            value,
            "trailing slashes are not allowed",
        ));
    }
    if value.contains("//") {
        return Err(WorkflowPathParseError::new(
            value,
            "repeated slashes are not allowed",
        ));
    }
    let bytes = value.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err(WorkflowPathParseError::new(
            value,
            "Windows drive paths are not allowed",
        ));
    }
    if value.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(WorkflowPathParseError::new(
            value,
            "control characters are not allowed",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::{MAX_WORKFLOW_PATH_BYTES, MAX_WORKFLOW_PATH_COMPONENTS, WorkflowPath};

    #[test]
    fn accepts_canonical_portable_paths() {
        for value in ["workflow.fabro", "graphs/main.fabro", "prompts/日本語.md"] {
            let path: WorkflowPath = value.parse().expect("path should parse");
            assert_eq!(path.as_str(), value);
        }
    }

    #[test]
    fn rejects_non_canonical_or_unsafe_paths() {
        for value in [
            "", "/root", "root/", "a//b", "a\\b", "~/a", "C:/a", ".", "..", "a/./b", "a/../b",
            "a\nb",
        ] {
            assert!(value.parse::<WorkflowPath>().is_err(), "accepted {value:?}");
        }
    }

    #[test]
    fn enforces_byte_and_component_limits() {
        assert!(
            "a".repeat(MAX_WORKFLOW_PATH_BYTES)
                .parse::<WorkflowPath>()
                .is_ok()
        );
        assert!(
            "a".repeat(MAX_WORKFLOW_PATH_BYTES + 1)
                .parse::<WorkflowPath>()
                .is_err()
        );
        assert!(
            vec!["a"; MAX_WORKFLOW_PATH_COMPONENTS]
                .join("/")
                .parse::<WorkflowPath>()
                .is_ok()
        );
        assert!(
            vec!["a"; MAX_WORKFLOW_PATH_COMPONENTS + 1]
                .join("/")
                .parse::<WorkflowPath>()
                .is_err()
        );
    }

    #[test]
    fn resolves_references_without_escaping_root() {
        let graph: WorkflowPath = "graphs/nested/main.fabro".parse().unwrap();
        assert_eq!(
            graph.resolve_reference("../prompts/plan.md").unwrap(),
            "graphs/prompts/plan.md".parse().unwrap()
        );
        assert!(graph.resolve_reference("../../../outside.md").is_err());
        assert!(graph.resolve_reference("prompts//plan.md").is_err());
        assert!(graph.resolve_reference("prompts/").is_err());
    }

    #[test]
    fn ancestor_checks_component_boundaries() {
        let parent: WorkflowPath = "dir/file".parse().unwrap();
        assert!(parent.is_ancestor_of(&"dir/file/child".parse().unwrap()));
        assert!(!parent.is_ancestor_of(&"dir/filename".parse().unwrap()));
    }

    #[test]
    fn serde_and_ordered_map_keys_preserve_canonical_text() {
        let paths = BTreeMap::from([
            ("z/last.md".parse::<WorkflowPath>().unwrap(), 2),
            ("a/first.md".parse::<WorkflowPath>().unwrap(), 1),
        ]);

        assert_eq!(
            serde_json::to_value(&paths).unwrap(),
            json!({"a/first.md": 1, "z/last.md": 2})
        );
        assert_eq!(
            serde_json::from_value::<BTreeMap<WorkflowPath, i32>>(json!({
                "a/first.md": 1,
                "z/last.md": 2
            }))
            .unwrap(),
            paths
        );
    }

    #[test]
    fn byte_limit_counts_utf8_bytes() {
        assert!(
            "é".repeat(MAX_WORKFLOW_PATH_BYTES / 2)
                .parse::<WorkflowPath>()
                .is_ok()
        );
        assert!(
            "é".repeat(MAX_WORKFLOW_PATH_BYTES / 2 + 1)
                .parse::<WorkflowPath>()
                .is_err()
        );
        assert!("notes/\u{85}.md".parse::<WorkflowPath>().is_ok());
    }
}
