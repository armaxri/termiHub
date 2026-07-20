//! RDP graphical remote-desktop backend, via a **separately-built sidecar**.
//!
//! IronRDP's CredSSP crypto (`picky`/`sspi`) and `russh` pin mutually
//! incompatible RustCrypto pre-releases, and Cargo allows one version per crate
//! per lockfile (#1725). So the RDP decoder cannot live in the same build unit
//! as the SSH backend. #1747's resolution: put the IronRDP-linking code in a
//! workspace-**excluded** crate with its own `Cargo.lock` — the
//! `termihub-rdp-helper` sidecar (`../../../../rdp-sidecar/`) — and keep only
//! this thin adapter in `termihub-core`. The adapter links no RDP crate; it
//! spawns the sidecar per session and bridges its [`protocol`] IPC into the
//! shared #1680 layer.
//!
//! ```text
//!            shared frontend (canvas / input / clipboard)   ← 100% untouched
//!                     ▲ FrameUpdate/CursorUpdate │ InputEvent
//!            ┌────────┴───────────────────────────▼─────────┐
//!            │ SidecarRdp  (this file — GraphicalBackend)    │   termihub-core
//!            └────────▲ SidecarMessage ──── HostMessage ▼────┘   (no IronRDP)
//!                     │        stdout  ↑↓  stdin          │
//!            ┌────────┴───────────────────────────▼─────────┐
//!            │ termihub-rdp-helper (IronRDP)                 │   excluded crate
//!            └───────────────────────────────────────────────┘   (own Cargo.lock)
//! ```
//!
//! It registers additively beside VNC (#1681) and the mock (#1680) under the
//! same [`GraphicalBackend`] trait — one `register(...)` call, no shared match
//! arm — and, reporting `graphical: true`, is experimental-gated (#1705) with no
//! per-protocol wiring.
//!
//! ## v1 scope
//!
//! Connect (TLS/NLA) → decode frames → keyboard/pointer/wheel input → server
//! cursor → Display-Control dynamic resize (#1755) → CLIPRDR text clipboard both
//! ways (#1756) → RDPDR drive redirection of one opted-in folder (#1757) →
//! rdpsnd audio output played on the host (#1764, macOS/Windows). CLIPRDR file
//! transfer remains a sequenced follow-up. Every one of these is configured
//! purely through [`config::RdpConfig`] (`driveRedirection` / `sharedFolderPath`
//! / `driveName` / `audioRedirection`), which flows to the sidecar in
//! `HostMessage::Connect`, so this adapter needs no per-feature wiring — audio in
//! particular is decoded **and played** inside the sidecar process, never
//! crossing this IPC boundary.

pub mod config;
pub mod integrity;
pub mod protocol;

pub use config::rdp_settings_schema;

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use crate::connection::{
    AuthKind, Capabilities, CertPrompt, CertPromptReceiver, ConnectionType, CursorReceiver,
    FrameReceiver, GraphicalBackend, GraphicalCapabilities, InputEvent, OutputReceiver,
    RemoteClipboardFile, SettingsSchema,
};
use crate::errors::SessionError;
use crate::files::FileBrowser;
use crate::monitoring::MonitoringProvider;

use config::RdpConfig;
use protocol::{read_message, write_message, HostMessage, SidecarMessage};

/// Bounded channel depth for frames / cursor updates / input (backpressure).
const CHANNEL_DEPTH: usize = 32;

/// Windows `CREATE_NO_WINDOW` process-creation flag (#1758).
///
/// The desktop is a GUI-subsystem process; spawning the console-subsystem
/// sidecar from it makes Windows allocate a fresh console, which flashes a
/// window on every RDP connect. This flag gives the child no console at all.
/// stdout/stdin are piped and stderr is inherited, so those handles (and the
/// sidecar's stderr logging) are unaffected — only the phantom console goes away.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Environment variable that overrides the sidecar binary path (dev + tests).
pub const HELPER_PATH_ENV: &str = "TERMIHUB_RDP_HELPER";

/// The sidecar binary's file name, as built by `scripts/build-rdp-sidecar.*`.
#[cfg(windows)]
pub const HELPER_BIN_NAME: &str = "termihub-rdp-helper.exe";
/// The sidecar binary's file name, as built by `scripts/build-rdp-sidecar.*`.
#[cfg(not(windows))]
pub const HELPER_BIN_NAME: &str = "termihub-rdp-helper";

/// Resolve the sidecar binary path: `$TERMIHUB_RDP_HELPER`, then next to the
/// running executable (where Tauri places a bundled sidecar), then the bare
/// name (resolved on `PATH` at spawn time).
///
/// Only the first two are validated to exist; the bare-name fallback defers to
/// the OS so a helper on `PATH` still works, and a genuinely-missing binary
/// surfaces as an actionable spawn error.
pub fn resolve_helper_binary() -> PathBuf {
    if let Some(p) = std::env::var_os(HELPER_PATH_ENV) {
        let p = PathBuf::from(p);
        if p.is_file() {
            return p;
        }
        warn!(
            path = %p.display(),
            "{HELPER_PATH_ENV} is set but is not a file — falling back to default resolution"
        );
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let cand = dir.join(HELPER_BIN_NAME);
            if cand.is_file() {
                return cand;
            }
        }
    }
    PathBuf::from(HELPER_BIN_NAME)
}

/// Wrap a message as a [`SessionError::Io`] (its inner type is a
/// [`std::io::Error`], so a plain string needs boxing).
fn io_error(message: impl Into<String>) -> SessionError {
    SessionError::Io(std::io::Error::other(message.into()))
}

