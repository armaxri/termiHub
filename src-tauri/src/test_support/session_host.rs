//! A minimal stateful agent session host for [`FakeAgent`](super::FakeAgent)
//! (#5372).
//!
//! The scripted steps of the fake answer one call at a time. The reconnect
//! redrive suites need an agent with *state* instead: a transport that goes
//! down and comes back, a cold reattach that can be refused, and the sessions
//! it minted, which `list_sessions` reports as recoverable after a reconnect
//! until the agent "loses" them. [`SessionHost`] is that state; a
//! [`FakeAgent::session_host`](super::FakeAgent::session_host) answers the
//! unscripted transport and session calls from it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::terminal::agent_manager::AgentSessionInfo;
use crate::utils::errors::TerminalError;

/// The transport and session state of a [`FakeAgent::session_host`].
///
/// [`FakeAgent::session_host`]: super::FakeAgent::session_host
pub(crate) struct SessionHost {
    /// Whether the agent transport is up (`is_connected`). `connect_agent` and
    /// a successful `reconnect_retained_agent` set it.
    pub(crate) connected: AtomicBool,
    /// Whether a cold reconnect (`reconnect_retained_agent`) can re-establish
    /// a dropped transport.
    pub(crate) reattach_ok: AtomicBool,
    /// Whether the minted sessions survived a drop. When `false`,
    /// `list_sessions` answers empty, as after an agent restart.
    pub(crate) session_recoverable: AtomicBool,
    /// The session ids `create_session` minted, in order.
    minted: Mutex<Vec<String>>,
}

impl Default for SessionHost {
    fn default() -> Self {
        Self {
            connected: AtomicBool::new(true),
            reattach_ok: AtomicBool::new(true),
            session_recoverable: AtomicBool::new(true),
            minted: Mutex::new(Vec::new()),
        }
    }
}

impl SessionHost {
    /// The session ids minted so far, in order (`remote-0`, `remote-1`, …).
    pub(crate) fn minted(&self) -> Vec<String> {
        self.minted.lock().unwrap().clone()
    }

    pub(crate) fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    pub(crate) fn connect(&self) {
        self.connected.store(true, Ordering::SeqCst);
    }

    /// A cold reconnect: a no-op while connected; otherwise it comes back only
    /// while `reattach_ok` is set.
    pub(crate) fn reconnect(&self) -> Result<(), TerminalError> {
        if self.is_connected() {
            return Ok(());
        }
        if self.reattach_ok.load(Ordering::SeqCst) {
            self.connect();
            Ok(())
        } else {
            Err(TerminalError::RemoteError("transport down".into()))
        }
    }

    /// Mint `remote-{n}`, refused while the transport is down.
    pub(crate) fn create(&self, session_type: &str) -> Result<AgentSessionInfo, TerminalError> {
        if !self.is_connected() {
            return Err(TerminalError::RemoteError("Agent not connected".into()));
        }
        let mut minted = self.minted.lock().unwrap();
        let session_id = format!("remote-{}", minted.len());
        minted.push(session_id.clone());
        Ok(session(session_id, session_type))
    }

    /// The minted sessions while they are recoverable, else none.
    pub(crate) fn list(&self) -> Vec<AgentSessionInfo> {
        if !self.session_recoverable.load(Ordering::SeqCst) {
            return vec![];
        }
        self.minted()
            .into_iter()
            .map(|id| session(id, "local"))
            .collect()
    }
}

fn session(session_id: String, session_type: &str) -> AgentSessionInfo {
    AgentSessionInfo {
        session_id,
        title: "Shell".into(),
        session_type: session_type.into(),
        status: "running".into(),
        attached: false,
        definition_id: None,
    }
}
