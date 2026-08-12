pub mod command;

#[cfg(feature = "runtime")]
pub mod error;
#[cfg(feature = "runtime")]
pub mod session;

#[cfg(any(test, feature = "test-support"))]
pub mod test_support;

#[cfg(feature = "runtime")]
mod transport;

pub use agent_client_protocol::schema::{
    PermissionOptionKind, RequestPermissionOutcome, RequestPermissionRequest,
    SelectedPermissionOutcome,
};
pub use command::{AcpCommandError, AcpProcessSpec};
#[cfg(feature = "runtime")]
pub use error::{AcpError, AcpProcessExit};
#[cfg(feature = "runtime")]
pub use session::{
    AcpAskHandler, AcpControlHandle, AcpLiveControl, AcpPermissionHandler, AcpRunRequest,
    AcpRunResult, FACTORY_ASK_METHOD, render_stop_reason, run_acp_turn,
};