/// Validate a remote-supplied basename before it becomes a host temp-file name
/// (#1793) — defence in depth over the sidecar's own sanitisation. Rejects an
/// empty name, `.`/`..`, and anything carrying a path separator, drive-letter
/// colon or NUL, so a hostile name can never escape the per-fetch staging
/// directory. Returns the name unchanged when it is safe.
fn sanitize_leaf(name: &str) -> Option<&str> {
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    if name.contains(['/', '\\', '\0', ':']) {
        return None;
    }
    Some(name)
}

/// Build the staging path a fetched clipboard file's bytes are written to
/// (#1793): a per-fetch subdirectory of the OS temp dir holding the sanitized
/// basename. A fresh directory per `request_id` means two files with the same
/// name never collide, and the sanitized leaf cannot escape it.
fn staged_path_for(meta: &RemoteClipboardFile, request_id: u64) -> Result<PathBuf, SessionError> {
    let name = sanitize_leaf(&meta.name)
        .ok_or_else(|| io_error(format!("unsafe clipboard file name {:?}", meta.name)))?;
    let dir = std::env::temp_dir().join(format!(
        "termihub-rdp-clip-{}-{}",
        std::process::id(),
        request_id
    ));
    std::fs::create_dir_all(&dir)
        .map_err(|e| io_error(format!("failed to create clipboard staging dir: {e}")))?;
    Ok(dir.join(name))
}

/// Removes an in-flight fetch's channel registration when the
/// `fetch_remote_clipboard_file` call returns, however it returns — so a
/// cancelled or failed fetch never leaks its slot in [`SidecarShared::fetches`].
struct FetchGuard {
    shared: Arc<SidecarShared>,
    request_id: u64,
}

impl Drop for FetchGuard {
    fn drop(&mut self) {
        if let Ok(mut fetches) = self.shared.fetches.lock() {
            fetches.remove(&self.request_id);
        }
    }
}

/// One event of an in-flight remote-clipboard file fetch (#1793), routed from the
/// reader task to the `fetch_remote_clipboard_file` caller by `request_id`.
#[derive(Debug)]
enum FetchEvent {
    /// One streamed chunk; `last` marks the final one.
    Chunk {
        position: u64,
        data: Vec<u8>,
        last: bool,
    },
    /// The fetch failed (unknown/withdrawn index, remote read error).
    Error(String),
}

/// Shared, interior-mutable state touched by the reader task and the
/// `GraphicalBackend` command methods.
struct SidecarShared {
    /// Latest remote clipboard text, surfaced via `get_clipboard`.
    clipboard: Mutex<String>,
    /// The files the remote most recently copied, surfaced for a local paste
    /// (delayed rendering, #1793). Replaced wholesale on each remote copy.
    remote_clipboard_files: Mutex<Vec<RemoteClipboardFile>>,
    /// In-flight file fetches keyed by request id: the reader task forwards each
    /// [`FetchEvent`] to the waiting `fetch_remote_clipboard_file` call (#1793).
    fetches: StdMutex<HashMap<u64, mpsc::UnboundedSender<FetchEvent>>>,
    /// Suppress input when the session is view-only.
    view_only: bool,
}

/// Live runtime of a connected sidecar session.
struct SidecarRuntime {
    /// Messages flow to the sidecar's stdin over this channel (via the writer task).
    to_sidecar: mpsc::Sender<HostMessage>,
    shared: Arc<SidecarShared>,
    /// Monotonic id allocator correlating a `FetchClipboardFile` to its streamed
    /// chunk responses (#1793).
    next_fetch_id: AtomicU64,
    cancel: CancellationToken,
}

/// RDP graphical remote-desktop connection backed by the IronRDP sidecar.
pub struct SidecarRdp {
    runtime: Option<Arc<SidecarRuntime>>,
    frame_rx: StdMutex<Option<FrameReceiver>>,
    cursor_rx: StdMutex<Option<CursorReceiver>>,
    cert_prompt_rx: StdMutex<Option<CertPromptReceiver>>,
    tasks: Vec<JoinHandle<()>>,
}

impl SidecarRdp {
    /// Create a new, disconnected RDP sidecar backend.
    pub fn new() -> Self {
        Self {
            runtime: None,
            frame_rx: StdMutex::new(None),
            cursor_rx: StdMutex::new(None),
            cert_prompt_rx: StdMutex::new(None),
            tasks: Vec::new(),
        }
    }

    fn teardown(&mut self) {
        if let Some(rt) = self.runtime.take() {
            rt.cancel.cancel();
        }
        for task in self.tasks.drain(..) {
            task.abort();
        }
        self.frame_rx = StdMutex::new(None);
        self.cursor_rx = StdMutex::new(None);
        self.cert_prompt_rx = StdMutex::new(None);
    }
}

