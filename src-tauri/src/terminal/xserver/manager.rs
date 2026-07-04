//! The X server lifecycle manager (state holder + idle-shutdown refcount).
//!
//! In this issue (#1052) the manager is the **seam** the Windows lifecycle work
//! (#1049) fills: it records a termiHub-started server and exposes it to the
//! core SSH detection path via [`ManagedXServerSource`]. Actual spawning /
//! supervision / termination of `vcxsrv.exe` is out of scope here — [`stop`] and
//! [`set_managed`] only mutate the recorded state. Until #1049 lands,
//! [`managed_server`](Self::managed_server) returns `None` and detection falls
//! back to a user-run server, so nothing regresses.

use std::sync::{Arc, Mutex};

use termihub_core::backends::ssh::x11::{ManagedXServer, ManagedXServerSource};

use super::types::XServerState;

/// Internal, lock-guarded manager state.
struct ManagerState {
    /// The termiHub-started server, once #1049 spawns one. `None` means no
    /// managed server (external servers are found by detection, not recorded
    /// here).
    managed: Option<ManagedXServer>,
    /// Active X11 sessions using the server (drives idle shutdown when it hits 0).
    session_count: u32,
    /// Last known lifecycle state, for reporting by the download/launch stages.
    lifecycle: XServerState,
}

/// Cheaply-cloneable handle to the shared X server state.
///
/// Managed as Tauri state and simultaneously registered as the core
/// [`ManagedXServerSource`], so the SSH connect path and the command layer see
/// the same server.
#[derive(Clone)]
pub struct XServerManager {
    inner: Arc<Mutex<ManagerState>>,
}

impl Default for XServerManager {
    fn default() -> Self {
        Self::new()
    }
}

impl XServerManager {
    /// Create an empty manager (no managed server, zero sessions).
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(ManagerState {
                managed: None,
                session_count: 0,
                lifecycle: XServerState::Absent,
            })),
        }
    }

    /// Record a termiHub-started server (called by the Windows lifecycle
    /// manager, #1049, after a successful spawn).
    // Seam for #1049 — no production caller yet; exercised by unit tests.
    #[allow(dead_code)]
    pub fn set_managed(&self, server: ManagedXServer) {
        if let Ok(mut state) = self.inner.lock() {
            state.managed = Some(server);
            state.lifecycle = XServerState::Running;
        }
    }

    /// Whether a termiHub-managed server is currently recorded.
    pub fn has_managed_server(&self) -> bool {
        self.inner
            .lock()
            .map(|s| s.managed.is_some())
            .unwrap_or(false)
    }

    /// Increment the session refcount when an X11 session starts using the
    /// server. Returns the new count.
    // Seam for #1049 idle-shutdown refcounting; exercised by unit tests.
    #[allow(dead_code)]
    pub fn register_session(&self) -> u32 {
        match self.inner.lock() {
            Ok(mut state) => {
                state.session_count = state.session_count.saturating_add(1);
                state.session_count
            }
            Err(_) => 0,
        }
    }

    /// Decrement the session refcount when an X11 session closes. Returns the
    /// new count; the caller shuts the managed server down when it reaches 0 and
    /// `stopXServerWhenIdle` is on (#1049).
    // Seam for #1049 idle-shutdown refcounting; exercised by unit tests.
    #[allow(dead_code)]
    pub fn unregister_session(&self) -> u32 {
        match self.inner.lock() {
            Ok(mut state) => {
                state.session_count = state.session_count.saturating_sub(1);
                state.session_count
            }
            Err(_) => 0,
        }
    }

    /// The current session refcount.
    pub fn session_count(&self) -> u32 {
        self.inner.lock().map(|s| s.session_count).unwrap_or(0)
    }

    /// The recorded lifecycle state.
    // Reported by #1048/#1049 provisioning stages; exercised by unit tests.
    #[allow(dead_code)]
    pub fn lifecycle(&self) -> XServerState {
        self.inner
            .lock()
            .map(|s| s.lifecycle)
            .unwrap_or(XServerState::Absent)
    }

    /// Stop and forget any managed server.
    ///
    /// Process termination is the lifecycle manager's job (#1049); here we only
    /// clear the recorded state so detection stops reporting it.
    pub fn stop(&self) {
        if let Ok(mut state) = self.inner.lock() {
            state.managed = None;
            state.session_count = 0;
            state.lifecycle = XServerState::Stopped;
        }
    }
}

impl ManagedXServerSource for XServerManager {
    fn managed_server(&self) -> Option<ManagedXServer> {
        self.inner.lock().ok().and_then(|s| s.managed.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_manager_has_no_server_and_zero_sessions() {
        let mgr = XServerManager::new();
        assert!(!mgr.has_managed_server());
        assert_eq!(mgr.session_count(), 0);
        assert_eq!(mgr.lifecycle(), XServerState::Absent);
        assert!(mgr.managed_server().is_none());
    }

    #[test]
    fn set_managed_exposes_server_to_detection_source() {
        let mgr = XServerManager::new();
        mgr.set_managed(ManagedXServer {
            display_number: 0,
            cookie: Some("abc123".to_string()),
        });
        assert!(mgr.has_managed_server());
        assert_eq!(mgr.lifecycle(), XServerState::Running);
        let server = mgr.managed_server().expect("server recorded");
        assert_eq!(server.display_number, 0);
        assert_eq!(server.cookie.as_deref(), Some("abc123"));
    }

    #[test]
    fn session_refcount_increments_and_decrements() {
        let mgr = XServerManager::new();
        assert_eq!(mgr.register_session(), 1);
        assert_eq!(mgr.register_session(), 2);
        assert_eq!(mgr.unregister_session(), 1);
        assert_eq!(mgr.unregister_session(), 0);
        // Never underflows below zero.
        assert_eq!(mgr.unregister_session(), 0);
    }

    #[test]
    fn stop_clears_managed_server_and_sessions() {
        let mgr = XServerManager::new();
        mgr.set_managed(ManagedXServer {
            display_number: 1,
            cookie: None,
        });
        mgr.register_session();
        mgr.stop();
        assert!(!mgr.has_managed_server());
        assert_eq!(mgr.session_count(), 0);
        assert_eq!(mgr.lifecycle(), XServerState::Stopped);
    }

    #[test]
    fn clone_shares_state() {
        let mgr = XServerManager::new();
        let clone = mgr.clone();
        clone.set_managed(ManagedXServer {
            display_number: 5,
            cookie: None,
        });
        // The original sees the mutation through the shared Arc.
        assert!(mgr.has_managed_server());
        assert_eq!(mgr.managed_server().unwrap().display_number, 5);
    }
}
