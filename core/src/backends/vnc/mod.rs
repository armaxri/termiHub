//! VNC (RFB) graphical remote-desktop backend.
//!
//! Implements the protocol-agnostic [`GraphicalBackend`] trait (#1680) over the
//! RFB wire protocol using the `vnc-rs` client. Decode happens here, in Rust:
//! the backend negotiates the connection, decodes framebuffer updates into the
//! shared [`FrameUpdate`] / [`CursorUpdate`] stream, translates the shared
//! [`InputEvent`]s into RFB `KeyEvent` / `PointerEvent`, and bridges the
//! clipboard via RFB `ServerCutText` / `ClientCutText`. Everything the user
//! touches — canvas, toolbar, overlays, input, clipboard, scaling — belongs to
//! the shared layer and is untouched here; this module is the wire adapter only.
//!
//! It drops in beside the mock (#1680) and the coming RDP backend (#1682) under
//! the same trait: a new `backends/vnc/` module, a schema, and one additive
//! registry `register(...)` call — no shared match arm, no editor switch.

mod budget;
mod config;
mod frame;
mod jpeg;
mod keymap;
mod tunnel;

pub use config::vnc_settings_schema;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::mpsc;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};
use vnc::{
    ClientKeyEvent, ClientMouseEvent, PixelFormat, TlsVerify, VencryptConfig, VncConnector,
    VncEncoding, VncError, VncEvent, VncVersion, X11Event,
};

use crate::connection::{
    AuthKind, Capabilities, ConnectionType, CursorReceiver, CursorShape, CursorUpdate, DirtyRect,
    FrameReceiver, FrameUpdate, GraphicalBackend, GraphicalCapabilities, InputEvent,
    OutputReceiver, SettingsSchema,
};
use crate::errors::SessionError;
use crate::files::FileBrowser;
use crate::monitoring::MonitoringProvider;

use budget::{ByteBudgetSender, MAX_QUEUED_CURSOR_BYTES, MAX_QUEUED_FRAME_BYTES};
use config::VncConfig;
use frame::FrameShadow;

/// Bounded channel depth for frames / cursor updates (backpressure).
const CHANNEL_DEPTH: usize = 16;

/// How often the driver polls decoded events and drives incremental refreshes.
const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(30);

/// Shared, interior-mutable state touched by both the driver task and the
/// `GraphicalBackend` command methods.
struct VncShared {
    /// Latest remote clipboard text (RFB `ServerCutText`), surfaced via `get_clipboard`.
    clipboard: Mutex<String>,
    /// Last pointer X/Y (framebuffer pixels), so a server cursor-shape update can
    /// be positioned even though RFB carries no server cursor *position*.
    ptr_x: AtomicU32,
    ptr_y: AtomicU32,
    /// Suppress input when the session is view-only.
    view_only: bool,
    /// Whether server cursor shapes are rendered.
    show_remote_cursor: bool,
    /// The typed reason the session ended because the server sent data this
    /// client cannot handle (#3479), surfaced through
    /// [`GraphicalBackend::fatal_error`]. Recorded by the driver **before** it
    /// drops the frame sender, so it is set by the time the supervisor sees the
    /// stream close. `None` for a transport drop or a user disconnect.
    failure: StdMutex<Option<String>>,
}

impl VncShared {
    /// Record the first fatal reason; later ones are consequences of it.
    fn record_failure(&self, message: String) {
        if let Ok(mut slot) = self.failure.lock() {
            slot.get_or_insert(message);
        }
    }

    /// The recorded reason as the shared typed error.
    fn fatal_error(&self) -> Option<SessionError> {
        let guard = self.failure.lock().ok()?;
        guard.clone().map(SessionError::ProtocolError)
    }
}

/// Live runtime of a connected VNC session.
struct VncRuntime {
    /// A clone of the RFB client for sending input / clipboard (methods take `&self`).
    client: vnc::VncClient,
    shared: Arc<VncShared>,
    cancel: CancellationToken,
    /// SSH tunnel kept alive for the session lifetime, if the transport uses one.
    _tunnel: Option<tunnel::SshTunnel>,
}

/// VNC/RFB graphical remote-desktop connection.
pub struct Vnc {
    runtime: Option<Arc<VncRuntime>>,
    frame_rx: StdMutex<Option<FrameReceiver>>,
    cursor_rx: StdMutex<Option<CursorReceiver>>,
    task: Option<JoinHandle<()>>,
}

impl Vnc {
    /// Create a new, disconnected VNC backend.
    pub fn new() -> Self {
        Self {
            runtime: None,
            frame_rx: StdMutex::new(None),
            cursor_rx: StdMutex::new(None),
            task: None,
        }
    }
}

