//! Optional agent-side GitHub self-update (#1355, Approach 1 of the remote-agent
//! update strategy).
//!
//! Off by default; gated behind `allow_self_update`. This module is built up
//! across the #1355 change set: version comparison, GitHub release polling,
//! SHA-256-verified download, the `agent.update_available` notification, and the
//! background 24-hour timer.

mod checksum;
mod download;
mod github;
mod version;
