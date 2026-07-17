use std::io;

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
    // Bytes of a not-yet-complete NDJSON line, carried across loop iterations.
    // Because it lives *outside* the `select!` future, it survives that future
    // being dropped when the notification branch wins the race — see
    // [`read_ndjson_line`] for why that matters (#1559).
    let mut pending: Vec<u8> = Vec::new();

    loop {
        tokio::select! {
            _ = shutdown.cancelled() => {
                debug!("Shutdown signal received, exiting transport loop");
                break;
            }

            result = read_ndjson_line(reader, &mut pending) => {
                let Some(line) = result? else {
                    debug!("Reader closed (EOF), exiting transport loop");
                    break;
                };

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

/// Read one newline-delimited line, **cancellation-safe** in a `select!`.
///
/// This exists because [`AsyncBufReadExt::read_line`] is *not* cancellation
/// safe: when it is used as a `select!` branch and another branch (here, an
/// outbound notification) completes first, the bytes it has already consumed
/// from the reader are appended to its output buffer and then lost — silently
/// dropping the front of an in-flight request. Under a client that fragments a
/// request across several TCP segments (and any request can be split under
/// load), the surviving tail is then parsed as its own frame, e.g. a bare
/// `"id"` where a `Request` struct was expected. That is the #1559 flake: rare
/// locally, but a hard failure whenever a notification races a partially
/// received `connection.close`.
///
/// The fix is to keep the partial-line accumulator (`pending`) *outside* the
/// future and to only ever `await` on [`AsyncBufReadExt::fill_buf`], which is
/// cancellation safe — it never consumes bytes it does not hand back. Bytes are
/// `consume`d synchronously, with no intervening await, so cancelling this
/// future can never lose data: whatever was consumed is already in `pending`.
///
/// Returns `Ok(Some(line))` for a complete line (without the trailing newline),
/// or `Ok(None)` at EOF with no buffered bytes.
async fn read_ndjson_line<R>(reader: &mut R, pending: &mut Vec<u8>) -> io::Result<Option<String>>
where
    R: AsyncBufReadExt + Unpin,
{
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            // EOF. A trailing line without a newline is still delivered once;
            // an empty accumulator means a clean close.
            if pending.is_empty() {
                return Ok(None);
            }
            let line = String::from_utf8(std::mem::take(pending))
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            return Ok(Some(line));
        }

        if let Some(idx) = available.iter().position(|&b| b == b'\n') {
            pending.extend_from_slice(&available[..idx]);
            reader.consume(idx + 1);
            let line = String::from_utf8(std::mem::take(pending))
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            return Ok(Some(line));
        }

        // No newline yet: keep the whole chunk and read more. `available` is a
        // borrow of the reader, so copy its length before consuming.
        let len = available.len();
        pending.extend_from_slice(available);
        reader.consume(len);
    }
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
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::io::{AsyncWriteExt, BufReader};

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

    /// [`read_ndjson_line`] reassembles a request delivered in several chunks.
    #[tokio::test]
    async fn read_ndjson_line_reassembles_fragmented_line() {
        let (mut client, server) = tokio::io::duplex(1024);
        let mut reader = BufReader::new(server);
        let mut pending = Vec::new();

        client.write_all(b"{\"a\":1").await.unwrap();
        client.write_all(b",\"b\":2}\n").await.unwrap();

        let line = read_ndjson_line(&mut reader, &mut pending)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(line, r#"{"a":1,"b":2}"#);
        assert!(
            pending.is_empty(),
            "accumulator must be drained after a line"
        );
    }

    /// The #1559 mechanism, isolated: a partially received line must survive
    /// [`read_ndjson_line`]'s future being **dropped** mid-read (as happens when
    /// a `select!` notification branch wins). Simulated by letting a `sleep`
    /// branch win the race while only the first fragment has arrived, then
    /// delivering the rest. With the old non-cancellation-safe `read_line`, the
    /// consumed prefix would be lost and the tail would frame as a bad request.
    #[tokio::test]
    async fn read_ndjson_line_is_cancellation_safe() {
        let (mut client, server) = tokio::io::duplex(1024);
        let mut reader = BufReader::new(server);
        let mut pending = Vec::new();

        // Only the front of the request is on the wire, with no newline.
        client
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"conn")
            .await
            .unwrap();

        // A concurrent branch wins the race and cancels the in-flight read.
        tokio::select! {
            _ = read_ndjson_line(&mut reader, &mut pending) => {
                panic!("read must not complete before the newline arrives");
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }

        // The consumed prefix is preserved across the cancellation.
        assert_eq!(pending, b"{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"conn");

        // The rest of the line arrives; the full request reassembles intact.
        client
            .write_all(b"ection.close\",\"params\":{}}\n")
            .await
            .unwrap();
        let line = read_ndjson_line(&mut reader, &mut pending)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            line,
            r#"{"jsonrpc":"2.0","id":7,"method":"connection.close","params":{}}"#
        );
        let parsed: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed["method"], "connection.close");
    }

    /// End-to-end regression for #1559 at the transport-loop level: a request
    /// split across the wire while an outbound notification is delivered must
    /// still be dispatched correctly. On the pre-fix loop the racing
    /// notification cancelled `read_line`, dropped the consumed prefix, and the
    /// surviving tail was rejected as `invalid type: string, expected struct
    /// Request` — the session never closed and the client saw a `null`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn split_request_survives_racing_notification() {
        use crate::handler::dispatch::AgentHandler;
        use crate::monitoring::{MonitoringManager, MonitoringManagerApi};
        use crate::session::definitions::{ConnectionStore, ConnectionStoreApi};
        use crate::session::manager::{SessionManager, SessionManagerApi};

        let (notif_tx, mut notif_rx) = tokio::sync::mpsc::unbounded_channel();
        let tmp =
            std::env::temp_dir().join(format!("termihub-transport-{}.json", uuid::Uuid::new_v4()));
        let conn_store = Arc::new(ConnectionStore::new_temp(tmp));
        let registry = Arc::new(crate::registry::build_registry());
        let session_manager = Arc::new(SessionManager::new(notif_tx.clone(), registry));
        let monitoring = Arc::new(MonitoringManager::new(notif_tx.clone(), conn_store.clone()));
        let handler = AgentHandler::new(
            session_manager as Arc<dyn SessionManagerApi>,
            conn_store as Arc<dyn ConnectionStoreApi>,
            monitoring as Arc<dyn MonitoringManagerApi>,
        )
        .unwrap();

        let (client, server) = tokio::io::duplex(64 * 1024);
        let (server_rd, mut server_wr) = tokio::io::split(server);
        let (mut client_rd, mut client_wr) = tokio::io::split(client);
        let mut reader = BufReader::new(server_rd);

        let shutdown = CancellationToken::new();
        let loop_shutdown = shutdown.clone();
        let loop_handle: tokio::task::JoinHandle<anyhow::Result<()>> = tokio::spawn(async move {
            run_transport_loop(
                &mut reader,
                &mut server_wr,
                &handler,
                &mut notif_rx,
                loop_shutdown,
            )
            .await
        });

        // Send the front half of a valid `initialize` request — no newline yet.
        let request = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"0.1.0","client":"t","clientVersion":"0.1.0"}}"#;
        let bytes = request.as_bytes();
        let split = bytes.len() / 2;
        client_wr.write_all(&bytes[..split]).await.unwrap();

        // Let the loop consume the prefix and park on the next read.
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Race an outbound notification against the parked read.
        notif_tx
            .send(JsonRpcNotification::new(
                "test.event",
                serde_json::json!({"seq": 1}),
            ))
            .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Deliver the rest of the request.
        client_wr.write_all(&bytes[split..]).await.unwrap();
        client_wr.write_all(b"\n").await.unwrap();

        // Read the agent's output lines until the `initialize` response for id 1
        // arrives (the notification line is interleaved and simply skipped). A
        // real `result` proves the split request was reassembled intact despite
        // the racing notification; on the pre-fix loop the request was corrupted
        // and no such response is ever produced.
        let mut lines = BufReader::new(&mut client_rd);
        let got_result = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let mut line = String::new();
                let n = lines.read_line(&mut line).await.unwrap();
                if n == 0 {
                    return false;
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) {
                    if v["id"] == serde_json::json!(1) && v.get("result").is_some() {
                        return true;
                    }
                }
            }
        })
        .await
        .unwrap_or(false);

        assert!(
            got_result,
            "initialize response was lost/corrupted by the racing notification"
        );

        shutdown.cancel();
        let _ = loop_handle.await;
    }
}
