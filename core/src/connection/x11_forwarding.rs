//! How X11 forwarding runs for an open session (#5586).
//!
//! An SSH session with X11 forwarding on asks the server with `x11-req`
//! first, and falls back to a `tcpip-forward` listener plus typed `DISPLAY`
//! setup when the server does not accept it (#5570). This records which of
//! those the session ended up with, so the UI can say so after the connect.

use serde::{Deserialize, Serialize};

/// Which way X11 forwarding runs for a session with it turned on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub enum X11ForwardingMode {
    /// The server accepted `x11-req`: it set `DISPLAY` itself and nothing was
    /// typed into the shell.
    ServerForwarded,
    /// The server refused `x11-req` (e.g. `X11Forwarding no`), so `DISPLAY`
    /// is set by the typed fallback.
    FallbackRefused,
    /// The server did not answer `x11-req` in time, so `DISPLAY` is set by
    /// the typed fallback.
    FallbackNoReply,
    /// X11 forwarding is on but could not be set up (no local X server, or
    /// the fallback failed). The session runs without it.
    Failed,
}
