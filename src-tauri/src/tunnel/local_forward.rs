//! Local (`ssh -L`) port-forward engine — re-exported from core (#2185).
//!
//! The engine was lifted into `termihub_core::tunnel::local_forward` so the
//! identical forwarder runs on the desktop or on a remote agent (S3, part of
//! #2139). This module re-exports [`LocalForwarder`] so existing desktop call
//! sites (`super::local_forward::LocalForwarder`) are unchanged. The unit tests
//! for the engine — and the shared [`ForwarderStats`] every forwarder rides —
//! now live alongside it in core; test call sites reference it there directly.
//!
//! [`ForwarderStats`]: termihub_core::tunnel::local_forward::ForwarderStats

pub use termihub_core::tunnel::local_forward::LocalForwarder;
