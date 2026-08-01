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

            result = read_ndjson_line(reader, &mut pending, MAX_LINE_SIZE) => {
                let line = match result? {
                    LineOutcome::Eof => {
                        debug!("Reader closed (EOF), exiting transport loop");
                        break;
                    }
                    LineOutcome::TooLarge => {
                        warn!("Message exceeds {} byte limit; rejecting", MAX_LINE_SIZE);
                        write_line(writer, SIZE_LIMIT_ERROR).await?;
                        continue;
                    }
                    LineOutcome::Line(line) => line,
                };

                let trimmed = line.trim();
                if trimmed.is_empty() {
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
/// Outcome of reading one NDJSON line under a size cap.
#[derive(Debug)]
enum LineOutcome {
    /// A complete line — newline-terminated, or a trailing line delivered at
    /// EOF — whose length is within the cap. The trailing newline is stripped.
    Line(String),
    /// The line exceeded the cap. Any buffered bytes were dropped and the rest
    /// of the over-long line was discarded up to (and including) its terminating
    /// newline, so the caller can reject it and keep serving the connection
    /// without ever having buffered the whole thing.
    TooLarge,
    /// Clean EOF with no buffered bytes.
    Eof,
}

/// Read one newline-delimited line, **cancellation-safe** in a `select!` and
/// **bounded** to `max_len` resident bytes.
///
/// The cap is enforced *while reading*, not after: once the current line would
/// exceed `max_len`, `pending` is cleared and subsequent bytes are discarded
/// (never buffered) until the terminating newline. This keeps resident memory at
/// ~`max_len` regardless of how much a peer sends before a newline. A peer that
/// streams bytes without ever sending one used to grow `pending` without limit —
/// the 1 MiB size check ran only in the caller, *after* the whole line had been
/// assembled — which was a memory-exhaustion denial-of-service against a daemon
/// that parses framed bytes straight off a socket (#2352). The sibling binary
/// frame protocol ([`crate::daemon::protocol`]) already rejects an over-limit
/// length before allocating; this brings the NDJSON path in line.
///
/// Returns [`LineOutcome::Line`] for a complete line within the cap,
/// [`LineOutcome::TooLarge`] when the cap was exceeded (bytes discarded to the
/// next newline; the connection may continue), or [`LineOutcome::Eof`] at a
/// clean EOF with no buffered bytes.
///
/// Cancellation safety (the #1559 property) is preserved for lines within the
/// cap: bytes are appended to `pending` before the reader is `consume`d, with no
/// intervening await, so a cancelled future never loses buffered data. In the
/// over-size discard path bytes are dropped rather than retained, but those
/// belong to an already-rejected line, so no valid message is ever lost.
async fn read_ndjson_line<R>(
    reader: &mut R,
    pending: &mut Vec<u8>,
    max_len: usize,
) -> io::Result<LineOutcome>
where
    R: AsyncBufReadExt + Unpin,
{
    // Whether the current line has already crossed the cap. A partial line
    // carried over from a cancelled read is always within the cap, but never
    // trust that blindly.
    let mut over = pending.len() > max_len;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            // EOF.
            if over {
                pending.clear();
                return Ok(LineOutcome::TooLarge);
            }
            // A trailing line without a newline is still delivered once; an
            // empty accumulator means a clean close.
            if pending.is_empty() {
                return Ok(LineOutcome::Eof);
            }
            let line = String::from_utf8(std::mem::take(pending))
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            return Ok(LineOutcome::Line(line));
        }

        if let Some(idx) = available.iter().position(|&b| b == b'\n') {
            // A complete line ends here. If it (or an earlier chunk) crossed the
            // cap, discard it up to and including the newline and report the
            // overflow; otherwise hand it back.
            if over || pending.len().saturating_add(idx) > max_len {
                reader.consume(idx + 1);
                pending.clear();
                return Ok(LineOutcome::TooLarge);
            }
            pending.extend_from_slice(&available[..idx]);
            reader.consume(idx + 1);
            let line = String::from_utf8(std::mem::take(pending))
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            return Ok(LineOutcome::Line(line));
        }

        // No newline yet. Buffer the chunk unless doing so would cross the cap,
        // in which case drop what we have and switch to discard-until-newline
        // mode. `available` is a borrow of the reader, so finish using it before
        // consuming.
        let len = available.len();
        if over {
            // Already discarding: drop this chunk.
        } else if pending.len().saturating_add(len) > max_len {
            over = true;
            pending.clear();
        } else {
            pending.extend_from_slice(available);
        }
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

        let line = match read_ndjson_line(&mut reader, &mut pending, MAX_LINE_SIZE)
            .await
            .unwrap()
        {
            LineOutcome::Line(line) => line,
            other => panic!("expected a complete line, got {other:?}"),
        };
        assert_eq!(line, r#"{"a":1,"b":2}"#);
        assert!(
            pending.is_empty(),
            "accumulator must be drained after a line"
        );
    }

    /// A line larger than the cap, delivered without a newline, must be rejected
    /// as [`LineOutcome::TooLarge`] and never fully buffered — the
    /// memory-exhaustion regression for #2352. Uses a tiny cap and a body many
    /// times larger so the pre-fix unbounded accumulation would have retained
    /// the whole 100 KiB blob.
    #[tokio::test]
    async fn read_ndjson_line_rejects_oversize_line_without_unbounded_buffering() {
        const CAP: usize = 64;
        let (mut client, server) = tokio::io::duplex(64 * 1024);
        let mut reader = BufReader::new(server);
        let mut pending = Vec::new();

        // Stream far more than the cap with no newline, then terminate the line.
        // Written from a task because the reader must drain the pipe concurrently.
        let writer = tokio::spawn(async move {
            client.write_all(&vec![b'x'; 100_000]).await.unwrap();
            client.write_all(b"\n").await.unwrap();
            client // keep the writer alive until the read completes
        });

        let outcome = read_ndjson_line(&mut reader, &mut pending, CAP)
            .await
            .unwrap();
        assert!(
            matches!(outcome, LineOutcome::TooLarge),
            "over-size line must be rejected, got {outcome:?}"
        );
        assert!(
            pending.is_empty(),
            "accumulator must be cleared after an over-size line, not left holding it"
        );
        let _client = writer.await.unwrap();
    }

    /// After an over-size line is rejected, the connection must keep working: a
    /// normal line that follows still parses. Guards the "reject and continue"
    /// contract for #2352.
    #[tokio::test]
    async fn read_ndjson_line_recovers_after_oversize_line() {
        const CAP: usize = 32;
        let (mut client, server) = tokio::io::duplex(64 * 1024);
        let mut reader = BufReader::new(server);
        let mut pending = Vec::new();

        // An over-size line, then a normal one — both newline-terminated.
        client.write_all(&vec![b'A'; 1000]).await.unwrap();
        client.write_all(b"\n").await.unwrap();
        client.write_all(b"{\"ok\":true}\n").await.unwrap();

        let first = read_ndjson_line(&mut reader, &mut pending, CAP)
            .await
            .unwrap();
        assert!(
            matches!(first, LineOutcome::TooLarge),
            "first (over-size) line must be rejected, got {first:?}"
        );

        match read_ndjson_line(&mut reader, &mut pending, CAP)
            .await
            .unwrap()
        {
            LineOutcome::Line(line) => assert_eq!(line, r#"{"ok":true}"#),
            other => panic!("line after an over-size one must still parse, got {other:?}"),
        }
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
            _ = read_ndjson_line(&mut reader, &mut pending, MAX_LINE_SIZE) => {
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
        let line = match read_ndjson_line(&mut reader, &mut pending, MAX_LINE_SIZE)
            .await
            .unwrap()
        {
            LineOutcome::Line(line) => line,
            other => panic!("expected a complete line, got {other:?}"),
        };
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

    /// End-to-end regression for #2352: a message larger than the 1 MiB limit is
    /// rejected with the size-limit error, and the loop keeps serving — a valid
    /// `initialize` sent afterwards still gets a real response. On the pre-fix
    /// loop the over-size line was buffered whole (unbounded) before the limit
    /// was ever checked; here it must be rejected while bounding memory and the
    /// connection must survive.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn oversize_message_is_rejected_and_loop_continues() {
        use crate::handler::dispatch::AgentHandler;
        use crate::monitoring::{MonitoringManager, MonitoringManagerApi};
        use crate::session::definitions::{ConnectionStore, ConnectionStoreApi};
        use crate::session::manager::{SessionManager, SessionManagerApi};

        let (notif_tx, mut notif_rx) = tokio::sync::mpsc::unbounded_channel();
        let tmp =
            std::env::temp_dir().join(format!("termihub-oversize-{}.json", uuid::Uuid::new_v4()));
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

        let (client, server) = tokio::io::duplex(4 * 1024 * 1024);
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

        // An over-size line: more than 1 MiB of bytes, then a newline.
        client_wr
            .write_all(&vec![b'x'; MAX_LINE_SIZE + 1024])
            .await
            .unwrap();
        client_wr.write_all(b"\n").await.unwrap();

        // Then a perfectly valid request on the same connection.
        let request = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"0.1.0","client":"t","clientVersion":"0.1.0"}}"#;
        client_wr.write_all(request.as_bytes()).await.unwrap();
        client_wr.write_all(b"\n").await.unwrap();

        // Expect the size-limit error first, then the initialize result for id 1.
        let mut lines = BufReader::new(&mut client_rd);
        let (saw_size_error, got_result) = tokio::time::timeout(Duration::from_secs(10), async {
            let mut saw_size_error = false;
            loop {
                let mut line = String::new();
                let n = lines.read_line(&mut line).await.unwrap();
                if n == 0 {
                    return (saw_size_error, false);
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) {
                    if v["error"]["code"] == serde_json::json!(-32700) {
                        saw_size_error = true;
                    }
                    if v["id"] == serde_json::json!(1) && v.get("result").is_some() {
                        return (saw_size_error, true);
                    }
                }
            }
        })
        .await
        .unwrap_or((false, false));

        assert!(
            saw_size_error,
            "over-size message must be rejected with a size-limit error"
        );
        assert!(
            got_result,
            "the loop must keep serving: the follow-up initialize should still get a result"
        );

        shutdown.cancel();
        let _ = loop_handle.await;
    }
}
