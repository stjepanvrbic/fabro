use std::any::{TypeId, type_name};

use fabro_api::types::{
    WorkflowPath as ApiWorkflowPath, WorkflowVersion as ApiWorkflowVersion,
    WorkflowVersionId as ApiWorkflowVersionId,
};
use fabro_types::{WorkflowPath, WorkflowVersionId};
use fabro_workflow_version::WorkflowVersion;
use serde_json::json;

#[test]
fn workflow_version_schemas_reuse_domain_types() {
    assert_same_type::<ApiWorkflowPath, WorkflowPath>();
    assert_same_type::<ApiWorkflowVersionId, WorkflowVersionId>();
    assert_same_type::<ApiWorkflowVersion, WorkflowVersion>();
}

#[test]
fn workflow_version_round_trips_exact_wire_shape() {
    let value = json!({
        "entrypoint": "workflow.fabro",
        "files": {
            "prompts/goal.md": "Ship it",
            "workflow.fabro": "digraph W { start [shape=Mdiamond] exit [shape=Msquare] start -> exit }"
        },
        "dependencies": {}
    });

    let version: ApiWorkflowVersion = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(version).unwrap(), value);
}

#[test]
fn workflow_version_replacement_rejects_unknown_fields() {
    let value = json!({
        "entrypoint": "workflow.fabro",
        "files": {
            "workflow.fabro": "digraph W {}"
        },
        "dependencies": {},
        "metadata": {}
    });

    assert!(serde_json::from_value::<ApiWorkflowVersion>(value).is_err());
}

fn assert_same_type<T: 'static, U: 'static>() {
    assert_eq!(
        TypeId::of::<T>(),
        TypeId::of::<U>(),
        "{} and {} should be the same type",
        type_name::<T>(),
        type_name::<U>()
    );
}
