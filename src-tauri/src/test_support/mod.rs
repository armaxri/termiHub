//! Test doubles shared across the `src-tauri` unit-test suites (#5369).
//!
//! One [`RecordingSink`] replaces the per-suite projection `VecSink`s, one
//! [`ClientCache`] the per-suite client caches (#5373), and
//! [`FakeAgent`] is the one scriptable [`AgentRpcClient`] for the
//! agent-manager, session and network suites, so a change to the real
//! contract is mirrored in one place instead of a dozen. A
//! [`FakeAgent::session_host`] adds a stateful transport and session model
//! (#5372) for the reconnect redrive suites.
//!
//! [`AgentRpcClient`]: crate::terminal::agent_manager::AgentRpcClient

pub(crate) mod agent_rpc;
pub(crate) mod client_cache;
pub(crate) mod session_host;
pub(crate) mod sinks;

pub(crate) use agent_rpc::FakeAgent;
pub(crate) use client_cache::ClientCache;
pub(crate) use sinks::RecordingSink;
