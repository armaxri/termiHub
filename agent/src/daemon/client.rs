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
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

use crate::daemon::protocol::{self, *};
use crate::daemon::transport::{self, BoxedReader, BoxedWriter};
use crate::io::transport::NotificationSender;
use crate::protocol::messages::JsonRpcNotification;
use crate::protocol::methods::{CONNECTION_EVICTED, CONNECTION_EXIT, CONNECTION_OUTPUT};

/// How long to wait for the Ready frame after connecting.
///
/// Like the connect timeout, this is generous so a daemon that is slow to
/// finish startup and send `MSG_READY` under CI load is not dropped prematurely.
const READY_TIMEOUT: Duration = Duration::from_secs(15);

/// Upper bound on a single framed write to the daemon (CONC-013).
///
/// Every write path locks the `writer` [`Mutex`] and holds the guard across the
/// whole [`protocol::write_frame_async`] — this is **deliberate**: frames must
/// not interleave on the socket, so only one write may be in flight at a time.
/// The hazard is not the lock scope but the *unbounded* wait inside it: a wedged
/// daemon (one that has stopped reading, leaving the socket buffer full) would
/// otherwise hold the writer lock for the whole write, blocking every other
/// sender — input, resize, detach, kill — behind one hung write, with no way for
/// the teardown paths (`detach`/`close`) to make progress.
///
/// Wrapping the write in this timeout keeps the serialization intact (the lock
/// is still held across the single write, so ordering/integrity are unchanged)
/// while bounding how long a wedged socket can hold it. A timed-out write
/// returns an error so teardown proceeds instead of hanging indefinitely. The
/// bound is generous so a merely-busy daemon is never tripped; only a genuinely
/// stuck socket reaches it.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

/// Write a single frame to the daemon, bounded by [`WRITE_TIMEOUT`] (CONC-013).
///
/// Preserves the caller's serialization (it is invoked while the `writer` mutex
/// guard is held, exactly as before), but a stalled socket can no longer hold
/// the lock forever: on timeout it returns an error and the write is abandoned.
async fn write_frame_timed(
    writer: &mut BoxedWriter,
    msg_type: u8,
    payload: &[u8],
) -> anyhow::Result<()> {
    match tokio::time::timeout(
        WRITE_TIMEOUT,
        protocol::write_frame_async(writer, msg_type, payload),
    )
    .await
    {
        Ok(res) => res.map_err(anyhow::Error::from),
        Err(_) => Err(anyhow::anyhow!(
            "daemon write (frame 0x{msg_type:02x}) timed out after {WRITE_TIMEOUT:?}"
        )),
    }
}

/// Returned by [`DaemonClient::connect_for_recovery`] when the daemon refuses
/// the connect because a live writer — another attached desktop's worker — is
/// already holding the session (AGT-015).
///
/// [`recover_sessions`] treats this as "owned by a live peer": it skips the
/// session and, unlike a genuine connect failure, leaves it in the shared
/// `state.json` so its live owner is undisturbed.
///
/// [`recover_sessions`]: crate::session::manager::SessionManager::recover_sessions
#[derive(Debug, thiserror::Error)]
#[error("session daemon refused recovery: a live connection is already attached")]
pub struct OwnedByLivePeer;

/// Result of [`DaemonClient::probe_holder`] on a live daemon (#3369).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeOutcome {
    /// No worker holds the session; it runs unattached.
    Free,
    /// Another live worker (another desktop) holds the session.
    HeldByPeer,
}

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

/// `connection.evicted` `reason`: a live takeover — another worker attached with
/// takeover intent and the daemon evicted this one ([`MSG_EVICTED`], SM-003).
pub const EVICTED_REASON_TAKEOVER: &str = "takeover";
/// `connection.evicted` `reason`: found held at worker start-up — session recovery
/// was refused because another live worker still owns the session (SM-003).
pub const EVICTED_REASON_HELD_BY_PEER: &str = "heldByPeer";

/// Build the `connection.evicted` notification (SM-003, single-attach).
pub(crate) fn evicted_notification(session_id: &str, reason: &str) -> JsonRpcNotification {
    JsonRpcNotification::new(
        CONNECTION_EVICTED,
        serde_json::json!({
            "session_id": session_id,
            "reason": reason,
        }),
    )
}

