//! The daemon's [`MSG_EXITED`] carries why the backend's link ended (#5732):
//! a backend whose server closed the connection reports `RemoteClosed` in the
//! frame's end-cause byte, so the agent can tell the desktop "closed by
//! server" instead of "connection lost". A kill carries no cause.
//!
//! It also carries the process's real exit status (#5742): a shell the user
//! exited reports its status, so the desktop ends the tab instead of
//! reconnecting it.

use std::time::Duration;

use termihub_core::connection::{
    Capabilities, ConnectionType, OutputReceiver, SessionEndCause, SettingsSchema,
};
use termihub_core::errors::SessionError;

use super::write_bound_tests::{spawn_daemon_with, Attach, Worker};
use crate::daemon::protocol::{self, INTENT_TAKEOVER, MSG_EXITED, MSG_KILL};

/// A backend whose link already ended with `cause` — what the SSH backend
/// reports once its server closed the shell channel.
struct EndedConnection {
    cause: Option<SessionEndCause>,
    /// The process's exit status, as a local shell reports it (#5742).
    status: Option<i32>,
}

#[async_trait::async_trait]
impl ConnectionType for EndedConnection {
    fn type_id(&self) -> &str {
        "ended"
    }
    fn display_name(&self) -> &str {
        "Ended"
    }
    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema { groups: vec![] }
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: false,
            graphical: false,
            resize: true,
            persistent: true,
            terminal: true,
            tunneling: false,
        }
    }
    async fn connect(&mut self, _settings: serde_json::Value) -> Result<(), SessionError> {
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<(), SessionError> {
        Ok(())
    }
    fn is_connected(&self) -> bool {
        true
    }
    fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
        Ok(())
    }
    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        Ok(())
    }
    fn subscribe_output(&self) -> OutputReceiver {
        let (_tx, rx) = tokio::sync::mpsc::channel(1);
        rx
    }
    fn monitoring(&self) -> Option<&dyn termihub_core::monitoring::MonitoringProvider> {
        None
    }
    fn file_browser(&self) -> Option<&dyn termihub_core::files::FileBrowser> {
        None
    }
    fn end_cause(&self) -> Option<SessionEndCause> {
        self.cause
    }
    fn exit_code(&self) -> Option<i32> {
        self.status
    }
}

/// Read frames until the daemon's [`MSG_EXITED`] and return its payload.
async fn exited_payload(worker: &mut Worker) -> Vec<u8> {
    let read = async {
        loop {
            let frame = protocol::read_frame_async(&mut worker.reader)
                .await
                .expect("read a frame")
                .expect("the daemon sends MSG_EXITED before it closes");
            if frame.msg_type == MSG_EXITED {
                return frame.payload;
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(20), read)
        .await
        .expect("MSG_EXITED within the deadline")
}

#[tokio::test]
async fn a_natural_end_reports_the_backends_cause() {
    let daemon = spawn_daemon_with(Box::new(EndedConnection {
        cause: Some(SessionEndCause::RemoteClosed),
        status: None,
    }));
    let mut worker = Worker::connect(&daemon, INTENT_TAKEOVER).await;
    assert_eq!(worker.handshake().await, Some(Attach::Ready(Vec::new())));

    // The backend's output channel closes: its link ended on its own.
    drop(daemon.output);
    let payload = exited_payload(&mut worker).await;

    assert_eq!(protocol::decode_exit_code(&payload), Some(0));
    assert_eq!(
        protocol::decode_end_cause(&payload),
        Some(SessionEndCause::RemoteClosed)
    );
}

#[tokio::test]
async fn a_natural_end_without_a_known_cause_keeps_the_legacy_payload() {
    let daemon = spawn_daemon_with(Box::new(EndedConnection {
        cause: None,
        status: None,
    }));
    let mut worker = Worker::connect(&daemon, INTENT_TAKEOVER).await;
    assert_eq!(worker.handshake().await, Some(Attach::Ready(Vec::new())));

    drop(daemon.output);
    let payload = exited_payload(&mut worker).await;

    assert_eq!(payload, protocol::encode_exit_code(0).to_vec());
}

#[tokio::test]
async fn a_kill_reports_no_cause() {
    // Even a backend that would report a cause: a kill is deliberate.
    let daemon = spawn_daemon_with(Box::new(EndedConnection {
        cause: Some(SessionEndCause::IoError),
        status: Some(1),
    }));
    let mut worker = Worker::connect(&daemon, INTENT_TAKEOVER).await;
    assert_eq!(worker.handshake().await, Some(Attach::Ready(Vec::new())));

    protocol::write_frame_async(&mut worker.writer, MSG_KILL, &[])
        .await
        .expect("send kill");
    let payload = exited_payload(&mut worker).await;

    assert_eq!(protocol::decode_end_cause(&payload), None);
    assert_eq!(protocol::decode_exit_status(&payload), None);
}

#[tokio::test]
async fn a_shell_that_exits_on_its_own_reports_its_real_status() {
    for status in [0, 3] {
        let daemon = spawn_daemon_with(Box::new(EndedConnection {
            cause: None,
            status: Some(status),
        }));
        let mut worker = Worker::connect(&daemon, INTENT_TAKEOVER).await;
        assert_eq!(worker.handshake().await, Some(Attach::Ready(Vec::new())));

        drop(daemon.output);
        let payload = exited_payload(&mut worker).await;

        assert_eq!(protocol::decode_exit_status(&payload), Some(status));
        assert_eq!(protocol::decode_exit_code(&payload), Some(status));
        assert_eq!(protocol::decode_end_cause(&payload), None);
    }
}
