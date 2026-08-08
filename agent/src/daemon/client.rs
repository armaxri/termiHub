//! Reusable daemon client for connecting to session daemon processes.
//!
//! Manages the transport connection (Unix socket on unix, named pipe on
//! windows — see [`crate::daemon::transport`]), reader task, and provides
//! methods for write_input, resize, attach, detach, and close. Used by both
//! `ShellBackend` and `DockerBackend`.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use base64::Engine;
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

use crate::daemon::protocol::{self, *};
use crate::daemon::transport::{self, BoxedReader, BoxedWriter};
use crate::io::transport::NotificationSender;
use crate::protocol::messages::JsonRpcNotification;

/// How long to wait for the Ready frame after connecting.
///
/// Like the connect timeout, this is generous so a daemon that is slow to
/// finish startup and send `MSG_READY` under CI load is not dropped prematurely.
const READY_TIMEOUT: Duration = Duration::from_secs(15);

/// Future returned by an [`ExitHook`].
pub type ExitHookFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

/// Callback invoked once when the daemon reader detects the backend has exited
/// on its own — an `MSG_EXITED` frame, a clean EOF, or a transport read error.
///
/// The [`SessionManager`](crate::session::manager::SessionManager) installs one
/// via [`DaemonClient::set_exit_hook`] so a naturally-exiting daemon-backed
/// session promptly runs its deferred self-update auto-apply, mirroring the
/// in-process output-forwarder path (#2378/#2381). The reader awaits the
/// returned future, so the hook may do async work (e.g. lock the session map).
pub type ExitHook = Arc<dyn Fn() -> ExitHookFuture + Send + Sync>;

/// Shared, set-once slot holding a session's [`ExitHook`].
///
/// Shared between the [`DaemonClient`] and its background reader task(s) so the
/// hook can be installed *after* [`DaemonClient::connect`] has already spawned
/// the reader, and so a reader respawned on reattach still observes it. Empty
/// when no hook was installed (e.g. a manager not built through
/// [`SessionManager::into_arc`](crate::session::manager::SessionManager::into_arc),
/// or a client used in isolation), in which case the reader simply skips it.
type ExitHookSlot = Arc<OnceLock<ExitHook>>;

/// Run the installed exit hook, if any. Called by the reader once its backend
/// has exited on its own.
async fn run_exit_hook(slot: &ExitHookSlot) {
    if let Some(hook) = slot.get() {
        hook().await;
    }
}

/// Cloneable handle to the daemon's write half.
///
/// Extracted from a [`DaemonClient`] via [`DaemonClient::writer_handle`] so
/// callers can write to the daemon without holding a borrow of the client
/// itself (e.g. across an async boundary while a sessions mutex is locked).
pub type DaemonWriterHandle = Arc<Mutex<Option<BoxedWriter>>>;

/// A reusable client for communicating with a session daemon process.
///
/// Handles the transport connection lifecycle, background reader task,
/// and all frame-level I/O operations.
pub struct DaemonClient {
    session_id: String,
    /// Transport endpoint: socket path on unix, pipe name on windows.
    endpoint: String,
    /// Writer half of the transport connection.
    writer: Arc<Mutex<Option<BoxedWriter>>>,
    /// Background reader task handle.
    reader_task: Option<tokio::task::JoinHandle<()>>,
    /// Whether this session is alive (daemon running, not exited).
    alive: Arc<AtomicBool>,
    /// Notification channel to the transport loop.
    notification_tx: NotificationSender,
    /// Pending oneshot channel for a query_buffer response.
    pending_buffer_reply: Arc<Mutex<Option<tokio::sync::oneshot::Sender<Vec<u8>>>>>,
    /// Hook the reader runs when this session's backend exits on its own,
    /// installed via [`set_exit_hook`](Self::set_exit_hook) (#2381).
    on_exit: ExitHookSlot,
}

impl DaemonClient {
    /// Connect to an existing daemon endpoint and start the reader task.
    ///
    /// Used both for initial connection after spawning a daemon and for
    /// reconnection during session recovery. The transport retries briefly
    /// while the endpoint is not yet present (the daemon binds it during slow
    /// startup work), so no separate "wait for socket" step is needed.
    pub async fn connect(
        session_id: String,
        endpoint: String,
        notification_tx: NotificationSender,
    ) -> Result<Self, anyhow::Error> {
        Self::connect_inner(session_id, endpoint, notification_tx, false).await
    }

