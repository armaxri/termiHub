//! Dynamic (`ssh -D`, SOCKS5) port-forward engine — re-exported from core
//! (#2185, #2198).
//!
//! The engine was lifted into `termihub_core::tunnel::dynamic_forward` so the
//! identical forwarder runs on the desktop or on a remote agent (S3, part of
//! #2139). This module re-exports it so existing desktop call sites
//! (`super::dynamic_forward::DynamicForwarder`) are unchanged. The SOCKS5
//! handshake, target-parsing, and relay unit tests now live alongside it in
//! core.

pub use termihub_core::tunnel::dynamic_forward::DynamicForwarder;