impl Default for Vnc {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for Vnc {
    fn drop(&mut self) {
        if let Some(rt) = &self.runtime {
            rt.cancel.cancel();
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// Translate a DOM `MouseEvent.buttons` bitmask (bit0 left, bit1 right, bit2
/// middle) into an RFB pointer button mask (RFC 6143 §7.5.5: bit0 button1/left,
/// bit1 button2/middle, bit2 button3/right).
fn dom_buttons_to_rfb(buttons: u8) -> u8 {
    let mut rfb = 0u8;
    if buttons & 0b001 != 0 {
        rfb |= 1 << 0; // left → button 1
    }
    if buttons & 0b010 != 0 {
        rfb |= 1 << 2; // DOM right → button 3
    }
    if buttons & 0b100 != 0 {
        rfb |= 1 << 1; // DOM middle → button 2
    }
    rfb
}

/// Encode the chosen client encodings for `cfg`, honoring the raw/ZRLE
/// preference and whether the remote cursor is wanted. `Raw` is always included
/// (RFC requirement); `DesktopSizePseudo` lets the server announce resolution
/// changes.
///
/// `Tight` is advertised ahead of ZRLE when compression is wanted — it is the
/// most bandwidth-efficient common encoding, and its photographic sub-rects
/// arrive as JPEG, decoded via [`jpeg::decode_jpeg_rgba`] into the shared frame
/// stream (#1715). It is omitted under a raw preference so "Raw" stays truly
/// uncompressed.
fn encodings_for(cfg: &VncConfig) -> Vec<VncEncoding> {
    let mut encs = Vec::new();
    if !cfg.prefers_raw() {
        encs.push(VncEncoding::Tight);
        encs.push(VncEncoding::Zrle);
    }
    encs.push(VncEncoding::CopyRect);
    encs.push(VncEncoding::Raw);
    if cfg.show_remote_cursor {
        encs.push(VncEncoding::CursorPseudo);
    }
    encs.push(VncEncoding::DesktopSizePseudo);
    encs
}

impl Vnc {
    /// Send a protocol-agnostic input event to the remote, translated to RFB.
    async fn forward_input(rt: &VncRuntime, event: InputEvent) -> Result<(), SessionError> {
        if rt.shared.view_only {
            return Ok(());
        }
        match event {
            InputEvent::Key { code, pressed } => {
                if let Some(keysym) = keymap::code_to_keysym(&code) {
                    rt.client
                        .input(X11Event::KeyEvent(ClientKeyEvent {
                            keycode: keysym,
                            down: pressed,
                        }))
                        .await
                        .map_err(map_vnc_err)?;
                }
            }
            InputEvent::Pointer { x, y, buttons } => {
                rt.shared.ptr_x.store(x, Ordering::Relaxed);
                rt.shared.ptr_y.store(y, Ordering::Relaxed);
                rt.client
                    .input(X11Event::PointerEvent(ClientMouseEvent {
                        position_x: x as u16,
                        position_y: y as u16,
                        bottons: dom_buttons_to_rfb(buttons),
                    }))
                    .await
                    .map_err(map_vnc_err)?;
            }
            InputEvent::Wheel {
                x,
                y,
                delta_x: _,
                delta_y,
            } => {
                rt.shared.ptr_x.store(x, Ordering::Relaxed);
                rt.shared.ptr_y.store(y, Ordering::Relaxed);
                // RFB models the wheel as button 4 (up) / button 5 (down):
                // a press followed immediately by a release.
                if delta_y != 0.0 {
                    let bit = if delta_y < 0.0 { 1 << 3 } else { 1 << 4 };
                    let (px, py) = (x as u16, y as u16);
                    rt.client
                        .input(X11Event::PointerEvent(ClientMouseEvent {
                            position_x: px,
                            position_y: py,
                            bottons: bit,
                        }))
                        .await
                        .map_err(map_vnc_err)?;
                    rt.client
                        .input(X11Event::PointerEvent(ClientMouseEvent {
                            position_x: px,
                            position_y: py,
                            bottons: 0,
                        }))
                        .await
                        .map_err(map_vnc_err)?;
                }
            }
        }
        Ok(())
    }
}

/// Build the [`VencryptConfig`] the connector uses when the server offers
/// VeNCrypt (security type 19), resolving the TLS verification mode from `cfg`.
///
/// For the `"ca"` mode the PEM bundle is read from disk here so a bad path fails
/// with an actionable [`SessionError`] before the connection is attempted.
async fn build_vencrypt_config(cfg: &VncConfig) -> Result<VencryptConfig, SessionError> {
    let verify = match cfg.tls_verify_mode() {
        "insecure" => TlsVerify::Insecure,
        "ca" => {
            let path = cfg
                .tls_ca_path
                .as_deref()
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .ok_or_else(|| {
                    SessionError::InvalidConfig(
                        "VNC TLS verification is set to a custom CA but no CA bundle path was \
                         provided"
                            .to_string(),
                    )
                })?;
            let pem = tokio::fs::read(path).await.map_err(|e| {
                SessionError::InvalidConfig(format!(
                    "failed to read VNC TLS CA bundle '{path}': {e}"
                ))
            })?;
            TlsVerify::CaPem(pem)
        }
        _ => TlsVerify::Roots,
    };
    Ok(VencryptConfig {
        username: cfg.username.clone(),
        server_name: cfg.host.clone(),
        verify,
    })
}

/// Map a `vnc-rs` error to a [`SessionError`], distinguishing auth rejection so
/// the message is actionable.
fn map_vnc_err(e: VncError) -> SessionError {
    match e {
        // Typed, so the graphical manager never auto-reconnects into a
        // credential rejection (#3364).
        VncError::WrongPassword => SessionError::AuthFailed,
        VncError::NoPassword => SessionError::InvalidConfig(
            "VNC server requires a password but none was provided".to_string(),
        ),
        other => SessionError::SpawnFailed(format!("VNC error: {other}")),
    }
}

/// Lead-in of every user-facing VNC protocol-error message (#3479).
const PROTOCOL_ERROR_PREFIX: &str = "The VNC server sent data termiHub can't handle";

/// Classify an error that ended a running VNC session (#3479).
///
/// Returns the user-facing reason for a **server protocol failure** — data the
/// server sent that this client cannot handle — or `None` for a transport-level
/// end (connection reset, EOF, TLS/transport errors, a closed client), which
/// stays an ordinary, retryable drop. A protocol failure is terminal: the
/// supervisor does not auto-reconnect into it, because a re-dial would most
/// likely meet the same server behaviour again.
fn protocol_failure_reason(e: &VncError) -> Option<String> {
    let detail = match e {
        VncError::Protocol(msg) => msg.clone(),
        VncError::UnsupportedEncoding(encoding) => format!("unsupported encoding {encoding}"),
        VncError::WrongPixelFormat => "unsupported pixel format".to_string(),
        VncError::InvalidImageData => "image data that cannot be decoded".to_string(),
        VncError::WrongServerMessage => "an unknown server message".to_string(),
        VncError::InvalidSecurityTyep(kind) => format!("unknown security type {kind}"),
        VncError::Internal(msg) => return Some(internal_failure_reason(msg)),
        _ => return None,
    };
    Some(format!("{PROTOCOL_ERROR_PREFIX}: {detail}"))
}

/// The user-facing reason for a caught panic in the VNC client or driver
/// (#3473 / #3479). Treated like a protocol failure: terminal, no auto-retry.
fn internal_failure_reason(detail: &str) -> String {
    format!("The VNC session ended because of an internal client error: {detail}")
}

/// The driver task: polls decoded RFB events, maintains the shadow framebuffer,
/// emits shared frame/cursor updates, mirrors the clipboard, and drives
/// incremental framebuffer-update requests. Ends when cancelled or on RFB error.
async fn drive(
    client: vnc::VncClient,
    shared: Arc<VncShared>,
    cancel: CancellationToken,
    frame_tx: mpsc::Sender<FrameUpdate>,
    cursor_tx: mpsc::Sender<CursorUpdate>,
) {
    let mut shadow = FrameShadow::new();
    // #3511: bound the channels to the frame pump by bytes, not only by count.
    let mut frame_tx = ByteBudgetSender::new(frame_tx, MAX_QUEUED_FRAME_BYTES);
    let mut cursor_tx = ByteBudgetSender::new(cursor_tx, MAX_QUEUED_CURSOR_BYTES);
    // Prime the first full frame.
    if client.input(X11Event::FullRefresh).await.is_err() {
        return;
    }
    let mut request_outstanding = true;

    let mut ticker = tokio::time::interval(POLL_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = ticker.tick() => {
                let mut got_event = false;
                loop {
                    match client.poll_event().await {
                        Ok(Some(event)) => {
                            got_event = true;
                            if !handle_event(event, &mut shadow, &shared, &mut frame_tx, &mut cursor_tx).await {
                                return; // channel closed downstream — session gone
                            }
                        }
                        Ok(None) => break,
                        Err(e) => {
                            debug!(error = %e, "vnc session ended");
                            if let Some(reason) = protocol_failure_reason(&e) {
                                shared.record_failure(reason);
                            }
                            return;
                        }
                    }
                }
                // Keep exactly one incremental request outstanding: refill it
                // once the previous one has been answered, so an idle desktop
                // doesn't pile up requests and input stays responsive.
                if got_event {
                    request_outstanding = false;
                }
                if !request_outstanding {
                    if client.input(X11Event::Refresh).await.is_err() {
                        return;
                    }
                    request_outstanding = true;
                }
            }
        }
    }
}

/// Poll a future inside [`std::panic::catch_unwind`], turning a panic into an
/// `Err` carrying the panic message (#3473).
struct CatchUnwind<F>(std::pin::Pin<Box<F>>);

impl<F: std::future::Future> std::future::Future for CatchUnwind<F> {
    type Output = Result<F::Output, String>;

    fn poll(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Self::Output> {
        let inner = self.0.as_mut();
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| inner.poll(cx))) {
            Ok(std::task::Poll::Pending) => std::task::Poll::Pending,
            Ok(std::task::Poll::Ready(out)) => std::task::Poll::Ready(Ok(out)),
            Err(panic) => {
                let msg = panic
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_string())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "unknown panic".to_string());
                std::task::Poll::Ready(Err(msg))
            }
        }
    }
}

