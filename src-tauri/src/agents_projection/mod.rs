//! Agents authority — Phase 5 of the stateless-UI migration
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
//! # Authoritative — drives the live UI
//!
//! The stateless-UI inversion is complete (#2283): this store is the source of
//! truth for the agents slice. The agent sidebar and Open Connections render from
//! the projected `agents` region, and agent transitions dispatch the `agent.*`
//! intents; the former `appStore` agents reducers were removed. Per the substrate
//! contract an intent's result is never returned inline — it always arrives as a
//! projection diff on the `agents` region.

pub mod projection;
pub mod store;

pub use store::AgentsStore;