    /// Connect to an **already-running** daemon during session recovery, failing
    /// fast on a dead daemon whose socket file merely lingers.
    ///
    /// Like [`connect`](Self::connect) but uses the short recovery connect
    /// timeout ([`transport::connect_for_recovery`]) instead of the long
    /// spawn-path one. The spawn path races its 30s connect against the daemon
    /// process exiting; recovery has no such process to race, so retrying a
    /// dead-but-lingering socket for 30s would stall the fresh agent's startup —
    /// and therefore the desktop's `initialize` handshake — after a reconnect
    /// (#2476). This is the entry point [`recover_sessions`] must use.
    ///
    /// [`recover_sessions`]: crate::session::manager::SessionManager::recover_sessions
    pub async fn connect_for_recovery(
        session_id: String,
        endpoint: String,
        notification_tx: NotificationSender,
    ) -> Result<Self, anyhow::Error> {
        Self::connect_inner(session_id, endpoint, notification_tx, true).await
    }

    async fn connect_inner(
        session_id: String,
        endpoint: String,
        notification_tx: NotificationSender,
        for_recovery: bool,
    ) -> Result<Self, anyhow::Error> {
        let pending_buffer_reply: Arc<Mutex<Option<tokio::sync::oneshot::Sender<Vec<u8>>>>> =
            Arc::new(Mutex::new(None));
        let on_exit: ExitHookSlot = Arc::new(OnceLock::new());

        let (writer, reader_task, alive) = connect_and_start_reader(
            &endpoint,
            &session_id,
            notification_tx.clone(),
            pending_buffer_reply.clone(),
            on_exit.clone(),
            for_recovery,
        )
        .await?;

        Ok(Self {
            session_id,
            endpoint,
            writer: Arc::new(Mutex::new(Some(writer))),
            reader_task: Some(reader_task),
            alive,
            notification_tx,
            pending_buffer_reply,
            on_exit,
        })
    }

    /// Install the callback the reader runs when this session's backend exits on
    /// its own (an `MSG_EXITED` frame or EOF/read error on the transport).
    ///
    /// Set-once — a second call is ignored. Wired by the
    /// [`SessionManager`](crate::session::manager::SessionManager) so a natural
    /// last-session exit promptly triggers the deferred self-update auto-apply,
    /// matching the in-process output-forwarder path (#2381). Safe to call after
    /// [`connect`](Self::connect): the reader reads the slot only once the
    /// backend has actually exited, and the shared slot is also observed by a
    /// reader respawned on [`attach`](Self::attach).
    pub fn set_exit_hook(&self, hook: ExitHook) {
        let _ = self.on_exit.set(hook);
    }

