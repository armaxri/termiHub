use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use crate::handler::dispatch::Dispatcher;
use crate::protocol::errors;
use crate::protocol::messages::{JsonRpcErrorResponse, JsonRpcNotification, JsonRpcRequest};

/// Maximum message size: 1 MiB as defined by the protocol spec.
const MAX_LINE_SIZE: usize = 1_048_576;

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
    dispatcher: &mut Dispatcher,
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
                    let err = JsonRpcErrorResponse::new(
                        serde_json::Value::Null,
                        errors::PARSE_ERROR,
                        "Message exceeds 1 MiB size limit",
                    );
                    write_json(writer, &serde_json::to_value(&err)?).await?;
                    continue;
                }

                debug!("Received: {}", trimmed);

                let request: JsonRpcRequest = match serde_json::from_str(trimmed) {
                    Ok(r) => r,
                    Err(e) => {
                        warn!("Failed to parse JSON-RPC request: {e}");
                        let err = JsonRpcErrorResponse::new(
                            serde_json::Value::Null,
                            errors::PARSE_ERROR,
                            format!("Parse error: {e}"),
                        );
                        write_json(writer, &serde_json::to_value(&err)?).await?;
                        continue;
                    }
                };

                if request.jsonrpc != "2.0" {
                    let err = JsonRpcErrorResponse::new(
                        request.id,
                        errors::INVALID_REQUEST,
                        "Invalid JSON-RPC version (must be \"2.0\")",
                    );
                    write_json(writer, &serde_json::to_value(&err)?).await?;
                    continue;
                }

                let result = dispatcher.dispatch(request).await;
                let response_json = result.to_json();
                debug!("Sending: {}", response_json);
                write_json(writer, &response_json).await?;
            }

            Some(notification) = notification_rx.recv() => {
                let json = serde_json::to_value(&notification)?;
                debug!("Sending notification: {}", json);
                write_json(writer, &json).await?;
            }
        }
    }

    Ok(())
}

/// Write a JSON value as an NDJSON line to the writer.
pub async fn write_json<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    value: &serde_json::Value,
) -> anyhow::Result<()> {
    let mut line = serde_json::to_string(value)?;
    line.push('\n');
    writer.write_all(line.as_bytes()).await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn write_json_appends_newline() {
        let mut buf: Vec<u8> = Vec::new();
        let value = serde_json::json!({"jsonrpc": "2.0", "result": {}, "id": 1});
        write_json(&mut buf, &value).await.unwrap();
        let output = String::from_utf8(buf).unwrap();
        assert!(output.ends_with('\n'));
        assert_eq!(output.matches('\n').count(), 1);
        let parsed: serde_json::Value = serde_json::from_str(output.trim_end()).unwrap();
        assert_eq!(parsed["id"], 1);
    }
}