/// What the reader needs to act on an eviction (SM-003): the shared writer slot
/// it clears (so no input is ever written to a session this worker no longer
/// owns) and the flag it raises (so [`DaemonClient::is_evicted`] reports it).
#[derive(Clone)]
struct EvictionSink {
    writer: DaemonWriterHandle,
    evicted: Arc<AtomicBool>,
}

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
    /// Background reader task (stoppable, handing its read half back so
    /// [`detach`](Self::detach) can await the daemon's release, #3410).
    reader_task: Option<ReaderTask>,
    /// Whether this session is alive (daemon running, not exited).
    alive: Arc<AtomicBool>,
    /// Whether the daemon evicted this worker's connection because another
    /// worker took the session over (SM-003). The session itself is still alive
    /// (so [`alive`](Self::alive) stays `true`); a Reclaim ([`attach`](Self::attach))
    /// clears it by re-taking control.
    evicted: Arc<AtomicBool>,
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

    /// Probe who controls a still-running daemon **without keeping it**
    /// (#3369, tab-less recovery policy).
    ///
    /// Performs a recovery-intent connect (refused while a live writer — another
    /// desktop's worker — is attached, AGT-015) and, when it succeeds, detaches
    /// straight away so the session stays running unattached. The handshake's
    /// buffer replay goes to a throwaway channel, never to the desktop.
    ///
    /// - `Ok(ProbeOutcome::Free)`: nobody holds the session.
    /// - `Ok(ProbeOutcome::HeldByPeer)`: another live worker holds it.
    /// - `Err(_)`: the daemon is dead (e.g. its socket file merely lingers).
    pub async fn probe_holder(
        session_id: &str,
        endpoint: &str,
    ) -> Result<ProbeOutcome, anyhow::Error> {
        let (sink, _discard) = tokio::sync::mpsc::unbounded_channel();
        match Self::connect_for_recovery(session_id.to_string(), endpoint.to_string(), sink).await {
            Ok(mut client) => {
                client.detach().await;
                Ok(ProbeOutcome::Free)
            }
            Err(e) if e.downcast_ref::<OwnedByLivePeer>().is_some() => Ok(ProbeOutcome::HeldByPeer),
            Err(e) => Err(e),
        }
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
        let writer: DaemonWriterHandle = Arc::new(Mutex::new(None));
        let evicted = Arc::new(AtomicBool::new(false));

        let (reader_task, alive) = connect_and_start_reader(
            &endpoint,
            &session_id,
            notification_tx.clone(),
            pending_buffer_reply.clone(),
            on_exit.clone(),
            ConnectMode {
                fast_fail: for_recovery,
                recovery_intent: for_recovery,
            },
            EvictionSink {
                writer: writer.clone(),
                evicted: evicted.clone(),
            },
        )
        .await?;

        Ok(Self {
            session_id,
            endpoint,
            writer,
            reader_task: Some(reader_task),
            alive,
            evicted,
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
            write_frame_timed(writer, MSG_QUERY_BUFFER, &[]).await?;
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
        write_frame_timed(writer, MSG_INPUT, data).await?;
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
        write_frame_timed(writer, MSG_RESIZE, &payload).await?;
        Ok(())
    }

    /// Plain re-attach by reconnecting to the daemon socket (#3395).
    ///
    /// The daemon sends a BufferReplay on every new connection, so reconnecting
    /// gives us a fresh buffer replay. The reconnect declares **recovery** intent:
    /// a plain re-attach never evicts another desktop (SM-003, single-attach —
    /// taking over must always be an explicit user action). If another worker
    /// holds the session the daemon refuses it and this returns an
    /// [`OwnedByLivePeer`] error; the client is then left disconnected and marked
    /// [evicted](Self::is_evicted) (another desktop holds it) until an explicit
    /// [`take_over`](Self::take_over).
    pub async fn attach(&mut self) -> Result<(), anyhow::Error> {
        self.reconnect(false).await
    }

    /// Explicit **takeover** re-attach (SM-003 Reclaim / Take over): reconnect
    /// with takeover intent, so the daemon evicts whichever worker (another
    /// desktop) currently holds the session. Only ever reached from a
    /// user-initiated Reclaim — never from a plain attach.
    pub async fn take_over(&mut self) -> Result<(), anyhow::Error> {
        self.reconnect(true).await
    }

    /// Release this client's current connection (if any) and reconnect with the
    /// given intent.
    async fn reconnect(&mut self, takeover: bool) -> Result<(), anyhow::Error> {
        // Release the current connection cleanly first: aborting the reader and
        // sending `MSG_DETACH` makes the daemon drop us as its writer, so a
        // recovery-intent reconnect is not refused on account of our own stale
        // connection.
        self.detach().await;

        if takeover {
            // A takeover re-takes control from any other worker, so this
            // connection is no longer evicted.
            self.evicted.store(false, Ordering::SeqCst);
        }
        // Not the start-up recovery path — the daemon is a live session being
        // re-attached, so keep the long connect timeout. `detach` above already
        // waited for the daemon to release our own connection (#3410), so a
        // refusal here means another connection holds it. A plain re-attach still
        // retries such a refusal briefly: another worker's ownership probe
        // ([`probe_holder`](Self::probe_holder)) may hold it for a moment, and a
        // wedged daemon may not have acknowledged our detach in time.
        let mut attempt = 0;
        let (reader_task, alive) = loop {
            attempt += 1;
            let connected = connect_and_start_reader(
                &self.endpoint,
                &self.session_id,
                self.notification_tx.clone(),
                self.pending_buffer_reply.clone(),
                self.on_exit.clone(),
                ConnectMode {
                    fast_fail: false,
                    recovery_intent: !takeover,
                },
                EvictionSink {
                    writer: self.writer.clone(),
                    evicted: self.evicted.clone(),
                },
            )
            .await;
            match connected {
                Ok(ok) => break ok,
                Err(e) if e.downcast_ref::<OwnedByLivePeer>().is_some() => {
                    if attempt < PLAIN_REATTACH_RETRIES {
                        tokio::time::sleep(PLAIN_REATTACH_RETRY_DELAY).await;
                        continue;
                    }
                    // Another desktop holds the session: report it as held
                    // elsewhere until the user explicitly takes it over.
                    self.evicted.store(true, Ordering::SeqCst);
                    return Err(e);
                }
                Err(e) => return Err(e),
            }
        };

        self.evicted.store(false, Ordering::SeqCst);
        self.reader_task = Some(reader_task);
        self.alive = alive;

        if takeover {
            info!("Took over session {} (explicit takeover)", self.session_id);
        } else {
            info!("Reattached to session {}", self.session_id);
        }
        Ok(())
    }

    /// Detach from the daemon without killing it.
    ///
    /// Returns only once the daemon has **processed** the detach (#3410): when it
    /// handles `MSG_DETACH` it drops its writer to us (`agent_writer = None`) and
    /// closes the connection, so the EOF on our own read half is the daemon's
    /// acknowledgement that this worker no longer holds the session. Every daemon
    /// version behaves this way, so no protocol change is needed. Without this
    /// wait a probe or re-attach issued right after detach could reach the
    /// daemon's accept before it processed our detach (its event loop polls
    /// accept and agent commands concurrently) and be refused as "held by a live
    /// peer" — reliably so on the slower Windows named-pipe transport.
    ///
    /// Order matters (#2437). That detach-induced EOF must never reach the reader
    /// task: it would run the exit path and clear `alive` although the session is
    /// still very much alive on the daemon, and `settle_exited` would then flip
    /// the session to a *terminal* `Exited`. So the reader task is stopped — and
    /// its read half taken back — **before** `MSG_DETACH` is sent; the EOF is then
    /// consumed here, never by the reader. A genuine `MSG_EXITED` that arrived
    /// earlier was already handled on its own, so this ordering does not weaken
    /// natural-exit detection.
    ///
    /// The wait is bounded by [`DETACH_RELEASE_TIMEOUT`] so a wedged daemon can
    /// never hang a detach; the plain re-attach keeps its short refusal retry as
    /// a fallback for that case.
    pub async fn detach(&mut self) {
        // Stop observing the transport first, so the detach-induced EOF below is
        // never mistaken for the shell exiting.
        let reader = match self.reader_task.take() {
            Some(task) => task.stop().await,
            None => None,
        };
        // Ask the daemon to keep the session but drop this connection, then drop
        // our writer half.
        let sent = {
            let mut writer_guard = self.writer.lock().await;
            let sent = match writer_guard.as_mut() {
                Some(writer) => write_frame_timed(writer, MSG_DETACH, &[]).await.is_ok(),
                None => false,
            };
            *writer_guard = None;
            sent
        };
        // Wait for the daemon to release us (its EOF on our read half).
        if let (true, Some(reader)) = (sent, reader) {
            if !await_daemon_release(reader).await {
                warn!(
                    "Session {} daemon did not acknowledge detach within {:?}",
                    self.session_id, DETACH_RELEASE_TIMEOUT
                );
            }
        }
        debug!("Detached from session {}", self.session_id);
    }

    /// Send kill frame and disconnect.
    pub async fn close(&mut self) {
        // Send Kill frame if connected
        {
            let mut guard = self.writer.lock().await;
            if let Some(ref mut writer) = *guard {
                let _ = write_frame_timed(writer, MSG_KILL, &[]).await;
            }
        }
        self.disconnect().await;
        info!("Closed session {}", self.session_id);
    }

    /// Whether the daemon is still alive.
    /// Whether another worker took this session over (SM-003): the daemon sent
    /// [`MSG_EVICTED`] and dropped this connection. The session is still alive on
    /// the daemon; [`attach`](Self::attach) takes control back.
    pub fn is_evicted(&self) -> bool {
        self.evicted.load(Ordering::SeqCst)
    }

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

/// Fetch the current Tokio runtime handle for a synchronous [`ProcessHandle`]
/// call, degrading to a recoverable error instead of panicking when there is no
/// runtime (AGT-025).
///
/// The synchronous `ProcessHandle` methods normally run on a `spawn_blocking`
/// thread, where a runtime handle is in scope and `Handle::current()` is fine.
/// But `Handle::current()` *panics* if a method is ever invoked with no runtime
/// at all; `try_current` lets us surface that as an `Err` on the write paths
/// rather than unwinding across the FFI/trait boundary.
fn current_runtime_handle(
    op: &str,
) -> Result<tokio::runtime::Handle, termihub_core::errors::SessionError> {
    tokio::runtime::Handle::try_current().map_err(|_| {
        warn!("DaemonClient::{op} called outside a Tokio runtime; cannot reach daemon");
        termihub_core::errors::SessionError::Io(std::io::Error::other(format!(
            "no Tokio runtime available for daemon {op}"
        )))
    })
}

impl termihub_core::session::traits::ProcessHandle for DaemonClient {
    fn write_input(&self, data: &[u8]) -> Result<(), termihub_core::errors::SessionError> {
        let handle = current_runtime_handle("write_input")?;
        handle
            .block_on(async {
                let mut guard = self.writer.lock().await;
                let writer = guard.as_mut().ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::NotConnected, "not connected to daemon")
                })?;
                write_frame_timed(writer, MSG_INPUT, data).await
            })
            .map_err(|e| {
                termihub_core::errors::SessionError::Io(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    e.to_string(),
                ))
            })
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), termihub_core::errors::SessionError> {
        let handle = current_runtime_handle("resize")?;
        handle
            .block_on(async {
                let mut guard = self.writer.lock().await;
                let writer = guard.as_mut().ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::NotConnected, "not connected to daemon")
                })?;
                let payload = protocol::encode_resize(cols, rows);
                write_frame_timed(writer, MSG_RESIZE, &payload).await
            })
            .map_err(|e| {
                termihub_core::errors::SessionError::Io(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    e.to_string(),
                ))
            })
    }

    fn close(&self) -> Result<(), termihub_core::errors::SessionError> {
        // close is best-effort cleanup: without a runtime we cannot send the
        // kill frame, but we can still mark the session dead. Degrade to a
        // logged no-op instead of panicking (AGT-025).
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => handle.block_on(async {
                let mut guard = self.writer.lock().await;
                if let Some(ref mut writer) = *guard {
                    let _ = write_frame_timed(writer, MSG_KILL, &[]).await;
                }
                // Drop the writer half — the reader task will exit on EOF.
                *guard = None;
            }),
            Err(_) => warn!(
                "DaemonClient::close called outside a Tokio runtime; \
                 skipping kill frame, marking session {} dead",
                self.session_id
            ),
        }
        self.alive.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
}