    /// Request the current ring buffer contents from the daemon without reconnecting.
    ///
    /// Sends `MSG_QUERY_BUFFER` and waits (up to 10 s) for `MSG_BUFFER_REPLAY`.
    pub async fn query_buffer(&self) -> Result<Vec<u8>, anyhow::Error> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            *self.pending_buffer_reply.lock().await = Some(tx);
        }

        {
            let mut guard = self.writer.lock().await;
            let writer = guard
                .as_mut()
                .ok_or_else(|| anyhow::anyhow!("Not connected to daemon"))?;
            protocol::write_frame_async(writer, MSG_QUERY_BUFFER, &[]).await?;
        }

        tokio::time::timeout(std::time::Duration::from_secs(10), rx)
            .await
            .map_err(|_| anyhow::anyhow!("Timeout waiting for buffer reply from daemon"))?
            .map_err(|_| anyhow::anyhow!("Buffer reply channel closed unexpectedly"))
    }

    /// Clone the writer Arc so callers can write without holding a reference to
    /// this `DaemonClient`. Useful when the caller cannot hold a borrow of the
    /// client across an `.await` (e.g. while a sessions `Mutex` is locked).
    pub fn writer_handle(&self) -> DaemonWriterHandle {
        self.writer.clone()
    }

    /// Write `data` to the daemon through a previously cloned writer handle.
    pub async fn write_via_handle(
        handle: &DaemonWriterHandle,
        data: &[u8],
    ) -> Result<(), anyhow::Error> {
        let mut guard = handle.lock().await;
        let writer = guard
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Not connected to daemon"))?;
        protocol::write_frame_async(writer, MSG_INPUT, data).await?;
        Ok(())
    }

    /// Resize the PTY through a previously cloned writer handle.
    pub async fn resize_via_handle(
        handle: &DaemonWriterHandle,
        cols: u16,
        rows: u16,
    ) -> Result<(), anyhow::Error> {
        let mut guard = handle.lock().await;
        let writer = guard
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Not connected to daemon"))?;
        let payload = protocol::encode_resize(cols, rows);
        protocol::write_frame_async(writer, MSG_RESIZE, &payload).await?;
        Ok(())
    }

    /// Reattach by reconnecting to the daemon socket.
    ///
    /// The daemon sends a BufferReplay on every new connection, so
    /// reconnecting gives us a fresh buffer replay.
    pub async fn attach(&mut self) -> Result<(), anyhow::Error> {
        // Disconnect current connection (triggers Detach on daemon side via EOF)
        self.disconnect().await;

        // Reconnect to get a fresh buffer replay. Not the recovery path — the
        // daemon is a live session being re-attached, so keep the long timeout.
        let (writer, reader_task, alive) = connect_and_start_reader(
            &self.endpoint,
            &self.session_id,
            self.notification_tx.clone(),
            self.pending_buffer_reply.clone(),
            self.on_exit.clone(),
            false,
        )
        .await?;

        *self.writer.lock().await = Some(writer);
        self.reader_task = Some(reader_task);
        self.alive = alive;

        info!("Reattached to session {}", self.session_id);
        Ok(())
    }

    /// Detach from the daemon without killing it.
    ///
    /// Order matters here (#2437). A clean detach makes the daemon drop its
    /// writer to us (`agent_writer = None` on `MSG_DETACH`), which surfaces to
    /// our reader task as an EOF. If the reader observed that EOF it would run
    /// the exit path and clear `alive` — even though the session is still very
    /// much alive on the daemon — and `settle_exited` would then flip the
    /// session to a *terminal* `Exited`, so the next re-attach fails with
    /// "Session not running". The daemon only closes us in response to the
    /// `MSG_DETACH` we send here, so aborting the reader *before* sending it
    /// guarantees the reader is gone before that EOF can ever arrive. A genuine
    /// `MSG_EXITED` that arrived earlier was already handled on its own, so this
    /// ordering does not weaken natural-exit detection.
    pub async fn detach(&mut self) {
        // Stop observing the transport first, so the detach-induced EOF below is
        // never mistaken for the shell exiting.
        if let Some(task) = self.reader_task.take() {
            task.abort();
        }
        // Ask the daemon to keep the session but drop this connection.
        let mut writer_guard = self.writer.lock().await;
        if let Some(ref mut writer) = *writer_guard {
            let _ = protocol::write_frame_async(writer, MSG_DETACH, &[]).await;
        }
        // Drop our writer half (closes our end of the socket).
        *writer_guard = None;
        debug!("Detached from session {}", self.session_id);
    }

    /// Send kill frame and disconnect.
    pub async fn close(&mut self) {
        // Send Kill frame if connected
        {
            let mut guard = self.writer.lock().await;
            if let Some(ref mut writer) = *guard {
                let _ = protocol::write_frame_async(writer, MSG_KILL, &[]).await;
            }
        }
        self.disconnect().await;
        info!("Closed session {}", self.session_id);
    }

    /// Whether the daemon is still alive.
    #[allow(dead_code)]
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Get the transport endpoint (socket path on unix, pipe name on windows).
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Disconnect the current socket connection and abort the reader task.
    async fn disconnect(&mut self) {
        // Drop the writer half (closes our end of the socket)
        *self.writer.lock().await = None;
        // Abort the reader task
        if let Some(task) = self.reader_task.take() {
            task.abort();
        }
    }
}

// ── ProcessHandle trait implementation ──────────────────────────────
//
// The core `ProcessHandle` trait is synchronous. These methods are intended
// to be called from `spawn_blocking` contexts where `Handle::block_on()`
// is safe (we are on a blocking thread, not inside an async task).

