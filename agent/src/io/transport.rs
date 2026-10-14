use termihub_core::ipc::{read_line_resumable, LineOutcome};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use std::collections::VecDeque;

use termihub_core::protocol::methods::SSH_KEYBOARD_INTERACTIVE_RESPOND;
use zeroize::Zeroize;

use crate::handler::dispatch::AgentHandler;
use crate::io::notification_queue::NotificationQueues;
use crate::ki_prompt::is_secret_bearing_request;
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
///
/// Equivalent to [`run_transport_loop_with_priority`] with no priority
/// channel.
#[cfg(test)]
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
    let (_priority_tx, mut priority_rx) = tokio::sync::mpsc::unbounded_channel();
    run_transport_loop_with_priority(
        reader,
        writer,
        handler,
        notification_rx,
        &mut priority_rx,
        shutdown,
    )
    .await
}

/// Maximum number of request lines read ahead (and held in order) while a
/// request is in flight. Past it the loop stops reading until the in-flight
/// request finishes, exactly as before read-ahead existed.
const MAX_READ_AHEAD: usize = 256;

/// [`run_transport_loop`] plus a **priority** notification channel.
///
/// Requests are served one at a time, in order, and ordinary notifications are
/// held back while a request is in flight — the long-standing contract. A
/// request can however block on the *desktop*: an SSH connect the agent
/// performs may need the user to answer a keyboard-interactive (OTP / 2FA)
/// prompt (#3375). So while a request is in flight the loop also:
///
/// - writes `priority_rx` notifications (the `ssh.keyboard_interactive.prompt`
///   / `.closed` notifications) immediately, and
/// - keeps reading requests: an `ssh.keyboard_interactive.respond` is
///   dispatched at once (it only resolves a waiting prompt), every other line is
///   queued and served in arrival order after the in-flight request.
///
/// Respond requests carry secrets: they are never logged and their line
/// buffers are zeroized once dispatched.
///
/// Ordinary notifications are written by class, not strictly in arrival order
/// (#4480): port-forward stream data and close (`agent.forward.data` /
/// `.close`) wait on a low-priority queue behind terminal output and control
/// notifications, with a guaranteed share so they are never starved. Order
/// within each class — and so within each forward stream — is preserved. See
/// [`NotificationQueues`].
pub async fn run_transport_loop_with_priority<R, W>(
    reader: &mut R,
    writer: &mut W,
    handler: &AgentHandler,
    notification_rx: &mut tokio::sync::mpsc::UnboundedReceiver<JsonRpcNotification>,
    priority_rx: &mut tokio::sync::mpsc::UnboundedReceiver<JsonRpcNotification>,
    shutdown: CancellationToken,
) -> anyhow::Result<()>
where
    R: AsyncBufReadExt + Unpin,
    W: AsyncWriteExt + Unpin,
{
    // Bytes of a not-yet-complete NDJSON line, carried across loop iterations.
    // Because it lives *outside* the `select!` future, it survives that future
    // being dropped when the notification branch wins the race — see
    // [`termihub_core::ipc::read_line_resumable`] for why that matters (#1559).
    let mut io = LoopIo {
        pending: Vec::new(),
        read_ahead: VecDeque::new(),
        reader_eof: false,
    };
    // Ordinary notifications pulled off `notification_rx`, split into a normal
    // and a low-priority bulk (port-forward data) class (#4480). Local to this
    // loop: what is still queued when the client goes away is dropped with it,
    // releasing any output credit it carried (#4439).
    let mut queues = NotificationQueues::default();

    loop {
        // Serve requests read ahead during an earlier in-flight request first,
        // preserving arrival order.
        if let Some(line) = io.read_ahead.pop_front() {
            if dispatch_line(line, reader, writer, handler, priority_rx, &mut io).await? {
                break;
            }
            continue;
        }
        if io.reader_eof {
            debug!("Reader closed (EOF), exiting transport loop");
            break;
        }

        // Take everything already waiting before choosing what to write, so a
        // terminal line emitted just after a burst of forward data still goes
        // out ahead of that burst.
        while let Ok(notification) = notification_rx.try_recv() {
            queues.push(notification);
        }
        let has_queued = !queues.is_empty();

        tokio::select! {
            _ = shutdown.cancelled() => {
                debug!("Shutdown signal received, exiting transport loop");
                break;
            }

            result = read_line_resumable(reader, &mut io.pending, MAX_LINE_SIZE) => {
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
                if dispatch_line(line, reader, writer, handler, priority_rx, &mut io).await? {
                    break;
                }
            }

            Some(notification) = priority_rx.recv() => {
                write_notification(writer, &notification).await?;
            }

            // Ready whenever something is queued; the unbiased `select!` still
            // gives reads and priority notifications their turn.
            () = std::future::ready(()), if has_queued => {
                if let Some(notification) = queues.pop() {
                    write_notification(writer, &notification).await?;
                }
            }

            Some(notification) = notification_rx.recv(), if !has_queued => {
                queues.push(notification);
            }
        }
    }

    Ok(())
}

