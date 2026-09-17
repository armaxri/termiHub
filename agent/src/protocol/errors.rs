//! Standard and application JSON-RPC 2.0 error codes.

pub use termihub_core::protocol::errors::*;

// The error-code constants are defined and owned by `termihub_core::protocol::errors`
// and re-exported above (per #2944). Their invariants (negativity, JSON-RPC/application
// ranges) are validated by the tests in that module, so this crate does not duplicate them.