impl termihub_core::session::traits::ProcessHandle for DaemonClient {
    fn write_input(&self, data: &[u8]) -> Result<(), termihub_core::errors::SessionError> {
        let handle = tokio::runtime::Handle::current();
        handle
            .block_on(async {
                let mut guard = self.writer.lock().await;
                let writer = guard.as_mut().ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::NotConnected, "not connected to daemon")
                })?;
                protocol::write_frame_async(writer, MSG_INPUT, data).await
            })
            .map_err(|e| {
                termihub_core::errors::SessionError::Io(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    e.to_string(),
                ))
            })
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), termihub_core::errors::SessionError> {
        let handle = tokio::runtime::Handle::current();
        handle
            .block_on(async {
                let mut guard = self.writer.lock().await;
                let writer = guard.as_mut().ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::NotConnected, "not connected to daemon")
                })?;
                let payload = protocol::encode_resize(cols, rows);
                protocol::write_frame_async(writer, MSG_RESIZE, &payload).await
            })
            .map_err(|e| {
                termihub_core::errors::SessionError::Io(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    e.to_string(),
                ))
            })
    }

    fn close(&self) -> Result<(), termihub_core::errors::SessionError> {
        let handle = tokio::runtime::Handle::current();
        handle.block_on(async {
            let mut guard = self.writer.lock().await;
            if let Some(ref mut writer) = *guard {
                let _ = protocol::write_frame_async(writer, MSG_KILL, &[]).await;
            }
            // Drop the writer half — the reader task will exit on EOF.
            *guard = None;
        });
        self.alive.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
}

/// Connect to the daemon endpoint, wait for the Ready frame, and start the reader task.
///
/// Returns the writer half, the reader task handle, and the alive flag.
async fn connect_and_start_reader(
    endpoint: &str,
    session_id: &str,
    notification_tx: NotificationSender,
    pending_buffer_reply: Arc<Mutex<Option<tokio::sync::oneshot::Sender<Vec<u8>>>>>,
    on_exit: ExitHookSlot,
    for_recovery: bool,
) -> Result<(BoxedWriter, tokio::task::JoinHandle<()>, Arc<AtomicBool>), anyhow::Error> {
    // Recovery targets an already-bound daemon and must fast-fail a dead-but-
    // lingering socket rather than pay the long spawn-path connect timeout (#2476).
    let (mut reader, writer) = if for_recovery {
        transport::connect_for_recovery(endpoint).await?
    } else {
        transport::connect(endpoint).await?
    };

    let alive = Arc::new(AtomicBool::new(true));

    // Wait for BufferReplay + Ready, sending replay as notification
    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(anyhow::anyhow!(
                "Daemon did not send Ready within {:?}",
                READY_TIMEOUT
            ));
        }

        match tokio::time::timeout(remaining, protocol::read_frame_async(&mut reader)).await {
            Ok(Ok(Some(frame))) => match frame.msg_type {
                MSG_BUFFER_REPLAY => {
                    // Send as connection.output if non-empty
                    if !frame.payload.is_empty() {
                        send_output_notification(&notification_tx, session_id, &frame.payload);
                    }
                }
                MSG_READY => {
                    break;
                }
                MSG_EXITED => {
                    let code = protocol::decode_exit_code(&frame.payload).unwrap_or(-1);
                    return Err(anyhow::anyhow!("Shell already exited with code {code}"));
                }
                _ => {
                    debug!(
                        "Unexpected frame during handshake: 0x{:02x}",
                        frame.msg_type
                    );
                }
            },
            Ok(Ok(None)) => {
                return Err(anyhow::anyhow!("Daemon closed connection during handshake"));
            }
            Ok(Err(e)) => {
                return Err(anyhow::anyhow!("Frame read error during handshake: {e}"));
            }
            Err(_) => {
                return Err(anyhow::anyhow!(
                    "Daemon did not send Ready within {:?}",
                    READY_TIMEOUT
                ));
            }
        }
    }

    // Start the background reader task
    let alive_clone = alive.clone();
    let session_id_owned = session_id.to_string();
    let tx = notification_tx.clone();

    let reader_task = tokio::spawn(async move {
        reader_loop(
            reader,
            &session_id_owned,
            &tx,
            &alive_clone,
            pending_buffer_reply,
            on_exit,
        )
        .await;
    });

    Ok((writer, reader_task, alive))
}