/// Connect to the daemon endpoint, wait for the Ready frame, and start the reader task.
///
/// Stores the writer half into `eviction.writer` (before the reader starts, so an
/// eviction can never race ahead of it) and returns the reader task handle and
/// the alive flag.
/// How often a plain [`DaemonClient::attach`] retries a recovery connect that was
/// refused as "held by a live peer" before reporting the session as held by
/// another desktop (#3395). A refusal can be transient: another worker's
/// ownership probe may hold the daemon for a few milliseconds. (This client's own
/// `MSG_DETACH` is awaited by [`DaemonClient::detach`] since #3410, so it no longer
/// causes one unless the daemon is too wedged to acknowledge it in time.)
const PLAIN_REATTACH_RETRIES: u32 = 3;

/// Delay between the [`PLAIN_REATTACH_RETRIES`] attempts.
const PLAIN_REATTACH_RETRY_DELAY: Duration = Duration::from_millis(150);

/// Upper bound on [`DaemonClient::detach`] waiting for the daemon to release the
/// connection after `MSG_DETACH` (#3410). A responsive daemon closes it within
/// milliseconds; the bound only keeps a wedged daemon from hanging a detach.
const DETACH_RELEASE_TIMEOUT: Duration = Duration::from_secs(5);

/// Upper bound on a reader task honouring its stop signal. The task stops at its
/// next poll, so this only guards against a task wedged inside an exit hook.
const READER_STOP_TIMEOUT: Duration = Duration::from_secs(2);

