//! Legacy X11 forwarding module — superseded by the core implementation.
//!
//! The canonical implementation is
//! [`termihub_core::backends::ssh::x11::X11Forwarder`], which uses russh's
//! `tcpip_forward` API and async tokio tasks. This module is kept as a
//! placeholder until callers have migrated to the core backend.