/// Background task that reads frames from the daemon and sends notifications.
async fn reader_loop(
    mut reader: BoxedReader,
    session_id: &str,
    notification_tx: &NotificationSender,
    alive: &AtomicBool,
    pending_buffer_reply: Arc<Mutex<Option<tokio::sync::oneshot::Sender<Vec<u8>>>>>,
    on_exit: ExitHookSlot,
) {
    loop {
        match protocol::read_frame_async(&mut reader).await {
            Ok(Some(frame)) => match frame.msg_type {
                MSG_OUTPUT => {
                    send_output_notification(notification_tx, session_id, &frame.payload);
                }
                MSG_BUFFER_REPLAY => {
                    // If there is a pending query_buffer call, deliver to it.
                    // Otherwise, forward as output (e.g. initial connect replay).
                    let pending = {
                        let mut guard = pending_buffer_reply.lock().await;
                        guard.take()
                    };
                    if let Some(sender) = pending {
                        let _ = sender.send(frame.payload);
                    } else if !frame.payload.is_empty() {
                        send_output_notification(notification_tx, session_id, &frame.payload);
                    }
                }
                MSG_EXITED => {
                    let code = protocol::decode_exit_code(&frame.payload).unwrap_or(-1);
                    info!("Session {session_id} exited with code {code}");
                    alive.store(false, Ordering::SeqCst);

                    let notification = JsonRpcNotification::new(
                        "connection.exit",
                        serde_json::json!({
                            "session_id": session_id,
                            "exit_code": code,
                        }),
                    );
                    let _ = notification_tx.send(notification);
                    // Natural-exit deferred-update hook (#2381): if this was the
                    // last active session, apply any staged self-update now,
                    // matching the explicit-close and in-process paths.
                    run_exit_hook(&on_exit).await;
                    return;
                }
                MSG_ERROR => {
                    let msg = String::from_utf8_lossy(&frame.payload);
                    warn!("Daemon error for session {session_id}: {msg}");

                    let notification = JsonRpcNotification::new(
                        "connection.error",
                        serde_json::json!({
                            "session_id": session_id,
                            "message": msg.to_string(),
                        }),
                    );
                    let _ = notification_tx.send(notification);
                }
                MSG_READY => {
                    // Duplicate ready — ignore
                    debug!("Got additional Ready frame for session {session_id}");
                }
                other => {
                    debug!("Unknown frame type from daemon: 0x{other:02x}");
                }
            },
            Ok(None) => {
                // Daemon closed the connection (EOF)
                info!("Daemon connection closed for session {session_id}");
                alive.store(false, Ordering::SeqCst);
                run_exit_hook(&on_exit).await;
                return;
            }
            Err(e) => {
                error!("Frame read error for session {session_id}: {e}");
                alive.store(false, Ordering::SeqCst);
                run_exit_hook(&on_exit).await;
                return;
            }
        }
    }
}

