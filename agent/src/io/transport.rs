use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use crate::handler::dispatch::AgentHandler;
use crate::protocol::messages::JsonRpcNotification;

/// Maximum message size: 1 MiB as defined by the protocol spec.
const MAX_LINE_SIZE: usize = 1_048_576;

/// Sent when a message exceeds the size limit; jsonrpc id is null because we
/// cannot parse the id from an oversized message.
const SIZE_LIMIT_ERROR: &str = r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Message exceeds 1 MiB size limit"}}"#;

/// Sender half for backend tasks to emit notifications.
pub type NotificationSender = tokio::sync::mpsc::UnboundedSender<JsonRpcNotification>;

/// Run the NDJSON transport loop over arbitrary async reader/writer.
///
/// Reads JSON-RPC messages from `reader` (one per line) and writes
/// responses to `writer`. Backend notifications are interleaved via
/// `tokio::select!`. The loop exits when the reader reaches EOF,
/// the cancellation token is triggered, or an I/O error occurs.
pub async fn run_transport_loop<R, W>(
    reader: &mut R,
    writer: &mut W,
    handler: &AgentHandler,
    notification_rx: &mut tokio::sync::mpsc::UnboundedReceiver<JsonRpcNotification>,
    shutdown: CancellationToken,
) -> anyhow::Result<()>
where
    R: AsyncBufReadExt + Unpin,
    W: AsyncWriteExt + Unpin,
{
    let mut line = String::new();

    loop {
        line.clear();

        tokio::select! {
            _ = shutdown.cancelled() => {
                debug!("Shutdown signal received, exiting transport loop");
                break;
            }

            result = reader.read_line(&mut line) => {
                let bytes_read = result?;
                if bytes_read == 0 {
                    debug!("Reader closed (EOF), exiting transport loop");
                    break;
                }

                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                if trimmed.len() > MAX_LINE_SIZE {
                    warn!("Message exceeds 1 MiB limit ({} bytes)", trimmed.len());
                    write_line(writer, SIZE_LIMIT_ERROR).await?;
                    continue;
                }

                debug!("Received: {}", trimmed);

                let (response, should_shutdown) = handler.call_raw(trimmed).await;
                debug!("Sending: {}", response);
                write_line(writer, &response).await?;

                if should_shutdown {
                    debug!("agent.shutdown handled, exiting transport loop");
                    break;
                }
            }

            Some(notification) = notification_rx.recv() => {
                let json = serde_json::to_string(&notification)?;
                debug!("Sending notification: {}", json);
                write_line(writer, &json).await?;
            }
        }
    }

    Ok(())
}

/// Write a pre-serialised JSON string as an NDJSON line to the writer.
///
/// Delegates to the shared [`termihub_core::ipc::write_line`] framing helper so
/// the desktop spawn IPC and the agent transport share one NDJSON writer (#1386).
pub async fn write_line<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    json: &str,
) -> anyhow::Result<()> {
    termihub_core::ipc::write_line(writer, json).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn write_line_appends_newline() {
        let mut buf: Vec<u8> = Vec::new();
        let json = r#"{"jsonrpc":"2.0","result":{},"id":1}"#;
        write_line(&mut buf, json).await.unwrap();
        let output = String::from_utf8(buf).unwrap();
        assert!(output.ends_with('\n'));
        assert_eq!(output.matches('\n').count(), 1);
        let parsed: serde_json::Value = serde_json::from_str(output.trim_end()).unwrap();
        assert_eq!(parsed["id"], 1);
    }
}