/// A running daemon reader task, stoppable so the read half can be taken back
/// (#3410): [`DaemonClient::detach`] needs it to observe the daemon releasing the
/// connection without letting the reader mistake that EOF for an exit (#2437).
struct ReaderTask {
    handle: tokio::task::JoinHandle<Option<BoxedReader>>,
    stop: tokio::sync::oneshot::Sender<()>,
}

impl ReaderTask {
    /// Stop the task and take its read half back. `None` when the loop had
    /// already ended on its own (exit, eviction, transport error) — its read half
    /// is gone with it — or the task did not honour the stop in time.
    async fn stop(mut self) -> Option<BoxedReader> {
        let _ = self.stop.send(());
        match tokio::time::timeout(READER_STOP_TIMEOUT, &mut self.handle).await {
            Ok(Ok(reader)) => reader,
            Ok(Err(_)) => None,
            Err(_) => {
                self.handle.abort();
                None
            }
        }
    }

    /// Abort the task outright, dropping its read half.
    fn abort(self) {
        self.handle.abort();
    }
}

/// Drain `reader` until the daemon closes the connection (EOF or a transport
/// error), bounded by [`DETACH_RELEASE_TIMEOUT`]. Frames still in flight (output
/// produced before the daemon processed the detach) are discarded, exactly as the
/// stopped reader would have dropped them; the daemon's ring buffer still holds
/// them for the next attach's replay. Returns whether the release was observed.
async fn await_daemon_release(mut reader: BoxedReader) -> bool {
    let drain = async move {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    };
    tokio::time::timeout(DETACH_RELEASE_TIMEOUT, drain)
        .await
        .is_ok()
}

/// How [`connect_and_start_reader`] connects to a daemon.
#[derive(Debug, Clone, Copy)]
struct ConnectMode {
    /// Use the short recovery connect timeout, fast-failing a dead-but-lingering
    /// socket (#2476), instead of the long spawn-path one.
    fast_fail: bool,
    /// Declare [`INTENT_RECOVERY`] (refused while another live worker holds the
    /// session, AGT-015) rather than [`INTENT_TAKEOVER`] (evicts the holder).
    recovery_intent: bool,
}

