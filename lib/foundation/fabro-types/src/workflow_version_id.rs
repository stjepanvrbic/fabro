use std::fmt;
use std::str::FromStr;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;

use crate::RunBlobId;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct WorkflowVersionId(RunBlobId);

impl From<RunBlobId> for WorkflowVersionId {
    fn from(value: RunBlobId) -> Self {
        Self(value)
    }
}

impl From<WorkflowVersionId> for RunBlobId {
    fn from(value: WorkflowVersionId) -> Self {
        value.0
    }
}

impl fmt::Display for WorkflowVersionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
#[error("workflow version ID must be exactly 64 lowercase hexadecimal characters")]
pub struct WorkflowVersionIdParseError;

impl FromStr for WorkflowVersionId {
    type Err = WorkflowVersionIdParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(WorkflowVersionIdParseError);
        }
        value
            .parse::<RunBlobId>()
            .map(Self)
            .map_err(|_| WorkflowVersionIdParseError)
    }
}

impl Serialize for WorkflowVersionId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for WorkflowVersionId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer)?
            .parse()
            .map_err(D::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use crate::{RunBlobId, WorkflowVersionId};

    #[test]
    fn conversion_preserves_digest_and_display() {
        let blob_id = RunBlobId::new(b"workflow");
        let version_id = WorkflowVersionId::from(blob_id);
        assert_eq!(version_id.to_string(), blob_id.to_string());
        assert_eq!(RunBlobId::from(version_id), blob_id);
    }

    #[test]
    fn parse_and_serde_require_lowercase_hex() {
        let value = RunBlobId::new(b"workflow").to_string();
        let id: WorkflowVersionId = value.parse().unwrap();
        assert_eq!(serde_json::to_value(id).unwrap(), value);
        assert!(value.to_uppercase().parse::<WorkflowVersionId>().is_err());
        for invalid in [
            String::new(),
            "0".repeat(63),
            "0".repeat(65),
            "g".repeat(64),
        ] {
            assert!(invalid.parse::<WorkflowVersionId>().is_err());
        }
        assert!(
            serde_json::from_value::<WorkflowVersionId>(serde_json::json!(value.to_uppercase()))
                .is_err()
        );
    }
}
