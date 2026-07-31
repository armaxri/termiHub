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
//! # Render cut — zero user-facing change
//!
//! The store is **not yet authoritative**: the status bar and Open Connections now
//! render from the `system-monitors` region, but `appStore` still owns the state
//! and the frontend keeps the region a faithful mirror of it via `monitor.replace`
//! (rendering from the region only when it deep-equals `appStore`, else falling
//! back to `appStore`). The granular `monitor.*` transitions stay served for the
//! later mutation cut, which makes the store authoritative before the `appStore`
//! state is finally removed. Parity-safe at every step.

pub mod projection;
pub mod store;

pub use store::SystemMonitorStore;
