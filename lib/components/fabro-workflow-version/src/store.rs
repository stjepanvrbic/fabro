use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::Arc;

use fabro_store::BlobStore;
use fabro_types::{WorkflowPath, WorkflowVersion, WorkflowVersionId, WorkflowVersionShapeError};
use thiserror::Error;

use crate::{ValidatedWorkflowVersion, WorkflowVersionError};

#[derive(Debug, Error)]
pub enum WorkflowVersionStoreError {
    #[error(transparent)]
    InvalidVersion(#[from] WorkflowVersionError),
    #[error(transparent)]
    InvalidShape(#[from] WorkflowVersionShapeError),
    #[error("workflow-version dependency `{id}` at `{path}` is not stored")]
    DependencyNotFound {
        path: WorkflowPath,
        id:   WorkflowVersionId,
    },
    #[error("workflow-version dependency `{id}` at `{path}` is invalid")]
    DependencyInvalid {
        path:   WorkflowPath,
        id:     WorkflowVersionId,
        #[source]
        source: Box<Self>,
    },
    #[error("workflow-version blob `{id}` cannot be decoded as a valid workflow version")]
    Decode {
        id:     WorkflowVersionId,
        #[source]
        source: serde_json::Error,
    },
    #[error("workflow-version blob `{id}` is not canonical")]
    NonCanonical { id: WorkflowVersionId },
    #[error("workflow-version storage operation failed")]
    Storage {
        #[source]
        source: fabro_store::Error,
    },
}

/// Content-addressed storage for validated workflow versions.
///
/// `put` only accepts semantically validated versions; `get` re-validates
/// blobs on read because the blob namespace is shared and storage is not
/// trusted to contain only canonical versions.
#[derive(Clone, Debug)]
pub struct WorkflowVersionStore {
    blobs: Arc<BlobStore>,
}

impl WorkflowVersionStore {
    #[must_use]
    pub fn new(blobs: Arc<BlobStore>) -> Self {
        Self { blobs }
    }

    pub async fn put(
        &self,
        version: &ValidatedWorkflowVersion,
    ) -> Result<WorkflowVersionId, WorkflowVersionStoreError> {
        let canonical = version.version().canonical_bytes()?;
        self.validate_dependency_closure(version.version().workflow_dependencies())
            .await?;
        self.blobs
            .write(&canonical)
            .await
            .map(WorkflowVersionId::from)
            .map_err(|source| WorkflowVersionStoreError::Storage { source })
    }

    pub async fn get(
        &self,
        id: &WorkflowVersionId,
    ) -> Result<Option<ValidatedWorkflowVersion>, WorkflowVersionStoreError> {
        let Some(version) = self.load_one(id).await? else {
            return Ok(None);
        };
        self.validate_dependency_closure(version.version().workflow_dependencies())
            .await?;
        Ok(Some(version))
    }

    async fn load_one(
        &self,
        id: &WorkflowVersionId,
    ) -> Result<Option<ValidatedWorkflowVersion>, WorkflowVersionStoreError> {
        let blob_id = (*id).into();
        let Some(bytes) = self
            .blobs
            .read(&blob_id)
            .await
            .map_err(|source| WorkflowVersionStoreError::Storage { source })?
        else {
            return Ok(None);
        };
        let version = serde_json::from_slice::<WorkflowVersion>(&bytes)
            .map_err(|source| WorkflowVersionStoreError::Decode { id: *id, source })?;
        let validated = ValidatedWorkflowVersion::new(version)?;
        let canonical = validated.version().canonical_bytes()?;
        if canonical.as_slice() != bytes.as_ref() {
            return Err(WorkflowVersionStoreError::NonCanonical { id: *id });
        }
        Ok(Some(validated))
    }

    async fn validate_dependency_closure(
        &self,
        dependencies: &BTreeMap<WorkflowPath, WorkflowVersionId>,
    ) -> Result<(), WorkflowVersionStoreError> {
        let mut pending = dependencies
            .iter()
            .map(|(path, id)| (path.clone(), *id))
            .collect::<VecDeque<_>>();
        let mut visited = HashSet::new();

        while let Some((path, id)) = pending.pop_front() {
            if !visited.insert(id) {
                continue;
            }
            match self.load_one(&id).await {
                Ok(Some(dependency)) => {
                    pending.extend(
                        dependency
                            .version()
                            .workflow_dependencies()
                            .iter()
                            .map(|(path, id)| (path.clone(), *id)),
                    );
                }
                Ok(None) => {
                    return Err(WorkflowVersionStoreError::DependencyNotFound { path, id });
                }
                // Persistence failures are server faults, not evidence that
                // the caller supplied an invalid dependency.
                Err(source @ WorkflowVersionStoreError::Storage { .. }) => return Err(source),
                Err(source) => {
                    return Err(WorkflowVersionStoreError::DependencyInvalid {
                        path,
                        id,
                        source: Box::new(source),
                    });
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Arc;
    use std::time::Duration;

    use fabro_store::{BlobStore, Database};
    use fabro_types::{WorkflowPath, WorkflowVersion, WorkflowVersionId};
    use object_store::memory::InMemory;

    use super::{WorkflowVersionStore, WorkflowVersionStoreError};
    use crate::ValidatedWorkflowVersion;

    fn path(value: &str) -> WorkflowPath {
        value.parse().unwrap()
    }

    fn version(
        graph: &str,
        dependencies: BTreeMap<WorkflowPath, WorkflowVersionId>,
    ) -> ValidatedWorkflowVersion {
        ValidatedWorkflowVersion::new(
            WorkflowVersion::new(
                path("workflow.fabro"),
                BTreeMap::from([(path("workflow.fabro"), graph.to_owned())]),
                dependencies,
            )
            .unwrap(),
        )
        .unwrap()
    }

    async fn stores() -> (Arc<BlobStore>, WorkflowVersionStore) {
        let database = Database::new(
            Arc::new(InMemory::new()),
            "",
            Duration::from_millis(1),
            None,
        );
        let blobs = database.blobs().await.unwrap();
        let versions = WorkflowVersionStore::new(Arc::clone(&blobs));
        (blobs, versions)
    }

    #[tokio::test]
    async fn put_get_reuses_exact_blob_digest() {
        let (blobs, store) = stores().await;
        let version = version("digraph W {}", BTreeMap::new());
        let expected_bytes = version.version().canonical_bytes().unwrap();
        let expected_id = WorkflowVersionId::from(fabro_types::BlobHash::new(&expected_bytes));

        let id = store.put(&version).await.unwrap();
        assert_eq!(id, expected_id);
        let blob_id = id.into();
        assert_eq!(blobs.read(&blob_id).await.unwrap().unwrap(), expected_bytes);
        assert_eq!(store.get(&id).await.unwrap(), Some(version));
    }

    #[tokio::test]
    async fn identical_content_is_idempotent() {
        let (_, store) = stores().await;
        let original = version("digraph W {}", BTreeMap::new());

        assert_eq!(
            store.put(&original).await.unwrap(),
            store.put(&original).await.unwrap()
        );

        let changed = version("digraph W { changed [label=\"yes\"] }", BTreeMap::new());
        assert_ne!(
            store.put(&original).await.unwrap(),
            store.put(&changed).await.unwrap()
        );
    }

    #[tokio::test]
    async fn dependency_must_be_stored_first() {
        let (blobs, store) = stores().await;
        let child = version("digraph Child {}", BTreeMap::new());
        let child_id = WorkflowVersionId::from(fabro_types::BlobHash::new(
            &child.version().canonical_bytes().unwrap(),
        ));
        let root = version(
            r#"digraph Root { child [stack.child_workflow="child.fabro"] }"#,
            BTreeMap::from([(path("child.fabro"), child_id)]),
        );
        let root_id = WorkflowVersionId::from(fabro_types::BlobHash::new(
            &root.version().canonical_bytes().unwrap(),
        ));

        let error = store.put(&root).await.unwrap_err();
        assert!(matches!(
            error,
            WorkflowVersionStoreError::DependencyNotFound { .. }
        ));
        assert!(!blobs.exists(&root_id.into()).await.unwrap());
        assert_eq!(store.put(&child).await.unwrap(), child_id);
        assert!(store.put(&root).await.is_ok());
    }

    #[tokio::test]
    async fn dependency_closure_must_be_complete_before_root_write() {
        let (blobs, store) = stores().await;
        let missing_grandchild_id = WorkflowVersionId::from(fabro_types::BlobHash::new(b"missing"));
        let child = version(
            r#"digraph Child { grandchild [stack.child_workflow="grandchild.fabro"] }"#,
            BTreeMap::from([(path("grandchild.fabro"), missing_grandchild_id)]),
        );
        let child_bytes = child.version().canonical_bytes().unwrap();
        let child_id = WorkflowVersionId::from(blobs.write(&child_bytes).await.unwrap());
        let root = version(
            r#"digraph Root { child [stack.child_workflow="child.fabro"] }"#,
            BTreeMap::from([(path("child.fabro"), child_id)]),
        );
        let root_id = WorkflowVersionId::from(fabro_types::BlobHash::new(
            &root.version().canonical_bytes().unwrap(),
        ));

        assert!(matches!(
            store.put(&root).await.unwrap_err(),
            WorkflowVersionStoreError::DependencyNotFound { id, .. }
                if id == missing_grandchild_id
        ));
        assert!(!blobs.exists(&root_id.into()).await.unwrap());
        assert!(matches!(
            store.get(&child_id).await.unwrap_err(),
            WorkflowVersionStoreError::DependencyNotFound { id, .. }
                if id == missing_grandchild_id
        ));
    }

    #[tokio::test]
    async fn get_rejects_arbitrary_and_noncanonical_blobs() {
        let (blobs, store) = stores().await;
        let arbitrary = WorkflowVersionId::from(blobs.write(b"not json").await.unwrap());
        assert!(matches!(
            store.get(&arbitrary).await.unwrap_err(),
            WorkflowVersionStoreError::Decode { .. }
        ));

        let invalid_bytes = br#"{"entrypoint":"missing.fabro","files":{"workflow.fabro":"digraph W {}"},"workflow_dependencies":{}}"#;
        let invalid = WorkflowVersionId::from(blobs.write(invalid_bytes).await.unwrap());
        assert!(matches!(
            store.get(&invalid).await.unwrap_err(),
            WorkflowVersionStoreError::Decode { .. }
        ));

        let version = version("digraph W {}", BTreeMap::new());
        let pretty = serde_json::to_vec_pretty(version.version()).unwrap();
        let noncanonical = WorkflowVersionId::from(blobs.write(&pretty).await.unwrap());
        assert!(matches!(
            store.get(&noncanonical).await.unwrap_err(),
            WorkflowVersionStoreError::NonCanonical { .. }
        ));
    }
}
