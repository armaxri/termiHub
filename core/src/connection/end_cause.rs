//! Why a session's link ended on its own (#5696).
//!
//! The session owner only learns that a session ended when its output channel
//! closes, and a dropped link carries no exit code. Without a cause the
//! frontend could not tell a telnet server that closed the connection cleanly
//! from a broken network link, and wrote "connection lost" for both. A backend
//! records the cause here *before* it ends the output channel, and the session
//! owner reads it back through
//! [`ConnectionType::end_cause`](super::ConnectionType::end_cause) when it emits
//! the exit event.

use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};

/// Why a session's link ended on its own.
///
/// Serialised `snake_case` (`"remote_closed"`, `"io_error"`, `"timeout"`,
/// `"device_gone"`) for the `terminal-exit` event.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "snake_case")]
pub enum SessionEndCause {
    /// The server ended the connection cleanly: TCP end-of-stream on telnet,
    /// the SSH server closing the shell channel.
    RemoteClosed,
    /// A read or write on the link failed (reset, broken pipe, transport gone).
    IoError,
    /// The link timed out, e.g. the peer failed the TCP keepalive probes.
    Timeout,
    /// The device behind the session went away (#5783): an unplugged serial
    /// port, or a serial port whose in-place reopen on a remote agent gave up.
    DeviceGone,
}

/// A per-connection slot for the [`SessionEndCause`], shared between the
/// backend's I/O threads and the connection itself.
///
/// The **first** recorded cause wins: a failed write that shuts the socket
/// down is followed by an end-of-stream read, and that read must not turn the
/// failure into a clean close.
#[derive(Clone, Debug, Default)]
pub struct EndCauseSlot(Arc<Mutex<Option<SessionEndCause>>>);

impl EndCauseSlot {
    /// An empty slot.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record `cause` unless a cause is already recorded.
    pub fn record(&self, cause: SessionEndCause) {
        let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.is_none() {
            *slot = Some(cause);
        }
    }

    /// The recorded cause, if any.
    pub fn get(&self) -> Option<SessionEndCause> {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_slot_has_no_cause() {
        assert_eq!(EndCauseSlot::new().get(), None);
    }

    #[test]
    fn first_recorded_cause_wins() {
        let slot = EndCauseSlot::new();
        slot.record(SessionEndCause::IoError);
        slot.record(SessionEndCause::RemoteClosed);
        assert_eq!(slot.get(), Some(SessionEndCause::IoError));
    }

    #[test]
    fn clones_share_the_slot() {
        let slot = EndCauseSlot::new();
        slot.clone().record(SessionEndCause::Timeout);
        assert_eq!(slot.get(), Some(SessionEndCause::Timeout));
    }

    #[test]
    fn serialises_snake_case() {
        let json = |c| serde_json::to_string(&c).unwrap();
        assert_eq!(json(SessionEndCause::RemoteClosed), "\"remote_closed\"");
        assert_eq!(json(SessionEndCause::IoError), "\"io_error\"");
        assert_eq!(json(SessionEndCause::Timeout), "\"timeout\"");
        assert_eq!(json(SessionEndCause::DeviceGone), "\"device_gone\"");
    }
}
