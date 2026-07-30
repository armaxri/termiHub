//! Shadow session-lifecycle authority — Phase 4 step 1 of the stateless-UI
//! migration (#2152, part of #2139).
//!
//! Moves the connect / reconnect / disconnect / error state machine the frontend
//! drives per session into a Rust authority built on the ported auto-reconnect
//! engine (`termihub_core::reconnect_backoff`, #2144). The store owns a single
//! **shared** `session-lifecycle` projection region (Open Design Decision #4:
//! infrastructure domains are shared) and serves the `session.*` intents through
//! the projection substrate ([`crate::projection`]), mirroring the SSH-tunnels
//! pilot ([`crate::tunnel::projection`]).
//!
//! # Shadow mode — zero user-facing change
//!
//! This step is deliberately **not authoritative**. The store exists, accepts
//! intents, and projects diffs, but nothing in the live UI subscribes to or
//! renders the `session-lifecycle` region, and no frontend code dispatches
//! `session.*` intents yet. The existing `appStore` lifecycle reducers and the
//! terminal overlays are untouched. Later steps cut the transitions over, then
//! rendering, then remove the `appStore` state; broadcast/restore-cohort logic
//! (built on the ported #2145 `restore_mode`) migrates as its own step and keeps
//! a clean per-domain boundary.

pub mod projection;
pub mod store;
pub mod timer;

pub use store::SessionLifecycleStore;
pub use timer::{ReconnectTimerDriver, TokioReconnectScheduler};