/// Per-loop read state shared by the loop and [`dispatch_line`].
struct LoopIo {
    pending: Vec<u8>,
    read_ahead: VecDeque<String>,
    reader_eof: bool,
}

/// Log a received line — redacted when it carries prompt answers.
fn log_received(line: &str) {
    if is_secret_bearing_request(line) {
        debug!("Received: <redacted {}>", SSH_KEYBOARD_INTERACTIVE_RESPOND);
    } else if crate::io::update_auth::carries_update_auth_token(line) {
        // Carries the update auth token (AGT-003, #3213): never log the body.
        debug!("Received: <redacted update request>");
    } else {
        debug!("Received: {}", line);
    }
}

/// Dispatch one request line and write its response, pumping priority
/// notifications and respond requests while it is in flight. Returns whether
/// the loop must stop (`agent.shutdown`).
async fn dispatch_line<R, W>(
    mut line: String,
    reader: &mut R,
    writer: &mut W,
    handler: &AgentHandler,
    priority_rx: &mut tokio::sync::mpsc::UnboundedReceiver<JsonRpcNotification>,
    io: &mut LoopIo,
) -> anyhow::Result<bool>
where
    R: AsyncBufReadExt + Unpin,
    W: AsyncWriteExt + Unpin,
{
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }
    log_received(trimmed);
    let secret = is_secret_bearing_request(trimmed);

    let (response, should_shutdown) = {
        let call = handler.call_raw(trimmed);
        tokio::pin!(call);
        loop {
            tokio::select! {
                biased;

                result = &mut call => break result,

                Some(notification) = priority_rx.recv() => {
                    write_notification(writer, &notification).await?;
                }

                result = read_line_resumable(reader, &mut io.pending, MAX_LINE_SIZE),
                    if !io.reader_eof && io.read_ahead.len() < MAX_READ_AHEAD =>
                {
                    match result? {
                        LineOutcome::Eof => io.reader_eof = true,
                        LineOutcome::TooLarge => {
                            warn!("Message exceeds {} byte limit; rejecting", MAX_LINE_SIZE);
                            write_line(writer, SIZE_LIMIT_ERROR).await?;
                        }
                        LineOutcome::Line(mut next) => {
                            if is_secret_bearing_request(next.trim()) {
                                log_received(next.trim());
                                let (resp, _) = handler.call_raw(next.trim()).await;
                                next.zeroize();
                                write_line(writer, &resp).await?;
                            } else {
                                io.read_ahead.push_back(next);
                            }
                        }
                    }
                }
            }
        }
    };
    if secret {
        line.zeroize();
    }
    debug!("Sending: {}", response);
    write_line(writer, &response).await?;

    if should_shutdown {
        debug!("agent.shutdown handled, exiting transport loop");
    }
    Ok(should_shutdown)
}

