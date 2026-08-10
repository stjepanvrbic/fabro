use std::sync::Arc;

use fabro_types::{WorkflowPath, WorkflowVersionId};
use fabro_workflow_version::{WorkflowVersion, WorkflowVersionError};
use thiserror::Error;

use crate::BlobStore;

#[derive(Debug, Error)]
pub enum WorkflowVersionStoreError {
    #[error(transparent)]
    InvalidVersion(#[from] WorkflowVersionError),
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
        source: crate::Error,
    },
}

impl WorkflowVersionStoreError {
    #[must_use]
    pub fn is_dependency_unavailable(&self) -> bool {
        matches!(
            self,
            Self::DependencyNotFound { .. } | Self::DependencyInvalid { .. }
        )
    }
}

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
        version: &WorkflowVersion,
    ) -> Result<WorkflowVersionId, WorkflowVersionStoreError> {
        let canonical = version.canonical_bytes()?;
        for (path, id) in version.dependencies() {
            match self.get(id).await {
                Ok(Some(_)) => {}
                Ok(None) => {
                    return Err(WorkflowVersionStoreError::DependencyNotFound {
                        path: path.clone(),
                        id:   *id,
                    });
                }
                Err(source) => {
                    return Err(WorkflowVersionStoreError::DependencyInvalid {
                        path:   path.clone(),
                        id:     *id,
                        source: Box::new(source),
                    });
                }
            }
        }
        self.blobs
            .write(&canonical)
            .await
            .map(WorkflowVersionId::from)
            .map_err(|source| WorkflowVersionStoreError::Storage { source })
    }

    pub async fn get(
        &self,
        id: &WorkflowVersionId,
    ) -> Result<Option<WorkflowVersion>, WorkflowVersionStoreError> {
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
        let canonical = version.canonical_bytes()?;
        if canonical.as_slice() != bytes.as_ref() {
            return Err(WorkflowVersionStoreError::NonCanonical { id: *id });
        }
        Ok(Some(version))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Arc;
    use std::time::Duration;

    use fabro_types::{WorkflowPath, WorkflowVersionId};
    use fabro_workflow_version::WorkflowVersion;
    use object_store::memory::InMemory;

    use super::{WorkflowVersionStore, WorkflowVersionStoreError};
    use crate::Database;

    fn path(value: &str) -> WorkflowPath {
        value.parse().unwrap()
    }

    fn version(
        graph: &str,
        dependencies: BTreeMap<WorkflowPath, WorkflowVersionId>,
    ) -> WorkflowVersion {
        WorkflowVersion::new(
            path("workflow.fabro"),
            BTreeMap::from([(path("workflow.fabro"), graph.to_owned())]),
            dependencies,
        )
        .unwrap()
    }

    async fn stores() -> (Arc<crate::BlobStore>, WorkflowVersionStore) {
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
        let expected_bytes = version.canonical_bytes().unwrap();
        let expected_id = WorkflowVersionId::from(fabro_types::RunBlobId::new(&expected_bytes));

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
        let child_id = WorkflowVersionId::from(fabro_types::RunBlobId::new(
            &child.canonical_bytes().unwrap(),
        ));
        let root = version(
            r#"digraph Root { child [stack.child_workflow="child.fabro"] }"#,
            BTreeMap::from([(path("child.fabro"), child_id)]),
        );
        let root_id = WorkflowVersionId::from(fabro_types::RunBlobId::new(
            &root.canonical_bytes().unwrap(),
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
    async fn get_rejects_arbitrary_and_noncanonical_blobs() {
        let (blobs, store) = stores().await;
        let arbitrary = WorkflowVersionId::from(blobs.write(b"not json").await.unwrap());
        assert!(matches!(
            store.get(&arbitrary).await.unwrap_err(),
            WorkflowVersionStoreError::Decode { .. }
        ));

        let invalid_bytes = br#"{"entrypoint":"missing.fabro","files":{"workflow.fabro":"digraph W {}"},"dependencies":{}}"#;
        let invalid = WorkflowVersionId::from(blobs.write(invalid_bytes).await.unwrap());
        assert!(matches!(
            store.get(&invalid).await.unwrap_err(),
            WorkflowVersionStoreError::Decode { .. }
        ));

        let version = version("digraph W {}", BTreeMap::new());
        let pretty = serde_json::to_vec_pretty(&version).unwrap();
        let noncanonical = WorkflowVersionId::from(blobs.write(&pretty).await.unwrap());
        assert!(matches!(
            store.get(&noncanonical).await.unwrap_err(),
            WorkflowVersionStoreError::NonCanonical { .. }
        ));
    }
}
