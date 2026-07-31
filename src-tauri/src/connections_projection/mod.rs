//! Shadow connections-tree authority — Phase 5 of the stateless-UI migration
//! (#2225, part of #2139 and #2153).
//!
//! Moves the saved-connection / folder tree the frontend drives in `appStore`
//! (`folders: ConnectionFolder[]` + `connections: SavedConnection[]`) onto a Rust
//! authority. The saved-connection config already lives in Rust
//! ([`crate::connection`]); this store therefore **wraps that existing authority**
//! — it reuses the flat in-memory types the manager and IPC layer already speak
//! ([`crate::connection::config::SavedConnection`] and
//! [`crate::connection::config::ConnectionFolder`]) rather than re-homing them.
//! It owns a single **shared** `connections` projection region (Open Design
//! Decision #4) and serves the `connection.*` intents through the projection
//! substrate ([`crate::projection`]), mirroring the SSH-tunnels pilot
//! ([`crate::tunnel::projection`]), the session-lifecycle shadow
//! ([`crate::session_projection`]) and the system-monitor shadow
//! ([`crate::system_monitor_projection`]).
//!
//! # Shared region — Open Design Decision #4
//!
//! The saved connections/folders are a single persisted config (the connections
//! JSON file), identical for every viewing client — like SSH tunnels. So the
//! inventory (the two flat arrays, including each folder's persisted
//! `isExpanded`) is modelled here as one **shared** `connections` region. Truly
//! per-client presentation — tree *selection* / highlight, which lives only in
//! the `useTreeSelection` React hook and is never persisted — stays a frontend
//! concern under partial projection and is deliberately kept out of the store.
//!
//! # Shadow mode — zero user-facing change
//!
//! This step is deliberately **not** authoritative. The store exists, accepts
//! `connection.*` intents, and projects diffs, but nothing in the live UI
//! subscribes to or renders the `connections` region, and no frontend code
//! dispatches `connection.*` intents yet. The existing `appStore` connections
//! slice and the sidebar rendering are untouched. Later steps cut rendering, then
//! mutation, over to the region, then remove the `appStore` state.

pub mod projection;
pub mod store;

pub use store::ConnectionsStore;