/// Task boundary for the VNC driver (#3473, belt-and-braces): the vendored
/// client no longer panics on server input, but if anything in the driver ever
/// does, contain it here and end the session cleanly. Unwinding drops the
/// frame/cursor senders, so the graphical manager sees the stream close; the
/// panic is recorded on `shared` as the session's typed fatal reason (#3479),
/// so the session rests in `Disconnected` with that message and no auto-retry.
async fn drive_guarded<F: std::future::Future<Output = ()>>(shared: Arc<VncShared>, driver: F) {
    if let Err(msg) = CatchUnwind(Box::pin(driver)).await {
        warn!(panic = %msg, "vnc driver panicked — session ended");
        shared.record_failure(internal_failure_reason(&msg));
    }
}

/// Decode a Tight JPEG sub-rect at `(x, y)`, blit it into the shadow, and return
/// the [`DirtyRect`] to emit downstream — or `None` when the JPEG is malformed or
/// lands out of bounds, in which case it is logged and dropped so a bad update
/// never corrupts the shadow (mirroring how Raw handles a size mismatch).
///
/// The decoded pixel dimensions are authoritative for the blit; a full frame
/// arriving before any resolution event grows the shadow to fit, exactly as the
/// Raw path does.
fn jpeg_dirty_rect(shadow: &mut FrameShadow, x: u32, y: u32, jpeg: &[u8]) -> Option<DirtyRect> {
    let decoded = match jpeg::decode_jpeg_rgba(jpeg) {
        Ok(d) => d,
        Err(e) => {
            warn!(error = %e, "vnc tight jpeg decode failed — dropped");
            return None;
        }
    };
    let (w, h) = (decoded.width, decoded.height);
    if shadow.width() == 0 || shadow.height() == 0 {
        shadow.resize(x + w, y + h);
    }
    if !shadow.blit(x, y, w, h, &decoded.rgba) {
        warn!(x, y, w, h, "vnc tight jpeg rect out of bounds — dropped");
        return None;
    }
    Some(DirtyRect {
        x,
        y,
        width: w,
        height: h,
        data: decoded.rgba,
    })
}