impl Default for SidecarRdp {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for SidecarRdp {
    fn drop(&mut self) {
        self.teardown();
    }
}

/// Drive the sidecar → host direction: read framed [`SidecarMessage`]s and route
/// each to the shared frame / cursor / clipboard surfaces. Runs until cancelled,
/// the pipe closes (sidecar exited), a fatal `Error`, or a downstream channel
/// closes. Cancels the token on exit so the writer/supervisor stop too.
///
/// Generic over the reader so the loopback tests can drive it over an in-memory
/// duplex pipe, standing in for the real `ChildStdout`.
async fn run_reader<R>(
    mut reader: R,
    frame_tx: mpsc::Sender<crate::connection::FrameUpdate>,
    cursor_tx: mpsc::Sender<crate::connection::CursorUpdate>,
    cert_prompt_tx: mpsc::Sender<CertPrompt>,
    shared: Arc<SidecarShared>,
    cancel: CancellationToken,
) where
    R: AsyncRead + Unpin,
{
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            msg = read_message::<_, SidecarMessage>(&mut reader) => {
                match msg {
                    Ok(SidecarMessage::Frame(frame)) => {
                        if frame_tx.send(frame).await.is_err() {
                            break;
                        }
                    }
                    Ok(SidecarMessage::Cursor(cursor)) => {
                        if cursor_tx.send(cursor).await.is_err() {
                            break;
                        }
                    }
                    Ok(SidecarMessage::Clipboard(text)) => {
                        *shared.clipboard.lock().await = text;
                    }
                    Ok(SidecarMessage::RemoteClipboardFiles(files)) => {
                        // The remote copied files; surface the list for a local
                        // paste (#1793). Bytes are fetched later, on demand.
                        debug!(count = files.len(), "remote clipboard file list surfaced");
                        *shared.remote_clipboard_files.lock().await = files;
                    }
                    Ok(SidecarMessage::ClipboardFileChunk {
                        request_id,
                        position,
                        data,
                        last,
                    }) => {
                        // Route the chunk to the waiting fetch; a dropped receiver
                        // (caller gave up) just discards it.
                        if let Ok(fetches) = shared.fetches.lock() {
                            if let Some(tx) = fetches.get(&request_id) {
                                let _ = tx.send(FetchEvent::Chunk {
                                    position,
                                    data,
                                    last,
                                });
                            }
                        }
                    }
                    Ok(SidecarMessage::ClipboardFileError {
                        request_id,
                        message,
                    }) => {
                        if let Ok(fetches) = shared.fetches.lock() {
                            if let Some(tx) = fetches.get(&request_id) {
                                let _ = tx.send(FetchEvent::Error(message));
                            }
                        }
                    }
                    Ok(SidecarMessage::CertPrompt {
                        fingerprint,
                        subject,
                        issuer,
                    }) => {
                        // Forward the untrusted-cert prompt up to the manager,
                        // which owns the trust store + user dialog (#1767). If the
                        // receiver is gone the session is tearing down anyway.
                        if cert_prompt_tx
                            .send(CertPrompt {
                                fingerprint,
                                subject,
                                issuer,
                            })
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Ok(SidecarMessage::State(state)) => {
                        debug!(?state, "rdp sidecar state");
                    }
                    Ok(SidecarMessage::Error(err)) => {
                        warn!(%err, "rdp sidecar reported a fatal error");
                        break;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                        debug!("rdp sidecar closed its output");
                        break;
                    }
                    Err(e) => {
                        warn!(error = %e, "rdp sidecar read error");
                        break;
                    }
                }
            }
        }
    }
    cancel.cancel();
}

/// Drive the host → sidecar direction: forward queued [`HostMessage`]s to the
/// sidecar's stdin. Runs until cancelled, the queue closes, or a write fails.
///
/// Generic over the writer so the loopback tests can drive it over an in-memory
/// duplex pipe, standing in for the real `ChildStdin`.
async fn run_writer<W>(
    mut writer: W,
    mut rx: mpsc::Receiver<HostMessage>,
    cancel: CancellationToken,
) where
    W: AsyncWrite + Unpin,
{
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            maybe = rx.recv() => {
                let Some(msg) = maybe else { break };
                if let Err(e) = write_message(&mut writer, &msg).await {
                    warn!(error = %e, "rdp sidecar write error");
                    break;
                }
            }
        }
    }
}

