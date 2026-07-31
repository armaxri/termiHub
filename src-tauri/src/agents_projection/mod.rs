//! Shadow agents authority — Phase 5 of the stateless-UI migration
//! (#2226, part of #2139).
//!
//! Moves the agents slice the frontend drives in `appStore` (the ordered
//! `remoteAgents` list plus the per-agent `agentSessions` / `agentDefinitions` /
//! `agentFolders` maps) into a Rust authority. The store owns a single **shared**
//! `agents` projection region (Open Design Decision #4: infrastructure domains
//! are shared) and serves the `agent.*` intents through the projection substrate
//! ([`crate::projection`]), mirroring the SSH-tunnels pilot
//! ([`crate::tunnel::projection`]) and the system-monitor shadow
//! ([`crate::system_monitor_projection`]).
//!
//! # Shadow mode — zero user-facing change
//!
//! This step is deliberately **not** authoritative. The store exists, accepts
//! intents, and projects diffs, but nothing in the live UI subscribes to or
//! renders the `agents` region, and no frontend code dispatches `agent.*` intents
//! yet. The existing `appStore` agents slice and the agent sidebar / Open
//! Connections rendering are untouched. Later steps cut rendering, then mutation,
//! over to the region, then remove the `appStore` state.

pub mod projection;
pub mod store;

pub use store::AgentsStore;