/// Handle one decoded RFB event. Returns `false` if a downstream channel closed
/// (the session should end).
async fn handle_event(
    event: VncEvent,
    shadow: &mut FrameShadow,
    shared: &VncShared,
    frame_tx: &mut ByteBudgetSender<FrameUpdate>,
    cursor_tx: &mut ByteBudgetSender<CursorUpdate>,
) -> bool {
    match event {
        VncEvent::SetResolution(screen) => {
            shadow.resize(screen.width as u32, screen.height as u32);
            // Resize the canvas; the server repaints on the next request.
            frame_tx
                .send(FrameUpdate {
                    width: shadow.width(),
                    height: shadow.height(),
                    rects: Vec::new(),
                })
                .await
        }
        VncEvent::RawImage(rect, data) => {
            let (x, y, w, h) = (
                rect.x as u32,
                rect.y as u32,
                rect.width as u32,
                rect.height as u32,
            );
            // Cope with a full frame arriving before any resolution event.
            if shadow.width() == 0 || shadow.height() == 0 {
                shadow.resize(x + w, y + h);
            }
            if data.len() != (w as usize) * (h as usize) * 4 {
                warn!(
                    w,
                    h,
                    len = data.len(),
                    "vnc raw image size mismatch — dropped"
                );
                return true;
            }
            shadow.blit(x, y, w, h, &data);
            frame_tx
                .send(FrameUpdate {
                    width: shadow.width(),
                    height: shadow.height(),
                    rects: vec![DirtyRect {
                        x,
                        y,
                        width: w,
                        height: h,
                        data,
                    }],
                })
                .await
        }
        VncEvent::Copy(dst, src) => {
            let (w, h) = (dst.width as u32, dst.height as u32);
            if !shadow.copy_rect(dst.x as u32, dst.y as u32, src.x as u32, src.y as u32, w, h) {
                return true;
            }
            let Some(data) = shadow.extract(dst.x as u32, dst.y as u32, w, h) else {
                return true;
            };
            frame_tx
                .send(FrameUpdate {
                    width: shadow.width(),
                    height: shadow.height(),
                    rects: vec![DirtyRect {
                        x: dst.x as u32,
                        y: dst.y as u32,
                        width: w,
                        height: h,
                        data,
                    }],
                })
                .await
        }
        VncEvent::SetCursor(rect, data) => {
            if !shared.show_remote_cursor {
                return true;
            }
            let (w, h) = (rect.width as u32, rect.height as u32);
            let shape = if w == 0 || h == 0 || data.len() != (w as usize) * (h as usize) * 4 {
                None // empty / malformed cursor → hide
            } else {
                Some(CursorShape {
                    width: w,
                    height: h,
                    hotspot_x: rect.x as u32,
                    hotspot_y: rect.y as u32,
                    data,
                })
            };
            cursor_tx
                .send(CursorUpdate {
                    x: shared.ptr_x.load(Ordering::Relaxed),
                    y: shared.ptr_y.load(Ordering::Relaxed),
                    visible: shape.is_some(),
                    shape,
                })
                .await
        }
        VncEvent::JpegImage(rect, data) => {
            // Tight's photographic sub-rect: a self-describing JPEG independent of
            // the negotiated RFB pixel format. Decode to RGBA, fold into the
            // shadow, and emit a dirty-rect like any other encoding.
            let Some(dirty) = jpeg_dirty_rect(shadow, rect.x as u32, rect.y as u32, &data) else {
                return true; // malformed / out of bounds — already logged, dropped
            };
            frame_tx
                .send(FrameUpdate {
                    width: shadow.width(),
                    height: shadow.height(),
                    rects: vec![dirty],
                })
                .await
        }
        VncEvent::Text(text) => {
            *shared.clipboard.lock().await = text;
            true
        }
        VncEvent::Error(err) => {
            match protocol_failure_reason(&err) {
                Some(reason) => {
                    warn!(error = %err, "vnc protocol error — session ended");
                    shared.record_failure(reason);
                }
                None => debug!(error = %err, "vnc transport error — session ended"),
            }
            false
        }
        // Bell, SetPixelFormat — no shared surface to route to; safely ignored.
        _ => true,
    }
}

