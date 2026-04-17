//! Transport adapters bridging core traits to agent infrastructure.
//!
//! These implementations complete the "transport injection" pattern where the
//! core defines *what* to do and the agent injects *how*:
//!
//! - [`JsonRpcOutputSink`] delivers session output via JSON-RPC notifications.
//! - [`DaemonSpawner`] spawns processes through daemon processes with Unix
//!   socket IPC.

use base64::Engine;

use crate::io::transport::NotificationSender;
use crate::protocol::messages::JsonRpcNotification;
use termihub_core::errors::SessionError;
use termihub_core::session::traits::OutputSink;

/// Delivers terminal output via JSON-RPC notifications.
///
/// Wraps the agent's notification channel (`NotificationSender`) and
/// implements the core [`OutputSink`] trait. Each method constructs
/// a JSON-RPC notification and sends it through the transport loop.
pub struct JsonRpcOutputSink {
    notification_tx: NotificationSender,
}

impl JsonRpcOutputSink {
    /// Create a new output sink backed by the given notification channel.
    pub fn new(notification_tx: NotificationSender) -> Self {
        Self { notification_tx }
    }
}

impl OutputSink for JsonRpcOutputSink {
    fn send_output(&self, session_id: &str, data: Vec<u8>) -> Result<(), SessionError> {
        let b64 = base64::engine::general_purpose::STANDARD;
        // Chunk large payloads to stay under the 1 MiB NDJSON line limit.
        for chunk in data.chunks(65536) {
            let encoded = b64.encode(chunk);
            let notification = JsonRpcNotification::new(
                "connection.output",
                serde_json::json!({
                    "session_id": session_id,
                    "data": encoded,
                }),
            );
            self.notification_tx.send(notification).map_err(|e| {
                SessionError::Io(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    format!("notification channel closed: {e}"),
                ))
            })?;
        }
        Ok(())
    }

    fn send_exit(&self, session_id: &str, exit_code: Option<i32>) -> Result<(), SessionError> {
        let notification = JsonRpcNotification::new(
            "connection.exit",
            serde_json::json!({
                "session_id": session_id,
                "exit_code": exit_code,
            }),
        );
        self.notification_tx.send(notification).map_err(|e| {
            SessionError::Io(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                format!("notification channel closed: {e}"),
            ))
        })?;
        Ok(())
    }

    fn send_error(&self, session_id: &str, message: &str) -> Result<(), SessionError> {
        let notification = JsonRpcNotification::new(
            "connection.error",
            serde_json::json!({
                "session_id": session_id,
                "message": message,
            }),
        );
        self.notification_tx.send(notification).map_err(|e| {
            SessionError::Io(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                format!("notification channel closed: {e}"),
            ))
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- JsonRpcOutputSink tests ------------------------------------------

    #[test]
    fn output_sink_send_output() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let sink = JsonRpcOutputSink::new(tx);

        sink.send_output("s1", b"hello".to_vec()).unwrap();

        let notification = rx.try_recv().unwrap();
        assert_eq!(notification.method, "connection.output");
        assert_eq!(notification.params["session_id"], "s1");
        // Output should be base64-encoded
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(notification.params["data"].as_str().unwrap())
            .unwrap();
        assert_eq!(decoded, b"hello");
    }

    #[test]
    fn output_sink_send_output_chunks_large_payloads() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let sink = JsonRpcOutputSink::new(tx);

        // Create data larger than 65536 chunk size
        let data = vec![0xAA; 65536 + 100];
        sink.send_output("s1", data.clone()).unwrap();

        // Should receive two notifications (one full chunk + one remainder)
        let n1 = rx.try_recv().unwrap();
        let n2 = rx.try_recv().unwrap();
        assert!(rx.try_recv().is_err());

        let d1 = base64::engine::general_purpose::STANDARD
            .decode(n1.params["data"].as_str().unwrap())
            .unwrap();
        let d2 = base64::engine::general_purpose::STANDARD
            .decode(n2.params["data"].as_str().unwrap())
            .unwrap();
        assert_eq!(d1.len(), 65536);
        assert_eq!(d2.len(), 100);
    }

    #[test]
    fn output_sink_send_exit_with_code() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let sink = JsonRpcOutputSink::new(tx);

        sink.send_exit("s1", Some(0)).unwrap();

        let notification = rx.try_recv().unwrap();
        assert_eq!(notification.method, "connection.exit");
        assert_eq!(notification.params["session_id"], "s1");
        assert_eq!(notification.params["exit_code"], 0);
    }

    #[test]
    fn output_sink_send_exit_without_code() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let sink = JsonRpcOutputSink::new(tx);

        sink.send_exit("s1", None).unwrap();

        let notification = rx.try_recv().unwrap();
        assert_eq!(notification.method, "connection.exit");
        assert_eq!(notification.params["session_id"], "s1");
        assert!(notification.params["exit_code"].is_null());
    }

    #[test]
    fn output_sink_send_error() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let sink = JsonRpcOutputSink::new(tx);

        sink.send_error("s1", "read failed").unwrap();

        let notification = rx.try_recv().unwrap();
        assert_eq!(notification.method, "connection.error");
        assert_eq!(notification.params["session_id"], "s1");
        assert_eq!(notification.params["message"], "read failed");
    }

    #[test]
    fn output_sink_closed_channel_returns_error() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        drop(rx); // Close the receiver
        let sink = JsonRpcOutputSink::new(tx);

        let result = sink.send_output("s1", b"data".to_vec());
        assert!(result.is_err());
    }

    #[test]
    fn output_sink_is_send() {
        fn assert_send<T: Send + 'static>() {}
        assert_send::<JsonRpcOutputSink>();
    }

    #[test]
    fn output_sink_is_object_safe() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let sink: Box<dyn OutputSink> = Box::new(JsonRpcOutputSink::new(tx));
        sink.send_output("s1", b"data".to_vec()).unwrap();
    }
}
