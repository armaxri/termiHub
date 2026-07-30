//! Remote (`ssh -R`) port-forward engine — re-exported from core (#2185).
//!
//! The engine was lifted into `termihub_core::tunnel::remote_forward` so the
//! identical forwarder runs on the desktop or on a remote agent (S3, part of
//! #2139). This module re-exports it so existing desktop call sites
//! (`super::remote_forward::RemoteForwarder`) are unchanged. The unit tests for
//! the relay path now live alongside it in core.

pub use termihub_core::tunnel::remote_forward::RemoteForwarder;