/// Own the child process: kill it on cancel, or cancel the session when it
/// exits on its own.
async fn supervise(mut child: tokio::process::Child, cancel: CancellationToken) {
    tokio::select! {
        _ = cancel.cancelled() => {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        status = child.wait() => {
            debug!(?status, "rdp sidecar process exited");
            cancel.cancel();
        }
    }
}

impl SidecarRdp {
    /// Map a settings JSON value to a validated [`RdpConfig`].
    fn parse_config(settings: serde_json::Value) -> Result<RdpConfig, SessionError> {
        let cfg: RdpConfig = serde_json::from_value(settings)
            .map_err(|e| SessionError::InvalidConfig(format!("Invalid RDP settings: {e}")))?;
        if cfg.host.is_empty() {
            return Err(SessionError::InvalidConfig(
                "RDP host is required".to_string(),
            ));
        }
        Ok(cfg)
    }
}

#[async_trait::async_trait]
impl ConnectionType for SidecarRdp {
    fn type_id(&self) -> &str {
        "rdp"
    }

    fn display_name(&self) -> &str {
        "RDP"
    }

    fn settings_schema(&self) -> SettingsSchema {
        rdp_settings_schema()
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: false,
            // Graphical + terminal-less: routed through the GraphicalSessionManager
            // into a remote-desktop canvas tab. `graphical: true` also gates it as
            // experimental (#1705) with no per-protocol wiring.
            graphical: true,
            resize: false,
            persistent: false,
            terminal: false,
        }
    }

    async fn connect(&mut self, settings: serde_json::Value) -> Result<(), SessionError> {
        if self.runtime.is_some() {
            return Err(SessionError::AlreadyExists("Already connected".to_string()));
        }
        let cfg = Self::parse_config(settings)?;
        let view_only = cfg.view_only;

        let helper = resolve_helper_binary();
        // Refuse to launch a sidecar whose bytes do not match the SHA-256
        // embedded at build time (#1762) — a tampered/corrupted/wrong-arch
        // helper fails the connection here, before it can run. The check is
        // skipped when the $TERMIHUB_RDP_HELPER override is set (dev/test) or no
        // digest was embedded (dev/branch builds); see [`integrity`].
        let override_active = std::env::var_os(HELPER_PATH_ENV).is_some();
        integrity::verify_helper_integrity(
            &helper,
            override_active,
            integrity::EXPECTED_HELPER_SHA256,
        )
        .map_err(SessionError::SpawnFailed)?;
        let mut command = tokio::process::Command::new(&helper);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        // Suppress the console-window flash on Windows (#1758). No-op elsewhere.
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let mut child = command.spawn().map_err(|e| {
            SessionError::SpawnFailed(format!(
                "failed to launch RDP helper '{}': {e}. Build it with \
                 scripts/build-rdp-sidecar.sh (or set {HELPER_PATH_ENV}).",
                helper.display()
            ))
        })?;

        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| SessionError::SpawnFailed("RDP helper stdin unavailable".to_string()))?;
        let stdout = child.stdout.take().ok_or_else(|| {
            SessionError::SpawnFailed("RDP helper stdout unavailable".to_string())
        })?;

        // The connect payload — credentials included — travels over stdin, never
        // argv/env. It is always the first message.
        write_message(&mut stdin, &HostMessage::Connect(Box::new(cfg)))
            .await
            .map_err(|e| {
                SessionError::SpawnFailed(format!("failed to send RDP connect request: {e}"))
            })?;

        let shared = Arc::new(SidecarShared {
            clipboard: Mutex::new(String::new()),
            remote_clipboard_files: Mutex::new(Vec::new()),
            fetches: StdMutex::new(HashMap::new()),
            view_only,
        });
        let cancel = CancellationToken::new();
        let (frame_tx, frame_rx) = mpsc::channel(CHANNEL_DEPTH);
        let (cursor_tx, cursor_rx) = mpsc::channel(CHANNEL_DEPTH);
        let (cert_prompt_tx, cert_prompt_rx) = mpsc::channel(CHANNEL_DEPTH);
        let (to_sidecar, sidecar_rx) = mpsc::channel(CHANNEL_DEPTH);

        let reader_task = tokio::spawn(run_reader(
            stdout,
            frame_tx,
            cursor_tx,
            cert_prompt_tx,
            shared.clone(),
            cancel.clone(),
        ));
        let writer_task = tokio::spawn(run_writer(stdin, sidecar_rx, cancel.clone()));
        let supervisor_task = tokio::spawn(supervise(child, cancel.clone()));

        self.frame_rx = StdMutex::new(Some(frame_rx));
        self.cursor_rx = StdMutex::new(Some(cursor_rx));
        self.cert_prompt_rx = StdMutex::new(Some(cert_prompt_rx));
        self.tasks = vec![reader_task, writer_task, supervisor_task];
        self.runtime = Some(Arc::new(SidecarRuntime {
            to_sidecar,
            shared,
            next_fetch_id: AtomicU64::new(1),
            cancel,
        }));
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<(), SessionError> {
        if let Some(rt) = &self.runtime {
            // Best-effort graceful shutdown before the supervisor kills the child.
            let _ = rt.to_sidecar.send(HostMessage::Disconnect).await;
        }
        self.teardown();
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.runtime.is_some()
    }

    fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
        // Graphical session: no terminal byte stream.
        Ok(())
    }

    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        // Terminal (cols/rows) resize is meaningless; pixel resize is on the
        // GraphicalBackend trait.
        Ok(())
    }

    fn subscribe_output(&self) -> OutputReceiver {
        let (_tx, rx) = mpsc::channel(1);
        rx
    }

    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }

    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }

    fn graphical(&self) -> Option<&dyn GraphicalBackend> {
        if self.runtime.is_some() {
            Some(self as &dyn GraphicalBackend)
        } else {
            None
        }
    }
}

#[async_trait::async_trait]
impl GraphicalBackend for SidecarRdp {
    fn graphical_capabilities(&self) -> GraphicalCapabilities {
        GraphicalCapabilities {
            // RDP authenticates with username+password, negotiating NLA (CredSSP)
            // when available.
            auth_kinds: vec![AuthKind::UsernamePassword, AuthKind::Nla],
            // Dynamic resize renegotiates the remote resolution over the Display
            // Control channel in the sidecar (#1755).
            supports_dynamic_resize: true,
            // Text clipboard bridges bidirectionally over the CLIPRDR channel in
            // the sidecar (#1756).
            supports_clipboard: true,
            view_only_capable: true,
        }
    }

    fn subscribe_frames(&self) -> FrameReceiver {
        if let Ok(mut guard) = self.frame_rx.lock() {
            if let Some(rx) = guard.take() {
                return rx;
            }
        }
        let (_tx, rx) = mpsc::channel(1);
        rx
    }

    fn subscribe_cursor(&self) -> CursorReceiver {
        if let Ok(mut guard) = self.cursor_rx.lock() {
            if let Some(rx) = guard.take() {
                return rx;
            }
        }
        let (_tx, rx) = mpsc::channel(1);
        rx
    }

    async fn send_input(&self, event: InputEvent) -> Result<(), SessionError> {
        let Some(rt) = &self.runtime else {
            return Err(SessionError::NotRunning("rdp not connected".to_string()));
        };
        if rt.shared.view_only {
            return Ok(());
        }
        rt.to_sidecar
            .send(HostMessage::Input(event))
            .await
            .map_err(|_| SessionError::NotRunning("rdp session ended".to_string()))
    }

    async fn resize(&self, width_px: u16, height_px: u16) -> Result<(), SessionError> {
        let Some(rt) = &self.runtime else {
            return Err(SessionError::NotRunning("rdp not connected".to_string()));
        };
        // The sidecar renegotiates the remote resolution over the Display
        // Control channel and emits a resized framebuffer (#1755).
        let _ = rt
            .to_sidecar
            .send(HostMessage::Resize {
                width: width_px,
                height: height_px,
            })
            .await;
        Ok(())
    }

