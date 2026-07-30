//! Channel-opener seam for the tunnel forwarders.
//!
//! Lifted into core (#2185) so the same forwarders run on the desktop or on an
//! agent (S3, part of #2139). This module re-exports the core trait and the
//! production [`SshChannelOpener`] so existing desktop call sites
//! (`super::channel::…`) are unchanged. The local, remote, and dynamic (`-D`)
//! forward engines all live in core now, with their unit tests (and the
//! in-memory `EchoChannelOpener` test fake) alongside them there (#2198).

pub use termihub_core::tunnel::channel::{ChannelOpener, SshChannelOpener};
