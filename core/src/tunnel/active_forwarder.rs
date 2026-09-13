//! Shared active-forwarder wrapper for a running SSH tunnel.
//!
//! A running tunnel forwards in one of three SSH modes — local (`-L`), remote
//! (`-R`), or dynamic (`-D`, SOCKS5) — each backed by its own concrete core
//! forwarder. Both the desktop tunnel manager (`src-tauri`) and the agent tunnel
//! registry (`agent`) hold their running forwarders in this one enum and
//! dispatch over it uniformly, instead of each maintaining a parallel copy
//! (DUP-017).

use super::{DynamicForwarder, LocalForwarder, RemoteForwarder, TunnelStats};

/// A live SSH tunnel forwarder, wrapping the concrete core forwarder for its
/// mode.
///
/// Each variant stops on `Drop` (the inner forwarder aborts its task and
/// releases its SSH resources), so a holder that only needs teardown can simply
/// drop the value; call [`stop`](Self::stop) to tear it down explicitly.
pub enum ActiveForwarder {
    /// A local (`ssh -L`) forward.
    Local(LocalForwarder),
    /// A remote (`ssh -R`) forward.
    Remote(RemoteForwarder),
    /// A dynamic (`ssh -D`, SOCKS5) forward.
    Dynamic(DynamicForwarder),
}

impl ActiveForwarder {
    /// Read a live snapshot of this forwarder's traffic / connection counters.
    pub fn get_stats(&self) -> TunnelStats {
        match self {
            ActiveForwarder::Local(f) => f.get_stats(),
            ActiveForwarder::Remote(f) => f.get_stats(),
            ActiveForwarder::Dynamic(f) => f.get_stats(),
        }
    }

    /// Take the forwarder's death receiver (once) for a supervisor to select on.
    ///
    /// Returns `None` if it has already been taken. Used by the desktop tunnel
    /// supervisor; the agent tears down via `Drop` and does not call this.
    pub fn take_death_signal(&mut self) -> Option<tokio::sync::oneshot::Receiver<()>> {
        match self {
            ActiveForwarder::Local(f) => f.take_death_signal(),
            ActiveForwarder::Remote(f) => f.take_death_signal(),
            ActiveForwarder::Dynamic(f) => f.take_death_signal(),
        }
    }

    /// Stop the forwarder, aborting its task and releasing SSH resources.
    pub fn stop(&mut self) {
        match self {
            ActiveForwarder::Local(f) => f.stop(),
            ActiveForwarder::Remote(f) => f.stop(),
            ActiveForwarder::Dynamic(f) => f.stop(),
        }
    }
}
