//! Local (`ssh -L`) port-forward engine — re-exported from core (#2185).
//!
//! The engine was lifted into `termihub_core::tunnel::local_forward` so the
//! identical forwarder runs on the desktop or on a remote agent (S3, part of
//! #2139). This module re-exports it so existing desktop call sites
//! (`super::local_forward::{LocalForwarder, ForwarderStats}`) — including the
//! dynamic/remote forwarders that share [`ForwarderStats`] — are unchanged. The
//! unit tests for the engine now live alongside it in core.

pub use termihub_core::tunnel::local_forward::{ForwarderStats, LocalForwarder};