/// Serialise and write one notification line.
async fn write_notification<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    notification: &JsonRpcNotification,
) -> anyhow::Result<()> {
    let json = serde_json::to_string(notification)?;
    debug!("Sending notification: {}", json);
    write_line(writer, &json).await
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

    // The framer-level unit tests for the NDJSON reader (fragmented
    // reassembly, over-cap rejection without unbounded buffering, recovery
    // after an over-cap line, and cancellation safety) now live with the
    // shared implementation in `termihub_core::ipc::ndjson`. The loop-level
    // regressions below exercise `run_transport_loop` end-to-end against that
    // shared reader.

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

    /// Build an [`AgentHandler`] over fresh managers for loop-level tests.
    fn priority_test_handler() -> AgentHandler {
        use crate::monitoring::{MonitoringManager, MonitoringManagerApi};
        use crate::session::definitions::{ConnectionStore, ConnectionStoreApi};
        use crate::session::manager::{SessionManager, SessionManagerApi};

        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let tmp = std::env::temp_dir().join(format!("termihub-prio-{}.json", uuid::Uuid::new_v4()));
        let conn_store = Arc::new(ConnectionStore::new_temp(tmp));
        let registry = Arc::new(crate::registry::build_registry());
        let session_manager = Arc::new(SessionManager::new(tx.clone(), registry));
        let monitoring = Arc::new(MonitoringManager::new(tx, conn_store.clone()));
        AgentHandler::new(
            session_manager as Arc<dyn SessionManagerApi>,
            conn_store as Arc<dyn ConnectionStoreApi>,
            monitoring as Arc<dyn MonitoringManagerApi>,
        )
        .unwrap()
    }

    /// Run the loop over `queued` notifications (all sent before it starts, as
    /// a saturated forward window and a busy terminal leave them) and return the
    /// `(method, params)` of the first `expect` lines it writes.
    async fn written_order(
        queued: Vec<JsonRpcNotification>,
        expect: usize,
    ) -> Vec<(String, serde_json::Value)> {
        let handler = priority_test_handler();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        for n in queued {
            tx.send(n).unwrap();
        }
        let (client, server) = tokio::io::duplex(16 * 1024 * 1024);
        let (server_rd, mut server_wr) = tokio::io::split(server);
        let (client_rd, _client_wr) = tokio::io::split(client);
        let mut reader = BufReader::new(server_rd);
        let shutdown = CancellationToken::new();
        let loop_shutdown = shutdown.clone();
        let handle = tokio::spawn(async move {
            run_transport_loop(
                &mut reader,
                &mut server_wr,
                &handler,
                &mut rx,
                loop_shutdown,
            )
            .await
        });

        let mut lines = BufReader::new(client_rd);
        let mut out = Vec::with_capacity(expect);
        tokio::time::timeout(Duration::from_secs(10), async {
            while out.len() < expect {
                let mut line = String::new();
                assert!(
                    lines.read_line(&mut line).await.unwrap() > 0,
                    "loop ended early"
                );
                let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
                out.push((
                    v["method"].as_str().unwrap().to_string(),
                    v["params"].clone(),
                ));
            }
        })
        .await
        .expect("notifications written in time");
        shutdown.cancel();
        let _ = handle.await;
        drop(tx);
        out
    }

    fn forward_data(stream: &str, seq: u64) -> JsonRpcNotification {
        JsonRpcNotification::new(
            crate::protocol::methods::AGENT_FORWARD_DATA,
            serde_json::json!({"stream_id": stream, "seq": seq, "data": "A".repeat(4096)}),
        )
    }

    fn terminal_output(seq: u64) -> JsonRpcNotification {
        JsonRpcNotification::new(
            "connection.output",
            serde_json::json!({"session_id": "term", "seq": seq}),
        )
    }

    /// #4480: with a forward stream's whole window queued, a terminal output
    /// notification emitted afterwards is written before that forward data.
    #[tokio::test]
    async fn terminal_output_is_written_before_queued_forward_data() {
        let mut queued: Vec<_> = (0..128).map(|i| forward_data("vnc#1", i)).collect();
        queued.push(terminal_output(0));
        let order = written_order(queued, 129).await;
        assert_eq!(order[0].0, "connection.output");
        assert!(order[1..]
            .iter()
            .all(|(m, _)| m == crate::protocol::methods::AGENT_FORWARD_DATA));
        let seqs: Vec<u64> = order[1..]
            .iter()
            .map(|(_, p)| p["seq"].as_u64().unwrap())
            .collect();
        assert_eq!(seqs, (0..128).collect::<Vec<_>>(), "stream order kept");
    }

    /// #4480: forward data still drains while terminal output keeps coming —
    /// it gets one slot after every `BULK_EVERY` output lines.
    #[tokio::test]
    async fn forward_data_drains_under_sustained_terminal_output() {
        use crate::io::notification_queue::BULK_EVERY;
        let mut queued: Vec<_> = (0..3).map(|i| forward_data("vnc#1", i)).collect();
        queued.extend((0..200).map(terminal_output));
        let order = written_order(queued, 3 * (BULK_EVERY + 1)).await;
        let data_positions: Vec<usize> = order
            .iter()
            .enumerate()
            .filter(|(_, (m, _))| m == crate::protocol::methods::AGENT_FORWARD_DATA)
            .map(|(i, _)| i)
            .collect();
        assert_eq!(
            data_positions,
            vec![BULK_EVERY, 2 * BULK_EVERY + 1, 3 * BULK_EVERY + 2]
        );
    }

    /// #4480: a stream's close never overtakes its data, and acks are prompt.
    #[tokio::test]
    async fn forward_close_follows_its_data_and_acks_go_first() {
        use crate::protocol::methods::{AGENT_FORWARD_ACK, AGENT_FORWARD_CLOSE};
        let queued = vec![
            forward_data("vnc#1", 0),
            forward_data("vnc#1", 1),
            JsonRpcNotification::new(
                AGENT_FORWARD_CLOSE,
                serde_json::json!({"stream_id": "vnc#1"}),
            ),
            JsonRpcNotification::new(
                AGENT_FORWARD_ACK,
                serde_json::json!({"stream_id": "vnc#2", "bytes": 10}),
            ),
        ];
        let order = written_order(queued, 4).await;
        let methods: Vec<&str> = order.iter().map(|(m, _)| m.as_str()).collect();
        assert_eq!(
            methods,
            vec![
                AGENT_FORWARD_ACK,
                crate::protocol::methods::AGENT_FORWARD_DATA,
                crate::protocol::methods::AGENT_FORWARD_DATA,
                AGENT_FORWARD_CLOSE,
            ]
        );
        assert_eq!(order[1].1["seq"], 0);
        assert_eq!(order[2].1["seq"], 1);
    }
}
