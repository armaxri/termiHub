//! Test doubles shared across the `src-tauri` unit-test suites (#5369).
//!
//! One [`RecordingSink`] replaces the per-suite projection `VecSink`s, and
//! [`FakeAgent`] is the one scriptable [`AgentRpcClient`] for the
//! agent-manager, session and network suites, so a change to the real
//! contract is mirrored in one place instead of a dozen.
//!
//! [`AgentRpcClient`]: crate::terminal::agent_manager::AgentRpcClient

pub(crate) mod agent_rpc;
pub(crate) mod sinks;

pub(crate) use agent_rpc::FakeAgent;
pub(crate) use sinks::RecordingSink;
