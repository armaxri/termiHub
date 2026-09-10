//! System-monitor authority — Phase 5 of the stateless-UI migration
//! (#2224, part of #2139).
//!
//! Moves the per-host/session monitoring slice the frontend drives in `appStore`
//! (`monitors: Record<MonitorKey, MonitoringEntry>` + `monitoringStatsCache`) into
//! a Rust authority built on the monitoring types already shared with the agent
//! crate (`termihub_core::monitoring`). The store owns a single **shared**
//! `system-monitors` projection region (Open Design Decision #4: infrastructure
//! domains are shared) and serves the `monitor.*` intents through the projection
//! substrate ([`crate::projection`]), mirroring the SSH-tunnels pilot
//! ([`crate::tunnel::projection`]) and the session-lifecycle region
//! ([`crate::session_projection`]).
//!
//! # Authoritative — drives the live UI
//!
//! The stateless-UI inversion is complete (#2283): this store is authoritative.
//! The status bar and Open Connections render from the `system-monitors` region
//! and frontend code dispatches the `monitor.*` transitions; the former `appStore`
//! monitoring reducers were removed.

pub mod projection;
pub mod store;

pub use store::SystemMonitorStore;