/// Send output data as a base64-encoded `connection.output` notification.
///
/// Chunks large payloads to stay under the 1 MiB NDJSON line limit.
pub(crate) fn send_output_notification(tx: &NotificationSender, session_id: &str, data: &[u8]) {
    let b64 = base64::engine::general_purpose::STANDARD;
    for chunk in data.chunks(65536) {
        let encoded = b64.encode(chunk);
        let notification = JsonRpcNotification::new(
            "connection.output",
            serde_json::json!({
                "session_id": session_id,
                "data": encoded,
            }),
        );
        let _ = tx.send(notification);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::protocol;

    fn make_notification_tx() -> NotificationSender {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        tx
    }

    /// Verify that `query_buffer` sends MSG_QUERY_BUFFER and the pending reply
    /// channel receives the response when a MSG_BUFFER_REPLAY frame arrives.
    #[tokio::test]
    async fn query_buffer_sends_request_and_receives_reply() {
        // In-memory duplex pipe simulating the daemon connection (cross-platform).
        let (client_sock, server_sock) = tokio::io::duplex(64 * 1024);
        let (mut server_reader, mut server_writer) = tokio::io::split(server_sock);

        // Simulate daemon: first send MSG_READY (handshake), then wait for
        // MSG_QUERY_BUFFER and respond with MSG_BUFFER_REPLAY.
        let daemon_task = tokio::spawn(async move {
            // Send ready (handshake)
            protocol::write_frame_async(&mut server_writer, MSG_READY, &[])
                .await
                .unwrap();

            // Read the MSG_QUERY_BUFFER request
            let frame = protocol::read_frame_async(&mut server_reader)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(frame.msg_type, MSG_QUERY_BUFFER);

            // Send back the buffer
            let data = b"buffered output";
            protocol::write_frame_async(&mut server_writer, MSG_BUFFER_REPLAY, data)
                .await
                .unwrap();
        });

        let pending_buffer_reply: Arc<Mutex<Option<tokio::sync::oneshot::Sender<Vec<u8>>>>> =
            Arc::new(Mutex::new(None));
        let notification_tx = make_notification_tx();

        // Connect by using the duplex pipe directly.
        let (client_reader, client_writer) = tokio::io::split(client_sock);
        let mut reader: BoxedReader = Box::new(client_reader);
        let writer: BoxedWriter = Box::new(client_writer);

        // Consume the ready frame manually
        let ready_frame = protocol::read_frame_async(&mut reader)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ready_frame.msg_type, MSG_READY);

        let alive = Arc::new(AtomicBool::new(true));
        let alive_clone = alive.clone();
        let session_id_owned = "test-session".to_string();
        let tx = notification_tx.clone();
        let pbr_clone = pending_buffer_reply.clone();

        let on_exit: ExitHookSlot = Arc::new(OnceLock::new());
        let reader_task = tokio::spawn(async move {
            reader_loop(
                reader,
                &session_id_owned,
                &tx,
                &alive_clone,
                pbr_clone,
                on_exit,
            )
            .await;
        });

        let writer_arc: Arc<Mutex<Option<BoxedWriter>>> = Arc::new(Mutex::new(Some(writer)));

        // Set up a pending reply channel manually
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel::<Vec<u8>>();
        *pending_buffer_reply.lock().await = Some(reply_tx);

        // Send MSG_QUERY_BUFFER via the writer
        {
            let mut guard = writer_arc.lock().await;
            let w = guard.as_mut().unwrap();
            protocol::write_frame_async(w, MSG_QUERY_BUFFER, &[])
                .await
                .unwrap();
        }

        // Await the daemon task and the reply
        daemon_task.await.unwrap();

        let reply = tokio::time::timeout(std::time::Duration::from_secs(2), reply_rx)
            .await
            .expect("reply timed out")
            .expect("channel closed");
        assert_eq!(reply, b"buffered output");

        reader_task.abort();
    }

    /// Build an [`ExitHook`] that flips the returned flag when run, so a test can
    /// assert the reader reached back into its owner on a natural exit (#2381).
    fn recording_exit_hook() -> (ExitHookSlot, Arc<AtomicBool>) {
        let ran = Arc::new(AtomicBool::new(false));
        let ran_for_hook = ran.clone();
        let hook: ExitHook = Arc::new(move || {
            let ran = ran_for_hook.clone();
            Box::pin(async move {
                ran.store(true, Ordering::SeqCst);
            }) as ExitHookFuture
        });
        let slot: ExitHookSlot = Arc::new(OnceLock::new());
        let _ = slot.set(hook);
        (slot, ran)
    }

    /// The reader must run the installed exit hook when the daemon reports the
    /// backend exited on its own via `MSG_EXITED` (#2381).
    #[tokio::test]
    async fn reader_loop_runs_exit_hook_on_msg_exited() {
        let (client_sock, mut server_sock) = tokio::io::duplex(64 * 1024);
        // The daemon side signals a natural backend exit, then closes.
        tokio::spawn(async move {
            protocol::write_frame_async(&mut server_sock, MSG_EXITED, &[])
                .await
                .unwrap();
        });

        let reader: BoxedReader = Box::new(client_sock);
        let (on_exit, ran) = recording_exit_hook();
        let alive = Arc::new(AtomicBool::new(true));
        let pbr = Arc::new(Mutex::new(None));

        reader_loop(
            reader,
            "sess",
            &make_notification_tx(),
            &alive,
            pbr,
            on_exit,
        )
        .await;

        assert!(!alive.load(Ordering::SeqCst), "backend marked dead on exit");
        assert!(
            ran.load(Ordering::SeqCst),
            "exit hook must run when the daemon sends MSG_EXITED"
        );
    }

    /// The reader must also run the exit hook when the daemon connection reaches
    /// EOF (the daemon vanished without a clean `MSG_EXITED`) (#2381).
    #[tokio::test]
    async fn reader_loop_runs_exit_hook_on_eof() {
        let (client_sock, server_sock) = tokio::io::duplex(64 * 1024);
        // Drop the server end immediately → the client reader observes EOF.
        drop(server_sock);

        let reader: BoxedReader = Box::new(client_sock);
        let (on_exit, ran) = recording_exit_hook();
        let alive = Arc::new(AtomicBool::new(true));
        let pbr = Arc::new(Mutex::new(None));

        reader_loop(
            reader,
            "sess",
            &make_notification_tx(),
            &alive,
            pbr,
            on_exit,
        )
        .await;

        assert!(!alive.load(Ordering::SeqCst), "backend marked dead on EOF");
        assert!(
            ran.load(Ordering::SeqCst),
            "exit hook must run when the daemon connection reaches EOF"
        );
    }

    /// Regression for #2437: a clean [`DaemonClient::detach`] must leave the
    /// daemon-backed session reported as **alive**.
    ///
    /// The real daemon drops its writer to us the moment it receives
    /// `MSG_DETACH` (`agent_writer = None`), which reaches the client's reader
    /// task as an EOF. If the reader observed that EOF it would run the
    /// natural-exit path and clear `alive`; `settle_exited` then flips the
    /// session to a *terminal* `Exited`, and the next re-attach fails with
    /// `-32001 Session not running`. `detach` aborts the reader **before**
    /// sending `MSG_DETACH`, so the reader is gone before that EOF can arrive.
    /// A genuine `MSG_EXITED` that arrived earlier is handled on its own, so
    /// this ordering does not weaken natural-exit detection.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn detach_keeps_session_alive_when_daemon_closes_connection() {
        let session_id = format!(
            "itest-detach-alive-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let endpoint = transport::session_endpoint(&session_id);

        let mut listener = transport::DaemonListener::bind(&endpoint)
            .await
            .expect("bind mock daemon");

        // Mock daemon. The real daemon only closes the connection *in response* to
        // MSG_DETACH, so the resulting EOF reaches the client well after detach's
        // (asynchronous) reader-task abort has landed. The original mock instead
        // dropped its halves the instant it saw MSG_DETACH — a tighter schedule
        // than production that raced the abort and made this test flaky on macOS
        // CI (#2459). Reproduce production's ordering *deterministically*: do not
        // EOF the client until its reader task is actually gone. The reader task
        // owns the client's read half, so once a correct detach aborts it (and
        // detach has dropped the client's write half) the client socket is fully
        // closed and any write from us fails; probe for exactly that. While the
        // reader still lives, empty MSG_OUTPUT frames are accepted and ignored.
        //
        // `reader_gone` reports whether the reader was gone *before* we closed —
        // the direct #2437 property. A correct detach makes it true quickly; the
        // pre-#2437 ordering leaves the reader live, so the probe never fails and
        // the generous deadline trips it to false.
        let (reader_gone_tx, reader_gone_rx) = tokio::sync::oneshot::channel::<bool>();
        let server = tokio::spawn(async move {
            let (mut reader, mut writer) = listener.accept().await.expect("accept");
            protocol::write_frame_async(&mut writer, MSG_READY, &[])
                .await
                .expect("send ready");
            while let Ok(Some(frame)) = protocol::read_frame_async(&mut reader).await {
                if frame.msg_type == MSG_DETACH {
                    break;
                }
            }
            let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
            let reader_gone = loop {
                if protocol::write_frame_async(&mut writer, MSG_OUTPUT, &[])
                    .await
                    .is_err()
                {
                    break true;
                }
                if tokio::time::Instant::now() >= deadline {
                    break false;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            };
            let _ = reader_gone_tx.send(reader_gone);
            // Only now drop our halves. On a correct detach the client's reader is
            // already gone, so this EOF reaches no one; on the pre-#2437 ordering
            // it is what finally trips the still-live reader's exit path.
            drop(writer);
            drop(reader);
            listener.cleanup();
        });

        let (on_exit, exit_ran) = recording_exit_hook();
        let mut client =
            DaemonClient::connect(session_id.clone(), endpoint.clone(), make_notification_tx())
                .await
                .expect("client connect");
        client.set_exit_hook(on_exit.get().cloned().expect("hook installed"));
        assert!(client.is_alive(), "freshly connected session must be alive");

        client.detach().await;

        // Deterministic synchronization (replaces the old fixed 100 ms sleep): the
        // mock only closes the connection once the reader task is gone, so it can
        // never deliver a detach-induced EOF to a live reader.
        let reader_gone = reader_gone_rx
            .await
            .expect("mock daemon reported reader state");
        assert!(
            reader_gone,
            "detach must abort the reader before the daemon connection closes (#2437)"
        );
        assert!(
            client.is_alive(),
            "a clean detach must not mark the still-alive session dead (#2437)"
        );
        assert!(
            !exit_ran.load(Ordering::SeqCst),
            "the detach-induced EOF must not be mistaken for a natural exit (#2437)"
        );

        server.await.expect("mock daemon task");
    }
}