#[allow(clippy::too_many_arguments)]
async fn connect_and_start_reader(
    endpoint: &str,
    session_id: &str,
    notification_tx: NotificationSender,
    pending_buffer_reply: Arc<Mutex<Option<tokio::sync::oneshot::Sender<Vec<u8>>>>>,
    on_exit: ExitHookSlot,
    mode: ConnectMode,
    eviction: EvictionSink,
) -> Result<(ReaderTask, Arc<AtomicBool>), anyhow::Error> {
    // Recovery targets an already-bound daemon and must fast-fail a dead-but-
    // lingering socket rather than pay the long spawn-path connect timeout (#2476).
    let (mut reader, mut writer) = if mode.fast_fail {
        transport::connect_for_recovery(endpoint).await?
    } else {
        transport::connect(endpoint).await?
    };

    // AGT-015: declare our attach intent as the very first frame. A recovery
    // connect asks the daemon to refuse (rather than evict) a live writer that
    // another attached desktop's worker still holds; every other path takes over
    // as before. A pre-AGT-015 daemon ignores this frame, so recovery of a
    // session hosted by an older daemon still works (the guard just does not
    // apply there).
    let intent = if mode.recovery_intent {
        INTENT_RECOVERY
    } else {
        INTENT_TAKEOVER
    };
    protocol::write_frame_async(&mut writer, MSG_ATTACH_INTENT, &[intent]).await?;

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
                // AGT-015: the daemon refused a recovery connect because a live
                // writer (another attached desktop) still owns the session. Surface
                // it as a typed error so recovery skips the session without tearing
                // it down; any other daemon error keeps the historical handling.
                MSG_ERROR if frame.payload == ERR_OWNED_BY_LIVE_PEER => {
                    return Err(OwnedByLivePeer.into());
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

    // Publish the writer before the reader starts so an eviction observed by the
    // reader always clears *this* connection's writer (SM-003).
    *eviction.writer.lock().await = Some(writer);

    // Start the background reader task
    let alive_clone = alive.clone();
    let session_id_owned = session_id.to_string();
    let tx = notification_tx.clone();

    // Stoppable (#3410): `detach` stops the loop and takes the read half back
    // to await the daemon's release. A dropped sender (the client was dropped
    // without detaching) is not a stop request — keep reading, as before.
    let (stop, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let handle = tokio::spawn(async move {
        let mut reader = reader;
        let stop_requested = async move {
            if stop_rx.await.is_err() {
                std::future::pending::<()>().await;
            }
        };
        let stopped = tokio::select! {
            biased;
            () = stop_requested => true,
            () = reader_loop_inner(
                &mut reader,
                &session_id_owned,
                &tx,
                &alive_clone,
                pending_buffer_reply,
                on_exit,
                Some(&eviction),
            ) => false,
        };
        stopped.then_some(reader)
    });

    Ok((ReaderTask { handle, stop }, alive))
}

/// Background task that reads frames from the daemon and sends notifications.
///
/// Test entry point without an eviction sink; production uses
/// [`reader_loop_inner`] with one.
#[cfg(test)]
async fn reader_loop(
    mut reader: BoxedReader,
    session_id: &str,
    notification_tx: &NotificationSender,
    alive: &AtomicBool,
    pending_buffer_reply: Arc<Mutex<Option<tokio::sync::oneshot::Sender<Vec<u8>>>>>,
    on_exit: ExitHookSlot,
) {
    reader_loop_inner(
        &mut reader,
        session_id,
        notification_tx,
        alive,
        pending_buffer_reply,
        on_exit,
        None,
    )
    .await;
}

/// The reader loop proper. `eviction` receives an [`MSG_EVICTED`] frame (SM-003).
async fn reader_loop_inner(
    reader: &mut BoxedReader,
    session_id: &str,
    notification_tx: &NotificationSender,
    alive: &AtomicBool,
    pending_buffer_reply: Arc<Mutex<Option<tokio::sync::oneshot::Sender<Vec<u8>>>>>,
    on_exit: ExitHookSlot,
    eviction: Option<&EvictionSink>,
) {
    loop {
        // Steady-state reads use the mid-frame timeout (#3015): a peer that
        // begins a frame and then wedges must fail the session (so reconnect /
        // redrive takes over) instead of parking this reader task forever. The
        // wait for a frame's first byte stays unbounded, so an idle-but-alive
        // session — no output for hours — is never torn down.
        match protocol::read_session_frame_timeout(reader).await {
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
                        CONNECTION_EXIT,
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
                MSG_EVICTED => {
                    // SM-003 (single-attach): another worker (another desktop) took
                    // this session over. The session is still alive on the daemon,
                    // so do NOT mark it dead or run the exit hook — surface an
                    // explicit eviction instead and stop writing to it. The daemon
                    // drops this connection right after; there is nothing more to
                    // read. A Reclaim (`attach`) reconnects with a fresh reader.
                    info!("Session {session_id} was taken over by another connection");
                    if let Some(sink) = eviction {
                        sink.evicted.store(true, Ordering::SeqCst);
                        *sink.writer.lock().await = None;
                    }
                    let _ = notification_tx
                        .send(evicted_notification(session_id, EVICTED_REASON_TAKEOVER));
                    return;
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
            CONNECTION_OUTPUT,
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

    /// SM-003: an `MSG_EVICTED` frame is an eviction, not an exit — the reader
    /// emits a typed `connection.evicted` notification, clears the writer so no
    /// further input reaches a session another desktop controls, raises the
    /// evicted flag, keeps the session alive and does NOT run the exit hook.
    #[tokio::test]
    async fn reader_loop_reports_eviction_without_exiting() {
        let (client_sock, mut server_sock) = tokio::io::duplex(64 * 1024);
        tokio::spawn(async move {
            protocol::write_frame_async(&mut server_sock, MSG_EVICTED, &[])
                .await
                .unwrap();
            // Keep the daemon end open: the reader must return on the frame
            // itself, not wait for the EOF.
            tokio::time::sleep(Duration::from_secs(30)).await;
            drop(server_sock);
        });

        let mut reader: BoxedReader = Box::new(client_sock);
        let (on_exit, ran) = recording_exit_hook();
        let alive = Arc::new(AtomicBool::new(true));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let (_unused_reader, writer_half) = tokio::io::duplex(64);
        let sink = EvictionSink {
            writer: Arc::new(Mutex::new(Some(Box::new(writer_half) as BoxedWriter))),
            evicted: Arc::new(AtomicBool::new(false)),
        };

        tokio::time::timeout(
            Duration::from_secs(5),
            reader_loop_inner(
                &mut reader,
                "sess",
                &tx,
                &alive,
                Arc::new(Mutex::new(None)),
                on_exit,
                Some(&sink),
            ),
        )
        .await
        .expect("the reader returns on the evicted frame");

        let n = rx.try_recv().expect("a connection.evicted notification");
        assert_eq!(n.method, CONNECTION_EVICTED);
        assert_eq!(n.params["session_id"], "sess");
        assert_eq!(n.params["reason"], EVICTED_REASON_TAKEOVER);
        assert!(sink.evicted.load(Ordering::SeqCst), "evicted flag raised");
        assert!(sink.writer.lock().await.is_none(), "writer cleared");
        assert!(alive.load(Ordering::SeqCst), "an eviction is not an exit");
        assert!(
            !ran.load(Ordering::SeqCst),
            "the exit hook must not run for an eviction"
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

    /// #3015 (wedged peer): a daemon that begins a frame and then wedges —
    /// writes a partial frame and never completes it, while the socket stays
    /// connected — must fail the session within a bounded time so the normal
    /// reconnect/redrive path takes over, rather than parking the reader forever.
    ///
    /// `start_paused` lets [`SESSION_MID_FRAME_TIMEOUT`] elapse in virtual time,
    /// so the test is instant yet exercises the real mid-frame timeout path.
    #[tokio::test(start_paused = true)]
    async fn reader_loop_fails_a_peer_that_stalls_mid_frame() {
        use tokio::io::AsyncWriteExt;

        let (client_sock, mut server_sock) = tokio::io::duplex(64 * 1024);
        // The daemon side writes a single frame-type byte, beginning a frame, then
        // stalls forever without sending the rest. The connection stays open, so
        // the client sees a mid-frame stall — not an EOF.
        server_sock
            .write_all(&[MSG_OUTPUT])
            .await
            .expect("write partial frame header");

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

        assert!(
            !alive.load(Ordering::SeqCst),
            "a peer that wedges mid-frame must be marked dead (#3015)"
        );
        assert!(
            ran.load(Ordering::SeqCst),
            "the exit hook must fire so reconnect/redrive takes over (#3015)"
        );
        // Keep the daemon side alive until after the timeout fired.
        drop(server_sock);
    }

    /// #3015 (idle guardrail): an idle-but-alive session — the peer sends no
    /// bytes at all but the connection stays open — must NEVER be torn down. The
    /// mid-frame timeout only bounds a frame that has *started*; with no first
    /// byte in flight the reader waits unbounded, exactly as a shell parked at a
    /// prompt for hours requires.
    #[tokio::test(start_paused = true)]
    async fn reader_loop_keeps_an_idle_but_alive_peer() {
        let (client_sock, server_sock) = tokio::io::duplex(64 * 1024);
        // The peer is idle: it sends nothing, but never drops the connection.

        let reader: BoxedReader = Box::new(client_sock);
        let (on_exit, ran) = recording_exit_hook();
        let alive = Arc::new(AtomicBool::new(true));
        let alive_for_task = alive.clone();
        let ran_for_task = ran.clone();
        let pbr = Arc::new(Mutex::new(None));

        let task = tokio::spawn(async move {
            reader_loop(
                reader,
                "sess",
                &make_notification_tx(),
                &alive_for_task,
                pbr,
                on_exit,
            )
            .await;
            // If the reader ever returns, the session was (wrongly) torn down.
            ran_for_task.store(true, Ordering::SeqCst);
        });

        // Advance far past any mid-frame timeout. Because the peer sent no first
        // byte, there is no mid-frame timer at all — the reader must stay parked.
        tokio::time::advance(Duration::from_secs(3600)).await;
        tokio::task::yield_now().await;

        assert!(
            alive.load(Ordering::SeqCst),
            "an idle-but-alive peer must NOT be torn down (#3015)"
        );
        assert!(
            !ran.load(Ordering::SeqCst),
            "no exit path may run for a merely-idle session (#3015)"
        );
        assert!(
            !task.is_finished(),
            "the reader must still be parked waiting for the next frame (#3015)"
        );

        task.abort();
        drop(server_sock);
    }

    /// Regression for #2437: a clean [`DaemonClient::detach`] must leave the
    /// daemon-backed session reported as **alive**.
    ///
    /// The real daemon drops its writer to us the moment it processes
    /// `MSG_DETACH` (`agent_writer = None`), closing the connection. If the
    /// client's reader task observed that EOF it would run the natural-exit path
    /// and clear `alive`; `settle_exited` then flips the session to a *terminal*
    /// `Exited`, and the next re-attach fails with `-32001 Session not running`.
    /// `detach` stops the reader and takes its read half back **before** sending
    /// `MSG_DETACH`, then consumes the EOF itself (#3410), so the reader never
    /// sees it. The mock closes the instant it reads `MSG_DETACH` — production's
    /// tightest schedule — which is deterministic now that the reader is stopped
    /// synchronously rather than aborted asynchronously (the #2459 flake).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn detach_keeps_session_alive_when_daemon_closes_connection() {
        let session_id = unique_session_id("itest-detach-alive");
        let endpoint = transport::session_endpoint(&session_id);

        let mut listener = transport::DaemonListener::bind(&endpoint)
            .await
            .expect("bind mock daemon");

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
        server.await.expect("mock daemon task");

        assert!(
            client.is_alive(),
            "a clean detach must not mark the still-alive session dead (#2437)"
        );
        assert!(
            !exit_ran.load(Ordering::SeqCst),
            "the detach-induced EOF must not be mistaken for a natural exit (#2437)"
        );
    }

    /// Regression for #3410: [`DaemonClient::detach`] returns only once the
    /// daemon has **processed** the detach, i.e. released this connection.
    ///
    /// The mock daemon deliberately takes a while to act on `MSG_DETACH` (as a
    /// busy daemon whose event loop serves `accept` before the queued detach
    /// does) and records when it releases the connection. Before #3410 `detach`
    /// returned as soon as the frame was written, so a probe or re-attach issued
    /// right after could still find this worker holding the session and be
    /// refused as held by a live peer.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn detach_waits_for_daemon_to_release_connection() {
        let session_id = unique_session_id("itest-detach-ack");
        let endpoint = transport::session_endpoint(&session_id);
        let mut listener = transport::DaemonListener::bind(&endpoint)
            .await
            .expect("bind mock daemon");

        let released = Arc::new(AtomicBool::new(false));
        let released_server = released.clone();
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
            // A slow daemon: output still flows for a while before the detach is
            // processed; the client must discard it and keep waiting.
            for _ in 0..5 {
                let _ = protocol::write_frame_async(&mut writer, MSG_OUTPUT, b"late").await;
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
            released_server.store(true, Ordering::SeqCst);
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

        client.detach().await;
        assert!(
            released.load(Ordering::SeqCst),
            "detach must not return before the daemon released the connection (#3410)"
        );
        assert!(client.is_alive(), "a detached session stays alive");
        assert!(!exit_ran.load(Ordering::SeqCst), "detach is not an exit");

        server.await.expect("mock daemon task");
    }

    /// A per-test unique session id so parallel tests never share an endpoint.
    fn unique_session_id(prefix: &str) -> String {
        format!(
            "{prefix}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }

    /// AGT-015 (client half): a recovery connect declares [`INTENT_RECOVERY`] as
    /// its first frame, and when the daemon refuses with the
    /// [`ERR_OWNED_BY_LIVE_PEER`] marker the client surfaces it as the typed
    /// [`OwnedByLivePeer`] error (so recovery can skip the session without
    /// tearing it down).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recovery_refusal_maps_to_owned_by_live_peer() {
        let session_id = format!(
            "itest-agt015-refuse-{}-{}",
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

        let server = tokio::spawn(async move {
            let (mut reader, mut writer) = listener.accept().await.expect("accept");
            // First frame must be the recovery attach-intent.
            let frame = protocol::read_frame_async(&mut reader)
                .await
                .expect("read intent")
                .expect("intent frame present");
            assert_eq!(frame.msg_type, MSG_ATTACH_INTENT);
            assert_eq!(frame.payload, vec![INTENT_RECOVERY]);
            // Refuse: a live writer already owns the session.
            protocol::write_frame_async(&mut writer, MSG_ERROR, ERR_OWNED_BY_LIVE_PEER)
                .await
                .expect("send refusal");
            listener.cleanup();
        });

        let err =
            match DaemonClient::connect_for_recovery(session_id, endpoint, make_notification_tx())
                .await
            {
                Ok(_) => panic!("refused recovery must return an error"),
                Err(e) => e,
            };
        assert!(
            err.downcast_ref::<OwnedByLivePeer>().is_some(),
            "refusal must map to OwnedByLivePeer, got: {err:#}"
        );

        server.await.expect("mock daemon task");
    }

    /// Build a `DaemonClient` with no live transport, for unit tests that only
    /// exercise the synchronous [`ProcessHandle`](termihub_core::session::traits::ProcessHandle)
    /// methods (which touch only `writer`/`alive`, never the network).
    fn disconnected_client() -> DaemonClient {
        DaemonClient {
            session_id: "test-session".into(),
            endpoint: "test-endpoint".into(),
            writer: Arc::new(Mutex::new(None)),
            reader_task: None,
            alive: Arc::new(AtomicBool::new(true)),
            evicted: Arc::new(AtomicBool::new(false)),
            notification_tx: make_notification_tx(),
            pending_buffer_reply: Arc::new(Mutex::new(None)),
            on_exit: Arc::new(OnceLock::new()),
        }
    }

    /// AGT-025: the synchronous `ProcessHandle` methods must **not panic** when
    /// invoked outside a Tokio runtime. `Handle::current()` panics there; the
    /// fixed methods use `Handle::try_current()` and degrade gracefully — a
    /// recoverable error for the write paths, a logged no-op for `close`.
    ///
    /// This is a plain `#[test]` on purpose: it runs with no runtime in scope,
    /// which is exactly the condition that used to unwind.
    #[test]
    fn sync_process_handle_methods_do_not_panic_without_a_runtime() {
        use termihub_core::session::traits::ProcessHandle;

        let client = disconnected_client();

        // write_input / resize surface a recoverable error rather than panicking.
        assert!(
            client.write_input(b"hello").is_err(),
            "write_input must return an error, not panic, without a runtime"
        );
        assert!(
            client.resize(80, 24).is_err(),
            "resize must return an error, not panic, without a runtime"
        );

        // close degrades to a no-op that still marks the session dead.
        assert!(client.is_alive(), "sanity: starts alive");
        assert!(
            client.close().is_ok(),
            "close must be an infallible no-op, not panic, without a runtime"
        );
        assert!(
            !client.is_alive(),
            "close must still mark the session dead even without a runtime"
        );
    }

    /// AGT-015 (client half): a normal (spawn / re-attach) connect declares
    /// [`INTENT_TAKEOVER`] as its first frame, preserving evict-on-accept.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn spawn_connect_declares_takeover_intent_first() {
        let session_id = format!(
            "itest-agt015-takeover-{}-{}",
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

        let server = tokio::spawn(async move {
            let (mut reader, mut writer) = listener.accept().await.expect("accept");
            let frame = protocol::read_frame_async(&mut reader)
                .await
                .expect("read intent")
                .expect("intent frame present");
            assert_eq!(frame.msg_type, MSG_ATTACH_INTENT);
            assert_eq!(frame.payload, vec![INTENT_TAKEOVER]);
            // Complete the handshake so the client connect succeeds.
            protocol::write_frame_async(&mut writer, MSG_READY, &[])
                .await
                .expect("send ready");
            // Keep the connection open briefly so the client's reader has a live
            // socket after the handshake.
            tokio::time::sleep(Duration::from_millis(50)).await;
            listener.cleanup();
        });

        let client = DaemonClient::connect(session_id, endpoint, make_notification_tx())
            .await
            .expect("takeover connect must complete the handshake");
        assert!(client.is_alive());

        server.await.expect("mock daemon task");
    }

    /// A writer whose writes never complete — models a wedged daemon socket
    /// whose kernel buffer is full because the daemon has stopped reading
    /// (CONC-013). `poll_write`/`poll_flush` park forever, exactly as a real
    /// backpressured socket does once its send buffer fills.
    struct StalledWriter;

    impl tokio::io::AsyncWrite for StalledWriter {
        fn poll_write(
            self: Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            _buf: &[u8],
        ) -> std::task::Poll<std::io::Result<usize>> {
            std::task::Poll::Pending
        }
        fn poll_flush(
            self: Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Pending
        }
        fn poll_shutdown(
            self: Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    /// CONC-013: a write to a wedged daemon socket (one that never accepts
    /// bytes) must time out and return an error instead of holding the writer
    /// lock forever. `start_paused` lets [`WRITE_TIMEOUT`] elapse in virtual
    /// time, so the test is instant yet exercises the real timeout path — the
    /// property that keeps a hung daemon from wedging input/detach/close.
    #[tokio::test(start_paused = true)]
    async fn write_frame_timed_bounds_a_wedged_socket() {
        let mut writer: BoxedWriter = Box::new(StalledWriter);
        let result = write_frame_timed(&mut writer, MSG_INPUT, b"stuck").await;
        assert!(
            result.is_err(),
            "a write to a wedged socket must time out, not hang"
        );
    }

    /// CONC-013: the timeout wrapper is transparent on a healthy socket —
    /// frames are written intact and in order, so wrapping the write does not
    /// weaken the frame serialization the writer lock provides.
    #[tokio::test]
    async fn write_frame_timed_preserves_frame_order_on_healthy_socket() {
        let (client_sock, server_sock) = tokio::io::duplex(64 * 1024);
        let (mut server_reader, _server_writer) = tokio::io::split(server_sock);
        let (_client_reader, client_writer) = tokio::io::split(client_sock);
        let mut writer: BoxedWriter = Box::new(client_writer);

        write_frame_timed(&mut writer, MSG_INPUT, b"first")
            .await
            .expect("healthy write must succeed");
        write_frame_timed(&mut writer, MSG_RESIZE, b"2nd")
            .await
            .expect("healthy write must succeed");

        let f1 = protocol::read_frame_async(&mut server_reader)
            .await
            .unwrap()
            .unwrap();
        let f2 = protocol::read_frame_async(&mut server_reader)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(f1.msg_type, MSG_INPUT);
        assert_eq!(f1.payload, b"first");
        assert_eq!(f2.msg_type, MSG_RESIZE);
        assert_eq!(f2.payload, b"2nd");
    }
}