    async fn get_clipboard(&self) -> Option<String> {
        let rt = self.runtime.as_ref()?;
        let text = rt.shared.clipboard.lock().await.clone();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }

    async fn set_clipboard(&self, text: String) -> Result<(), SessionError> {
        let Some(rt) = &self.runtime else {
            return Err(SessionError::NotRunning("rdp not connected".to_string()));
        };
        if rt.shared.view_only {
            return Ok(());
        }
        // Forwarded to the sidecar, which mirrors the text to the remote over the
        // CLIPRDR channel (#1756).
        let _ = rt.to_sidecar.send(HostMessage::SetClipboard(text)).await;
        Ok(())
    }

    async fn remote_clipboard_files(&self) -> Vec<RemoteClipboardFile> {
        let Some(rt) = &self.runtime else {
            return Vec::new();
        };
        rt.shared.remote_clipboard_files.lock().await.clone()
    }

    async fn fetch_remote_clipboard_file(&self, index: u32) -> Result<PathBuf, SessionError> {
        let rt = self
            .runtime
            .as_ref()
            .ok_or_else(|| SessionError::NotRunning("rdp not connected".to_string()))?;

        // The file must be one the sidecar surfaced (#1793): the remote can only
        // ever serve an advertised index, and its name is already sanitized.
        let meta = {
            let files = rt.shared.remote_clipboard_files.lock().await;
            files
                .iter()
                .find(|f| f.index == index)
                .cloned()
                .ok_or_else(|| {
                    SessionError::InvalidConfig(format!("unknown clipboard file index {index}"))
                })?
        };
        if meta.is_dir {
            return Err(SessionError::InvalidConfig(format!(
                "clipboard entry {index} is a directory"
            )));
        }

        // Register a channel for this fetch before asking, so no chunk can race in
        // ahead of us.
        let request_id = rt.next_fetch_id.fetch_add(1, Ordering::Relaxed);
        let (tx, mut rx) = mpsc::unbounded_channel::<FetchEvent>();
        rt.shared
            .fetches
            .lock()
            .map_err(|_| SessionError::NotRunning("rdp session state poisoned".to_string()))?
            .insert(request_id, tx);

        // Ensure the registration is removed however we leave this function.
        let _guard = FetchGuard {
            shared: rt.shared.clone(),
            request_id,
        };

        rt.to_sidecar
            .send(HostMessage::FetchClipboardFile { request_id, index })
            .await
            .map_err(|_| SessionError::NotRunning("rdp session ended".to_string()))?;

        // Stage the bytes into a sanitized, per-fetch temp file, writing each
        // chunk straight to disk so memory stays bounded regardless of file size.
        // `std::fs` (not `tokio::fs`) matches the sidecar's own file handling and
        // avoids requiring tokio's `fs` feature, which core is built without when
        // it is a dependency of the sidecar; each write is at most one 8 MiB chunk.
        use std::io::Write;
        let staged = staged_path_for(&meta, request_id)?;
        let mut file = std::fs::File::create(&staged)
            .map_err(|e| io_error(format!("failed to stage clipboard file: {e}")))?;
        let cap = meta.size; // advertised size; extra bytes beyond it are refused
        let mut written: u64 = 0;
        loop {
            match rx.recv().await {
                Some(FetchEvent::Chunk {
                    position,
                    data,
                    last,
                }) => {
                    // Chunks must arrive in order and stay within the advertised
                    // size (a lying remote cannot make us write unboundedly).
                    if position != written {
                        return Err(io_error(format!(
                            "clipboard file chunk out of order (expected {written}, got {position})"
                        )));
                    }
                    if let Some(max) = cap {
                        if written.saturating_add(data.len() as u64) > max {
                            return Err(io_error(
                                "clipboard file exceeded its advertised size".to_string(),
                            ));
                        }
                    }
                    file.write_all(&data)
                        .map_err(|e| io_error(format!("failed to stage chunk: {e}")))?;
                    written += data.len() as u64;
                    if last {
                        file.flush()
                            .map_err(|e| io_error(format!("failed to flush stage: {e}")))?;
                        return Ok(staged);
                    }
                }
                Some(FetchEvent::Error(message)) => {
                    return Err(io_error(format!(
                        "remote clipboard file fetch failed: {message}"
                    )));
                }
                // The reader task ended (session torn down) before the final chunk.
                None => {
                    return Err(SessionError::NotRunning(
                        "rdp session ended during clipboard fetch".to_string(),
                    ));
                }
            }
        }
    }

    fn subscribe_cert_prompts(&self) -> Option<CertPromptReceiver> {
        self.cert_prompt_rx.lock().ok().and_then(|mut g| g.take())
    }