#[async_trait::async_trait]
impl ConnectionType for Vnc {
    fn type_id(&self) -> &str {
        "vnc"
    }

    fn display_name(&self) -> &str {
        "VNC"
    }

    fn settings_schema(&self) -> SettingsSchema {
        vnc_settings_schema()
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
            tunneling: false,
        }
    }

    async fn connect(&mut self, settings: serde_json::Value) -> Result<(), SessionError> {
        if self.runtime.is_some() {
            return Err(SessionError::AlreadyExists("Already connected".to_string()));
        }
        let cfg: VncConfig = serde_json::from_value(settings)
            .map_err(|e| SessionError::InvalidConfig(format!("Invalid VNC settings: {e}")))?;
        if cfg.host.is_empty() {
            return Err(SessionError::InvalidConfig(
                "VNC host is required".to_string(),
            ));
        }

        // Establish transport (direct TCP or SSH tunnel).
        let (stream, tunnel) = tunnel::connect_transport(&cfg).await?;

        // Resolve VeNCrypt TLS verification (auto-negotiated when the server
        // offers security type 19; falls back to VncAuth/None otherwise).
        let vencrypt = build_vencrypt_config(&cfg).await?;

        // Negotiate RFB, decoding into RGBA so the shared canvas blits directly.
        let password = cfg.password.clone();
        let client = VncConnector::new(stream)
            .set_version(VncVersion::RFB38)
            .set_auth_method(async move { Ok::<_, VncError>(password) })
            .set_pixel_format(PixelFormat::rgba())
            .allow_shared(true)
            .set_vencrypt(vencrypt);
        let client = encodings_for(&cfg)
            .into_iter()
            .fold(client, |c, enc| c.add_encoding(enc));
        let client = client
            .build()
            .map_err(map_vnc_err)?
            .try_start()
            .await
            .map_err(map_vnc_err)?
            .finish()
            .map_err(map_vnc_err)?;

        let shared = Arc::new(VncShared {
            clipboard: Mutex::new(String::new()),
            ptr_x: AtomicU32::new(0),
            ptr_y: AtomicU32::new(0),
            view_only: cfg.view_only,
            show_remote_cursor: cfg.show_remote_cursor,
            failure: StdMutex::new(None),
        });
        let cancel = CancellationToken::new();
        let (frame_tx, frame_rx) = mpsc::channel(CHANNEL_DEPTH);
        let (cursor_tx, cursor_rx) = mpsc::channel(CHANNEL_DEPTH);

        let task = tokio::spawn(drive_guarded(
            shared.clone(),
            drive(
                client.clone(),
                shared.clone(),
                cancel.clone(),
                frame_tx,
                cursor_tx,
            ),
        ));

        self.frame_rx = StdMutex::new(Some(frame_rx));
        self.cursor_rx = StdMutex::new(Some(cursor_rx));
        self.runtime = Some(Arc::new(VncRuntime {
            client,
            shared,
            cancel,
            _tunnel: tunnel,
        }));
        self.task = Some(task);
        Ok(())
    }

    /// Connect, aborting transport setup (direct TCP or SSH tunnel), VeNCrypt
    /// TLS negotiation and RFB handshake promptly when `cancel` fires instead
    /// of waiting them out (PARITY-007). Nothing is stored on `self` until
    /// [`connect`](Self::connect) fully succeeds, and the transport/tunnel are
    /// held in locals whose `Drop` tears them down, so dropping the in-flight
    /// connect on cancel leaks nothing.
    async fn connect_cancellable(
        &mut self,
        settings: serde_json::Value,
        cancel: Option<CancellationToken>,
    ) -> Result<(), SessionError> {
        super::race_connect(cancel, self.connect(settings)).await
    }

    async fn disconnect(&mut self) -> Result<(), SessionError> {
        if let Some(rt) = self.runtime.take() {
            rt.cancel.cancel();
            let _ = rt.client.close().await;
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
        self.frame_rx = StdMutex::new(None);
        self.cursor_rx = StdMutex::new(None);
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
impl GraphicalBackend for Vnc {
    fn graphical_capabilities(&self) -> GraphicalCapabilities {
        GraphicalCapabilities {
            // VeNCrypt adds username+password (Plain sub-auth); the connector
            // negotiates it automatically when the server offers security type 19.
            auth_kinds: vec![
                AuthKind::None,
                AuthKind::Password,
                AuthKind::UsernamePassword,
            ],
            // vnc-rs offers no client-initiated SetDesktopSize; the frontend
            // scales the canvas instead.
            supports_dynamic_resize: false,
            supports_clipboard: true,
            // The standard RFB clipboard (ServerCutText / ClientCutText) is
            // Latin-1 text only; vnc-rs has no Extended Clipboard support.
            supports_clipboard_image: false,
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
            return Err(SessionError::NotRunning("vnc not connected".to_string()));
        };
        Self::forward_input(rt, event).await
    }

    async fn resize(&self, _width_px: u16, _height_px: u16) -> Result<(), SessionError> {
        // No client-initiated remote resize; the shared frontend scales.
        if self.runtime.is_none() {
            return Err(SessionError::NotRunning("vnc not connected".to_string()));
        }
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
            return Err(SessionError::NotRunning("vnc not connected".to_string()));
        };
        if rt.shared.view_only {
            return Ok(());
        }
        rt.client
            .input(X11Event::CopyText(text))
            .await
            .map_err(map_vnc_err)
    }
    /// The server-protocol failure (or caught driver panic) that ended the
    /// session (#3479); `None` for a transport drop or before one happened.
    fn fatal_error(&self) -> Option<SessionError> {
        self.runtime.as_ref()?.shared.fatal_error()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_and_capabilities() {
        let v = Vnc::new();
        assert_eq!(v.type_id(), "vnc");
        assert_eq!(v.display_name(), "VNC");
        let caps = v.capabilities();
        assert!(caps.graphical);
        assert!(!caps.terminal);
        assert!(!caps.file_browser);
    }

    #[test]
    fn graphical_none_until_connected() {
        assert!(Vnc::new().graphical().is_none());
    }

    #[test]
    fn schema_is_vnc_schema() {
        let schema = Vnc::new().settings_schema();
        let keys: Vec<&str> = schema.groups.iter().map(|g| g.key.as_str()).collect();
        assert_eq!(
            keys,
            vec!["connection", "display", "features", "vnc", "sshTunnel"]
        );
    }

    #[test]
    fn button_mask_remaps_dom_to_rfb() {
        assert_eq!(dom_buttons_to_rfb(0b001), 0b001); // left → button 1
        assert_eq!(dom_buttons_to_rfb(0b010), 0b100); // DOM right → button 3
        assert_eq!(dom_buttons_to_rfb(0b100), 0b010); // DOM middle → button 2
        assert_eq!(dom_buttons_to_rfb(0b111), 0b111); // all three
        assert_eq!(dom_buttons_to_rfb(0), 0);
    }

    #[test]
    fn encodings_include_raw_always() {
        let raw_cfg = VncConfig {
            preferred_encoding: "raw".to_string(),
            ..Default::default()
        };
        let encs = encodings_for(&raw_cfg);
        assert!(encs.contains(&VncEncoding::Raw));
        // Raw preference omits the compressed encodings.
        assert!(!encs.contains(&VncEncoding::Zrle));
        assert!(!encs.contains(&VncEncoding::Tight));

        let zrle_cfg = VncConfig::default();
        let encs = encodings_for(&zrle_cfg);
        assert!(encs.contains(&VncEncoding::Zrle));
        assert!(encs.contains(&VncEncoding::Raw));
        assert!(encs.contains(&VncEncoding::CursorPseudo));
    }

    #[test]
    fn encodings_offer_tight_when_compressed() {
        // Tight is advertised under the default (compressed) preference, ahead of
        // ZRLE, so a Tight-capable server can use the most efficient encoding.
        let encs = encodings_for(&VncConfig::default());
        assert!(encs.contains(&VncEncoding::Tight));
        let tight = encs.iter().position(|e| *e == VncEncoding::Tight);
        let zrle = encs.iter().position(|e| *e == VncEncoding::Zrle);
        assert!(tight < zrle, "Tight should be preferred over ZRLE");
    }

    /// A solid 16×16 red Tight JPEG sub-rect fixture (shared with `jpeg` tests).
    const RED_JPEG_16X16: &[u8] = include_bytes!("testdata/red_16x16.jpg");

    fn test_shared() -> Arc<VncShared> {
        Arc::new(VncShared {
            clipboard: Mutex::new(String::new()),
            ptr_x: AtomicU32::new(0),
            ptr_y: AtomicU32::new(0),
            view_only: false,
            show_remote_cursor: true,
            failure: StdMutex::new(None),
        })
    }

    #[tokio::test]
    async fn drive_guard_contains_a_panicking_driver() {
        let (tx, mut rx) = mpsc::channel::<u8>(1);
        let shared = test_shared();
        let task = tokio::spawn(drive_guarded(shared.clone(), async move {
            let _tx = tx;
            panic!("hostile server");
        }));
        // The task completes normally (no JoinError) and the channel closes.
        task.await.expect("panic must not escape the driver task");
        assert!(rx.recv().await.is_none());
        // The panic is the session's typed, terminal end reason (#3479).
        match shared.fatal_error() {
            Some(SessionError::ProtocolError(msg)) => {
                assert!(msg.contains("internal client error"), "{msg}");
                assert!(msg.contains("hostile server"), "{msg}");
            }
            other => panic!("expected a protocol error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn drive_guard_passes_through_a_normal_driver() {
        let shared = test_shared();
        let task = tokio::spawn(drive_guarded(shared.clone(), async {}));
        task.await.expect("normal completion");
        assert!(shared.fatal_error().is_none());
    }

    /// Every server-protocol `VncError` kind maps to a user-facing reason
    /// (#3479); transport-level kinds stay `None` (an ordinary, retryable drop).
    #[test]
    fn protocol_failure_reason_classifies_each_error_kind() {
        let reason = |e: VncError| protocol_failure_reason(&e);
        assert_eq!(
            reason(VncError::UnsupportedEncoding(7)).as_deref(),
            Some("The VNC server sent data termiHub can't handle: unsupported encoding 7")
        );
        assert_eq!(
            reason(VncError::Protocol("rectangle too large".into())).as_deref(),
            Some("The VNC server sent data termiHub can't handle: rectangle too large")
        );
        assert_eq!(
            reason(VncError::WrongPixelFormat).as_deref(),
            Some("The VNC server sent data termiHub can't handle: unsupported pixel format")
        );
        assert_eq!(
            reason(VncError::InvalidImageData).as_deref(),
            Some(
                "The VNC server sent data termiHub can't handle: image data that cannot be decoded"
            )
        );
        assert!(reason(VncError::WrongServerMessage)
            .is_some_and(|r| r.starts_with(PROTOCOL_ERROR_PREFIX)));
        assert!(reason(VncError::Internal("decoder task: boom".into()))
            .is_some_and(|r| r.contains("internal client error") && r.contains("boom")));

        // Transport ends are not protocol failures.
        let io = std::io::Error::from(std::io::ErrorKind::ConnectionReset);
        assert!(reason(VncError::IoError(io)).is_none());
        assert!(reason(VncError::ClientNotRunning).is_none());
        assert!(reason(VncError::ConnectError).is_none());
        assert!(reason(VncError::Tls("bad record".into())).is_none());
        assert!(reason(VncError::General("Channel closed".into())).is_none());
    }

    /// A protocol-error event ends the session and records the typed reason the
    /// supervisor reads on stream close (#3479).
    #[tokio::test]
    async fn protocol_error_event_records_a_typed_fatal_error() {
        let shared = test_shared();
        let (frame_tx, _frame_rx) = mpsc::channel(1);
        let (cursor_tx, _cursor_rx) = mpsc::channel(1);
        let mut frame_tx = ByteBudgetSender::new(frame_tx, 1024);
        let mut cursor_tx = ByteBudgetSender::new(cursor_tx, 1024);
        let mut shadow = FrameShadow::new();
        let event = VncEvent::Error(Arc::new(VncError::UnsupportedEncoding(7)));
        let keep_going =
            handle_event(event, &mut shadow, &shared, &mut frame_tx, &mut cursor_tx).await;
        assert!(!keep_going, "a protocol error ends the session");
        match shared.fatal_error() {
            Some(SessionError::ProtocolError(msg)) => {
                assert!(msg.contains("unsupported encoding 7"), "{msg}");
            }
            other => panic!("expected a protocol error, got {other:?}"),
        }
    }

    /// A transport-error event ends the session without a fatal reason, so the
    /// supervisor treats it as an ordinary drop and may auto-reconnect.
    #[tokio::test]
    async fn transport_error_event_records_no_fatal_error() {
        let shared = test_shared();
        let (frame_tx, _frame_rx) = mpsc::channel(1);
        let (cursor_tx, _cursor_rx) = mpsc::channel(1);
        let mut frame_tx = ByteBudgetSender::new(frame_tx, 1024);
        let mut cursor_tx = ByteBudgetSender::new(cursor_tx, 1024);
        let mut shadow = FrameShadow::new();
        let io = std::io::Error::from(std::io::ErrorKind::ConnectionReset);
        let event = VncEvent::Error(Arc::new(VncError::IoError(io)));
        let keep_going =
            handle_event(event, &mut shadow, &shared, &mut frame_tx, &mut cursor_tx).await;
        assert!(!keep_going);
        assert!(shared.fatal_error().is_none());
    }

    /// Only the first reason is kept; later errors are its consequences.
    #[test]
    fn record_failure_keeps_the_first_reason() {
        let shared = test_shared();
        shared.record_failure("first".into());
        shared.record_failure("second".into());
        assert!(matches!(
            shared.fatal_error(),
            Some(SessionError::ProtocolError(m)) if m == "first"
        ));
    }

    #[test]
    fn disconnected_backend_has_no_fatal_error() {
        assert!(GraphicalBackend::fatal_error(&Vnc::new()).is_none());
    }

    #[test]
    fn jpeg_dirty_rect_decodes_and_blits_into_shadow() {
        let mut shadow = FrameShadow::new();
        shadow.resize(32, 32);
        let dirty = jpeg_dirty_rect(&mut shadow, 4, 8, RED_JPEG_16X16).expect("decoded rect");
        assert_eq!(
            (dirty.x, dirty.y, dirty.width, dirty.height),
            (4, 8, 16, 16)
        );
        assert_eq!(dirty.data.len(), 16 * 16 * 4);
        // The shadow now holds the decoded pixels at the target position.
        let center = shadow.extract(4 + 8, 8 + 8, 1, 1).unwrap();
        assert!(center[0] > 200 && center[1] < 50 && center[2] < 50); // ~red
        assert_eq!(center[3], 255); // opaque
    }

    #[test]
    fn jpeg_dirty_rect_grows_shadow_from_zero() {
        // A JPEG arriving before any resolution event grows the shadow to fit.
        let mut shadow = FrameShadow::new();
        let dirty = jpeg_dirty_rect(&mut shadow, 0, 0, RED_JPEG_16X16).expect("decoded rect");
        assert_eq!((dirty.width, dirty.height), (16, 16));
        assert_eq!(shadow.width(), 16);
        assert_eq!(shadow.height(), 16);
    }

    #[test]
    fn jpeg_dirty_rect_rejects_out_of_bounds() {
        let mut shadow = FrameShadow::new();
        shadow.resize(16, 16);
        // A 16×16 rect at (8,8) exceeds the 16×16 shadow → dropped, no panic.
        assert!(jpeg_dirty_rect(&mut shadow, 8, 8, RED_JPEG_16X16).is_none());
    }

    #[test]
    fn jpeg_dirty_rect_rejects_garbage() {
        let mut shadow = FrameShadow::new();
        shadow.resize(16, 16);
        assert!(jpeg_dirty_rect(&mut shadow, 0, 0, &[0xff, 0x00, 0x13, 0x37]).is_none());
    }

    #[test]
    fn no_cursor_encoding_when_disabled() {
        let cfg = VncConfig {
            show_remote_cursor: false,
            ..Default::default()
        };
        assert!(!encodings_for(&cfg).contains(&VncEncoding::CursorPseudo));
    }

    #[tokio::test]
    async fn connect_requires_host() {
        let mut v = Vnc::new();
        let err = v.connect(serde_json::json!({})).await.unwrap_err();
        assert!(matches!(err, SessionError::InvalidConfig(_)));
    }

    /// A pre-cancelled token aborts the connect before any transport / TLS / RFB
    /// I/O (the config names a would-be-real host) and surfaces the shared
    /// cancellation error, leaving the backend disconnected (PARITY-007).
    #[tokio::test]
    async fn connect_cancellable_precancelled_aborts_before_connecting() {
        let mut v = Vnc::new();
        let token = CancellationToken::new();
        token.cancel();
        let result = v
            .connect_cancellable(
                serde_json::json!({ "host": "vnc.example.com", "port": 5900 }),
                Some(token),
            )
            .await;
        assert!(
            matches!(&result, Err(SessionError::SpawnFailed(m)) if m.contains("cancelled")),
            "expected cancellation error, got {result:?}"
        );
        assert!(!v.is_connected());
    }

    /// With no token the cancellable path behaves exactly as `connect`: a
    /// missing host fails the same way.
    #[tokio::test]
    async fn connect_cancellable_none_matches_connect() {
        let plain = Vnc::new().connect(serde_json::json!({})).await;
        let cancellable = Vnc::new()
            .connect_cancellable(serde_json::json!({}), None)
            .await;
        assert!(matches!(plain, Err(SessionError::InvalidConfig(_))));
        assert!(matches!(cancellable, Err(SessionError::InvalidConfig(_))));
    }

    #[tokio::test]
    async fn graphical_methods_error_when_disconnected() {
        let v = Vnc::new();
        assert!(v
            .send_input(InputEvent::Key {
                code: "KeyA".to_string(),
                pressed: true
            })
            .await
            .is_err());
        assert!(v.get_clipboard().await.is_none());
        assert!(v.set_clipboard("x".to_string()).await.is_err());
    }

    #[test]
    fn graphical_capabilities_advertise_password_and_clipboard() {
        let caps = Vnc::new().graphical_capabilities();
        assert!(caps.auth_kinds.contains(&AuthKind::Password));
        assert!(caps.auth_kinds.contains(&AuthKind::None));
        // VeNCrypt Plain (#1714) surfaces as username+password.
        assert!(caps.auth_kinds.contains(&AuthKind::UsernamePassword));
        assert!(caps.supports_clipboard);
        assert!(!caps.supports_clipboard_image);
        assert!(caps.view_only_capable);
        assert!(!caps.supports_dynamic_resize);
    }

    // --- VeNCrypt config resolution (#1714) ---

    #[tokio::test]
    async fn vencrypt_config_defaults_to_system_roots() {
        let cfg = VncConfig {
            host: "vnc.example.com".to_string(),
            username: "bob".to_string(),
            ..VncConfig::default()
        };
        let ve = build_vencrypt_config(&cfg).await.unwrap();
        assert_eq!(ve.username, "bob");
        assert_eq!(ve.server_name, "vnc.example.com");
    }

    #[tokio::test]
    async fn vencrypt_config_insecure_ok() {
        let cfg = VncConfig {
            tls_verify: "insecure".to_string(),
            ..VncConfig::default()
        };
        assert!(build_vencrypt_config(&cfg).await.is_ok());
    }

    #[tokio::test]
    async fn vencrypt_config_ca_without_path_errors() {
        let cfg = VncConfig {
            tls_verify: "ca".to_string(),
            tls_ca_path: None,
            ..VncConfig::default()
        };
        let err = build_vencrypt_config(&cfg).await.unwrap_err();
        assert!(matches!(err, SessionError::InvalidConfig(_)));
    }

    #[tokio::test]
    async fn vencrypt_config_ca_missing_file_errors() {
        let cfg = VncConfig {
            tls_verify: "ca".to_string(),
            tls_ca_path: Some("/nonexistent/path/to/ca.pem".to_string()),
            ..VncConfig::default()
        };
        let err = build_vencrypt_config(&cfg).await.unwrap_err();
        assert!(matches!(err, SessionError::InvalidConfig(_)));
    }
}
