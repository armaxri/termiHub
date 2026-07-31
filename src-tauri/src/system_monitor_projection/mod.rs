//! Shadow system-monitor authority — Phase 5 of the stateless-UI migration
//! (#2224, part of #2139).
//!
//! Moves the per-host/session monitoring slice the frontend drives in `appStore`
//! (`monitors: Record<MonitorKey, MonitoringEntry>` + `monitoringStatsCache`) into
//! a Rust authority built on the monitoring types already shared with the agent
//! crate (`termihub_core::monitoring`). The store owns a single **shared**
//! `system-monitors` projection region (Open Design Decision #4: infrastructure
//! domains are shared) and serves the `monitor.*` intents through the projection
//! substrate ([`crate::projection`]), mirroring the SSH-tunnels pilot
//! ([`crate::tunnel::projection`]) and the session-lifecycle shadow
//! ([`crate::session_projection`]).
//!
//! # Shadow mode — zero user-facing change
//!
//! This step is deliberately **not** authoritative. The store exists, accepts
//! intents, and projects diffs, but nothing in the live UI subscribes to or
//! renders the `system-monitors` region, and no frontend code dispatches
//! `monitor.*` intents yet. The existing `appStore` monitoring slice and the
//! status-bar / Open-Connections rendering are untouched. Later steps cut
//! rendering, then mutation, over to the region, then remove the `appStore` state.

pub mod projection;
pub mod store;

pub use store::SystemMonitorStore;