    async fn send_cert_decision(&self, accept: bool, remember: bool) -> Result<(), SessionError> {
        let Some(rt) = &self.runtime else {
            return Err(SessionError::NotRunning("rdp not connected".to_string()));
        };
        // Route the verdict down to the sidecar, which is blocking its connect on
        // it (#1767). `remember` is informational here — the host already
        // persisted (or not) before calling.
        rt.to_sidecar
            .send(HostMessage::CertDecision { accept, remember })
            .await
            .map_err(|_| SessionError::NotRunning("rdp session ended".to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::{CursorUpdate, DirtyRect, FrameUpdate, GraphicalState};

    #[test]
    fn metadata_and_capabilities() {
        let r = SidecarRdp::new();
        assert_eq!(r.type_id(), "rdp");
        assert_eq!(r.display_name(), "RDP");
        let caps = r.capabilities();
        assert!(caps.graphical);
        assert!(!caps.terminal);
        assert!(!caps.file_browser);
    }

    #[test]
    fn graphical_none_until_connected() {
        assert!(SidecarRdp::new().graphical().is_none());
    }

    #[test]
    fn schema_is_rdp_schema() {
        let schema = SidecarRdp::new().settings_schema();
        let keys: Vec<&str> = schema.groups.iter().map(|g| g.key.as_str()).collect();
        assert_eq!(keys, vec!["connection", "display", "features", "rdp"]);
    }

    #[test]
    fn graphical_capabilities_advertise_username_password_and_nla() {
        let caps = SidecarRdp::new().graphical_capabilities();
        assert!(caps.auth_kinds.contains(&AuthKind::UsernamePassword));
        assert!(caps.auth_kinds.contains(&AuthKind::Nla));
        assert!(caps.view_only_capable);
        assert!(caps.supports_dynamic_resize);
        assert!(caps.supports_clipboard);
    }

    #[tokio::test]
    async fn connect_requires_host() {
        let mut r = SidecarRdp::new();
        let err = r.connect(serde_json::json!({})).await.unwrap_err();
        assert!(matches!(err, SessionError::InvalidConfig(_)));
        // No child was spawned, so nothing is connected.
        assert!(!r.is_connected());
    }

    #[tokio::test]
    async fn connect_rejects_malformed_settings() {
        let mut r = SidecarRdp::new();
        // `port` must be a number; a string is a hard config error, not a spawn.
        let err = r
            .connect(serde_json::json!({ "host": "h", "port": "not-a-number" }))
            .await
            .unwrap_err();
        assert!(matches!(err, SessionError::InvalidConfig(_)));
    }

    #[tokio::test]
    async fn graphical_methods_error_when_disconnected() {
        let r = SidecarRdp::new();
        assert!(r
            .send_input(InputEvent::Key {
                code: "KeyA".to_string(),
                pressed: true,
            })
            .await
            .is_err());
        assert!(r.get_clipboard().await.is_none());
        assert!(r.set_clipboard("x".to_string()).await.is_err());
        // `resize` exists on both ConnectionType and GraphicalBackend; the
        // graphical (pixel) one is the trait method under test.
        assert!(GraphicalBackend::resize(&r, 800, 600).await.is_err());
    }

    #[test]
    fn helper_env_override_resolves_to_existing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = tmp.path().join("termihub-rdp-helper");
        std::fs::write(&fake, b"#!/bin/sh\n").unwrap();
        // Serialize env mutation: this is the only test touching this var.
        std::env::set_var(HELPER_PATH_ENV, &fake);
        let resolved = resolve_helper_binary();
        std::env::remove_var(HELPER_PATH_ENV);
        assert_eq!(resolved, fake);
    }

    fn test_shared() -> Arc<SidecarShared> {
        Arc::new(SidecarShared {
            clipboard: Mutex::new(String::new()),
            remote_clipboard_files: Mutex::new(Vec::new()),
            fetches: StdMutex::new(HashMap::new()),
            view_only: false,
        })
    }

    /// End-to-end bridge over an in-memory pipe: a `SidecarMessage::Frame`
    /// "written by the sidecar" must surface on the frame receiver the shared
    /// #1680 canvas subscribes to. This is the loopback that proves a decoded
    /// RDP frame reaches the shared layer, without a live RDP server or the real
    /// helper binary.
    #[tokio::test]
    async fn reader_routes_frame_to_shared_receiver() {
        let (mut sidecar_stdout, host_read) = tokio::io::duplex(1024 * 1024);
        let (frame_tx, mut frame_rx) = mpsc::channel(CHANNEL_DEPTH);
        let (cursor_tx, _cursor_rx) = mpsc::channel(CHANNEL_DEPTH);
        let (cert_tx, _cert_rx) = mpsc::channel(CHANNEL_DEPTH);
        let cancel = CancellationToken::new();
        let reader = tokio::spawn(run_reader(
            host_read,
            frame_tx,
            cursor_tx,
            cert_tx,
            test_shared(),
            cancel.clone(),
        ));

        let frame = FrameUpdate {
            width: 2,
            height: 1,
            rects: vec![DirtyRect {
                x: 0,
                y: 0,
                width: 2,
                height: 1,
                data: vec![10, 20, 30, 40, 50, 60, 70, 80],
            }],
        };
        write_message(&mut sidecar_stdout, &SidecarMessage::Frame(frame.clone()))
            .await
            .unwrap();

        let got = frame_rx
            .recv()
            .await
            .expect("a frame must reach the canvas");
        assert_eq!(got, frame);

        cancel.cancel();
        let _ = reader.await;
    }

    #[tokio::test]
    async fn reader_mirrors_clipboard_and_stops_on_eof() {
        let (mut sidecar_stdout, host_read) = tokio::io::duplex(1024 * 1024);
        let (frame_tx, _frame_rx) = mpsc::channel(CHANNEL_DEPTH);
        let (cursor_tx, mut cursor_rx) = mpsc::channel(CHANNEL_DEPTH);
        let (cert_tx, _cert_rx) = mpsc::channel(CHANNEL_DEPTH);
        let shared = test_shared();
        let cancel = CancellationToken::new();
        let reader = tokio::spawn(run_reader(
            host_read,
            frame_tx,
            cursor_tx,
            cert_tx,
            shared.clone(),
            cancel.clone(),
        ));

        write_message(
            &mut sidecar_stdout,
            &SidecarMessage::Cursor(CursorUpdate {
                x: 3,
                y: 4,
                visible: true,
                shape: None,
            }),
        )
        .await
        .unwrap();
        write_message(
            &mut sidecar_stdout,
            &SidecarMessage::Clipboard("copied".to_string()),
        )
        .await
        .unwrap();

        let cursor = cursor_rx.recv().await.unwrap();
        assert_eq!((cursor.x, cursor.y), (3, 4));

        // Closing the sidecar's stdout ends the reader and cancels the session.
        drop(sidecar_stdout);
        let _ = reader.await;
        assert!(cancel.is_cancelled());
        assert_eq!(&*shared.clipboard.lock().await, "copied");
    }

    /// The writer forwards a queued `HostMessage` to what would be the sidecar's
    /// stdin — proving input travels the other direction across the boundary.
    #[tokio::test]
    async fn writer_forwards_input_to_sidecar_stdin() {
        let (host_write, mut sidecar_stdin) = tokio::io::duplex(1024 * 1024);
        let (tx, rx) = mpsc::channel(CHANNEL_DEPTH);
        let cancel = CancellationToken::new();
        let writer = tokio::spawn(run_writer(host_write, rx, cancel.clone()));

        let ev = InputEvent::Pointer {
            x: 7,
            y: 8,
            buttons: 0b001,
        };
        tx.send(HostMessage::Input(ev.clone())).await.unwrap();

        let got = read_message::<_, HostMessage>(&mut sidecar_stdin)
            .await
            .unwrap();
        assert_eq!(got, HostMessage::Input(ev));

        cancel.cancel();
        let _ = writer.await;
    }

    /// A pixel resize must cross the boundary to the sidecar's stdin as a
    /// `HostMessage::Resize` — the seam that carries #1755's Display Control
    /// resize request, proven over a loopback pipe without the real helper.
    #[tokio::test]
    async fn writer_forwards_resize_to_sidecar_stdin() {
        let (host_write, mut sidecar_stdin) = tokio::io::duplex(1024 * 1024);
        let (tx, rx) = mpsc::channel(CHANNEL_DEPTH);
        let cancel = CancellationToken::new();
        let writer = tokio::spawn(run_writer(host_write, rx, cancel.clone()));

        tx.send(HostMessage::Resize {
            width: 1600,
            height: 900,
        })
        .await
        .unwrap();

        let got = read_message::<_, HostMessage>(&mut sidecar_stdin)
            .await
            .unwrap();
        assert_eq!(
            got,
            HostMessage::Resize {
                width: 1600,
                height: 900,
            }
        );

        cancel.cancel();
        let _ = writer.await;
    }

    /// An untrusted-cert prompt written by the sidecar must surface on the
    /// cert-prompt receiver the manager subscribes to (#1767) — the loopback
    /// that proves the prompt reaches the trust-decision layer without a live RDP
    /// server or an untrusted certificate.
    #[tokio::test]
    async fn reader_forwards_cert_prompt() {
        let (mut sidecar_stdout, host_read) = tokio::io::duplex(1024 * 1024);
        let (frame_tx, _frame_rx) = mpsc::channel(CHANNEL_DEPTH);
        let (cursor_tx, _cursor_rx) = mpsc::channel(CHANNEL_DEPTH);
        let (cert_tx, mut cert_rx) = mpsc::channel(CHANNEL_DEPTH);
        let cancel = CancellationToken::new();
        let reader = tokio::spawn(run_reader(
            host_read,
            frame_tx,
            cursor_tx,
            cert_tx,
            test_shared(),
            cancel.clone(),
        ));

        write_message(
            &mut sidecar_stdout,
            &SidecarMessage::CertPrompt {
                fingerprint: "sha256:AB:CD".to_string(),
                subject: Some("CN=host".to_string()),
                issuer: None,
            },
        )
        .await
        .unwrap();

        let prompt = cert_rx
            .recv()
            .await
            .expect("cert prompt must reach the manager");
        assert_eq!(prompt.fingerprint, "sha256:AB:CD");
        assert_eq!(prompt.subject.as_deref(), Some("CN=host"));

        cancel.cancel();
        let _ = reader.await;
    }

    #[tokio::test]
    async fn reader_stops_on_fatal_error_message() {
        let (mut sidecar_stdout, host_read) = tokio::io::duplex(1024 * 1024);
        let (frame_tx, _frame_rx) = mpsc::channel(CHANNEL_DEPTH);
        let (cursor_tx, _cursor_rx) = mpsc::channel(CHANNEL_DEPTH);
        let (cert_tx, _cert_rx) = mpsc::channel(CHANNEL_DEPTH);
        let cancel = CancellationToken::new();
        let reader = tokio::spawn(run_reader(
            host_read,
            frame_tx,
            cursor_tx,
            cert_tx,
            test_shared(),
            cancel.clone(),
        ));
        write_message(
            &mut sidecar_stdout,
            &SidecarMessage::Error("auth failed".to_string()),
        )
        .await
        .unwrap();
        // A fatal Error ends the reader and cancels the session.
        let _ = reader.await;
        assert!(cancel.is_cancelled());
        // Consume state variant to keep the import used across cfgs.
        let _ = SidecarMessage::State(GraphicalState::AuthFailed);
    }

    // --- Remote→host delayed rendering (#1793) ---

    #[tokio::test]
    async fn reader_stores_surfaced_remote_clipboard_files() {
        let (mut sidecar_stdout, host_read) = tokio::io::duplex(1024 * 1024);
        let (frame_tx, _f) = mpsc::channel(CHANNEL_DEPTH);
        let (cursor_tx, _c) = mpsc::channel(CHANNEL_DEPTH);
        let (cert_tx, _ce) = mpsc::channel(CHANNEL_DEPTH);
        let shared = test_shared();
        let cancel = CancellationToken::new();
        let reader = tokio::spawn(run_reader(
            host_read,
            frame_tx,
            cursor_tx,
            cert_tx,
            shared.clone(),
            cancel.clone(),
        ));

        let files = vec![RemoteClipboardFile {
            name: "report.pdf".to_string(),
            relative_path: None,
            size: Some(10),
            is_dir: false,
            index: 0,
        }];
        write_message(
            &mut sidecar_stdout,
            &SidecarMessage::RemoteClipboardFiles(files.clone()),
        )
        .await
        .unwrap();

        drop(sidecar_stdout);
        let _ = reader.await;
        assert_eq!(*shared.remote_clipboard_files.lock().await, files);
    }

    /// The full host round-trip: `fetch_remote_clipboard_file` sends a
    /// `FetchClipboardFile`, a fake sidecar streams the bytes back, and the reader
    /// routes them into a sanitized, bounded staging file whose contents match.
    #[tokio::test]
    async fn fetch_remote_clipboard_file_stages_streamed_bytes() {
        let (host_write, mut sidecar_stdin) = tokio::io::duplex(1024 * 1024);
        let (mut sidecar_stdout, host_read) = tokio::io::duplex(1024 * 1024);
        let (frame_tx, _f) = mpsc::channel(CHANNEL_DEPTH);
        let (cursor_tx, _c) = mpsc::channel(CHANNEL_DEPTH);
        let (cert_tx, _ce) = mpsc::channel(CHANNEL_DEPTH);
        let (to_sidecar, sidecar_rx) = mpsc::channel(CHANNEL_DEPTH);

        let shared = Arc::new(SidecarShared {
            clipboard: Mutex::new(String::new()),
            remote_clipboard_files: Mutex::new(vec![RemoteClipboardFile {
                name: "hello.txt".to_string(),
                relative_path: None,
                size: Some(5),
                is_dir: false,
                index: 0,
            }]),
            fetches: StdMutex::new(HashMap::new()),
            view_only: false,
        });
        let cancel = CancellationToken::new();
        let reader = tokio::spawn(run_reader(
            host_read,
            frame_tx,
            cursor_tx,
            cert_tx,
            shared.clone(),
            cancel.clone(),
        ));
        let writer = tokio::spawn(run_writer(host_write, sidecar_rx, cancel.clone()));

        // A fake sidecar: on the fetch request, stream the file back in two chunks.
        let fake = tokio::spawn(async move {
            let msg = read_message::<_, HostMessage>(&mut sidecar_stdin)
                .await
                .expect("fetch request");
            let HostMessage::FetchClipboardFile { request_id, index } = msg else {
                panic!("expected FetchClipboardFile, got {msg:?}");
            };
            assert_eq!(index, 0);
            for (position, data, last) in [
                (0u64, b"hel".to_vec(), false),
                (3u64, b"lo".to_vec(), true),
            ] {
                write_message(
                    &mut sidecar_stdout,
                    &SidecarMessage::ClipboardFileChunk {
                        request_id,
                        position,
                        data,
                        last,
                    },
                )
                .await
                .unwrap();
            }
            // Keep stdout open until the test tears down.
            sidecar_stdout
        });

        let rdp = SidecarRdp {
            runtime: Some(Arc::new(SidecarRuntime {
                to_sidecar,
                shared: shared.clone(),
                next_fetch_id: AtomicU64::new(1),
                cancel: cancel.clone(),
            })),
            frame_rx: StdMutex::new(None),
            cursor_rx: StdMutex::new(None),
            cert_prompt_rx: StdMutex::new(None),
            tasks: Vec::new(),
        };

        let staged = rdp
            .fetch_remote_clipboard_file(0)
            .await
            .expect("fetch should stage the file");
        assert_eq!(std::fs::read(&staged).unwrap(), b"hello");
        // The staged file keeps the sanitized basename.
        assert_eq!(staged.file_name().unwrap().to_str().unwrap(), "hello.txt");
        // The fetch registration was cleaned up.
        assert!(shared.fetches.lock().unwrap().is_empty());

        // Clean up the per-fetch staging directory.
        if let Some(parent) = staged.parent() {
            let _ = std::fs::remove_dir_all(parent);
        }
        cancel.cancel();
        let _ = reader.await;
        let _ = writer.await;
        let _ = fake.await;
    }

    #[tokio::test]
    async fn fetch_rejects_an_unknown_index_without_touching_the_sidecar() {
        // No runtime files surfaced → an unknown index fails fast as InvalidConfig,
        // and (with no runtime) a disconnected backend reports NotRunning.
        let disconnected = SidecarRdp::new();
        assert!(disconnected.remote_clipboard_files().await.is_empty());
        assert!(matches!(
            disconnected.fetch_remote_clipboard_file(0).await,
            Err(SessionError::NotRunning(_))
        ));
    }

    #[test]
    fn sanitize_leaf_rejects_separators_and_traversal() {
        assert_eq!(sanitize_leaf("ok.txt"), Some("ok.txt"));
        assert!(sanitize_leaf("").is_none());
        assert!(sanitize_leaf("..").is_none());
        assert!(sanitize_leaf(".").is_none());
        assert!(sanitize_leaf("a/b").is_none());
        assert!(sanitize_leaf("a\\b").is_none());
        assert!(sanitize_leaf("C:evil").is_none());
        assert!(sanitize_leaf("nul\0byte").is_none());
    }
}
